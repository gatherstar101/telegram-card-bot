import { Failure } from '../../auto-register/api/errors.js';
import { digest } from '../../auto-register/api/auth.js';
import { createStore } from './store.js';
import { createAuthRuntime } from './auth-runtime.js';
import { createAuthCache } from './auth-state.js';
import { ensureSchema } from './schema.js';
import { credentials,requireAdmin,integer,rate,audit } from './security.js';
import { json,failure,bodyOf } from './http.js';
export { AuthState } from './auth-state.js';
export { TelegramAccount } from './telegram-account.js';
export { WebhookDelivery } from './webhook-delivery.js';

async function handle(request,env) {
  const url=new URL(request.url);const path=url.pathname;const method=request.method;
  if(path==='/health'&&method==='GET')return json({ok:true});
  if(path==='/ready'&&method==='GET') {
    try {
      credentials(env);
      if(!env.MAIL_API_KEY||!env.MAIL_FROM||!env.AUTH_HMAC_SECRET||env.AUTH_HMAC_SECRET.length<32||!env.TELEGRAM_ACCOUNTS||!env.WEBHOOK_DELIVERIES)throw new Error('Configuration incomplete');
      await ensureSchema(env.DB);const store=createStore(env.DB,env);createAuthRuntime(store,env);
      await env.DB.prepare('SELECT 1 AS ok').first();
      await createAuthCache(env).get(`${env.AUTH_STATE_PREFIX||'telegram-bot:'}readiness`);
      return json({ok:true});
    } catch {audit('readiness_failed',{kind:'dependency_or_configuration'});return json({ok:false},503);}
  }
  const cache=createAuthCache(env);
  const webhook=path.match(/^\/webhooks\/(\d+)$/);
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  await rate(cache,env,webhook?'webhook-ingress':'ingress',ip,integer(env,webhook?'WEBHOOK_IP_PER_MINUTE':'API_IP_PER_MINUTE',webhook?1200:120,1,10000));
  if(method==='POST'&&['/auth/register/start','/auth/login/start','/v1/login/start'].includes(path))await rate(cache,env,'code-ip-second',ip,integer(env,'OTP_IP_QPS',1,1,100),1);
  await ensureSchema(env.DB);
  const store=createStore(env.DB,env);
  if(path.startsWith('/admin/')) {
    requireAdmin(request,env);
    if(path==='/admin/credentials/rewrap'&&method==='POST') {
      const body=await bodyOf(request);
      const result=await store.rewrap(body.table,body.cursor??'',body.limit??50);
      audit('credentials_rewrapped',{table:body.table,changed:result.changed});return json(result);
    }
    const match=path.match(/^\/admin\/users\/([a-f0-9-]{36})\/disabled$/);
    if(match&&method==='PUT') {
      const body=await bodyOf(request);
      if(typeof body.disabled!=='boolean')throw new Failure(400,'disabled 必须为布尔值');
      await store.disableUser(match[1],body.disabled);
      audit('user_disabled_changed',{user_id:match[1],disabled:body.disabled});return json({ok:true});
    }
    throw new Failure(404,'接口不存在');
  }
  if(webhook) {
    if(method!=='POST')throw new Failure(405,'Webhook 仅支持 POST');
    const update=await bodyOf(request);
    const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX||'telegram-bot:'}${webhook[1]}`));
    return actor.fetch('https://internal/delivery',{method:'POST',body:JSON.stringify({action:'receive',bot_id:webhook[1],secret:request.headers.get('X-Telegram-Bot-Api-Secret-Token'),update})});
  }
  const auth=createAuthRuntime(store,env);
  if(path.startsWith('/auth/')) {
    const result=await auth.route(method,path,await bodyOf(request),request.headers.get('Authorization'),ip);
    audit('auth_request',{action:['/auth/register/start','/auth/register/verify','/auth/login/start','/auth/login/verify','/auth/logout','/auth/logout-all','/auth/password','/auth/me'].includes(path)?path:'/auth/unknown',status:'succeeded'});
    return json(result);
  }
  const {user}=await auth.authenticate(request.headers.get('Authorization'));
  await rate(cache,env,'user',user.id,integer(env,'API_USER_PER_MINUTE',60,1,10000));
  if(path==='/v1/accounts'&&method==='GET') {
    const after=url.searchParams.get('after')||'';
    if(after&&!/^[a-f0-9-]{36}$/.test(after))throw new Failure(400,'after 无效');
    const accounts=await store.accountsForUser(user.id,after);
    return json({accounts,next_cursor:accounts.length===100?accounts.at(-1).account_id:null});
  }
  const body=await bodyOf(request);
  let phone;
  if(path==='/v1/login/start'&&method==='POST') {
    phone=typeof(body.phone??env.TG_PHONE)==='string'?(body.phone??env.TG_PHONE).trim():'';
    if(!/^\+\d{7,15}$/.test(phone))throw new Failure(400,'手机号必须包含国际区号，不含空格');
    if(await store.accountCount(user.id)>=integer(env,'MAX_TG_ACCOUNTS_PER_USER',5,1,100))throw new Failure(429,'Telegram 账号数量达到配额');
    await rate(cache,env,'telegram-login-user',user.id,integer(env,'TG_LOGIN_PER_TEN_MINUTES',5,1,20),600);
    await rate(cache,env,'telegram-login-phone',phone,1,60);
    const lockKey=`${env.AUTH_STATE_PREFIX||'telegram-bot:'}account-create:${user.id}`;const lease=crypto.randomUUID();
    if(!await cache.set(lockKey,lease,{NX:true,EX:600}))throw new Failure(409,'已有 Telegram 登录请求正在处理');
    try {
      if(await store.accountCount(user.id)>=integer(env,'MAX_TG_ACCOUNTS_PER_USER',5,1,100))throw new Failure(429,'Telegram 账号数量达到配额');
      const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX||'telegram-bot:'}${digest(phone)}`));
      return await actor.fetch('https://internal/operation',{method:'POST',body:JSON.stringify({method,path,body,user_id:user.id,auth_version:user.auth_version||0})});
    } finally {await cache.release(lockKey,lease);}

  } else {
    const match=path.match(/^\/v1\/accounts\/([a-f0-9-]{36})(?:\/.*)?$/);
    if(!match)throw new Failure(404,'接口不存在');
    await auth.requireAccount(user.id,match[1]);
    const state=await store.getAccount(match[1]);phone=state.phone;
    if(method==='POST'&&path.endsWith('/verify'))await rate(cache,env,'telegram-verify',match[1],5,600);
    if(method==='POST'&& /\/(bots|channels)$/.test(path))await rate(cache,env,'telegram-create-user',user.id,integer(env,'TG_CREATE_PER_TEN_MINUTES',10,1,100),600);
    const delivery=path.match(/^\/v1\/accounts\/([a-f0-9-]{36})\/bots\/([A-Za-z0-9_]+)\/deliveries\/(\d+)(?:\/(retry))?$/);
    if(delivery) {
      if(!(method==='GET'&&!delivery[4]||method==='POST'&&delivery[4]==='retry'))throw new Failure(404,'接口不存在');
      const bot=await store.get(delivery[1],delivery[2]);
      if(!bot)throw new Failure(404,'Bot 不存在');
      const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX||'telegram-bot:'}${bot.token.split(':')[0]}`));
      return actor.fetch('https://internal/delivery',{method:'POST',body:JSON.stringify({action:delivery[4]?'retry':'get',user_id:user.id,auth_version:user.auth_version||0,account_id:delivery[1],username:delivery[2],update_id:Number(delivery[3]),allow_duplicate:body.allow_duplicate})});
    }
  }
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX||'telegram-bot:'}${digest(phone)}`));
  const result=await actor.fetch('https://internal/operation',{method:'POST',body:JSON.stringify({method,path,body,user_id:user.id,auth_version:user.auth_version||0})});
  audit('account_operation',{user_id:user.id,method,status:result.status});
  return result;
}
export default {
  async fetch(request,env) {
    const requestId=crypto.randomUUID();const start=Date.now();let response;
    try {response=await handle(request,env);}
    catch(error) {
      audit('request_error',{request_id:requestId,status:error.status||500,kind:error.status?'expected':'internal'});
      response=failure(error);
    }
    const result=new Response(response.body,response);
    result.headers.set('X-Request-ID',requestId);result.headers.set('Cache-Control','no-store');
    audit('request_completed',{request_id:requestId,method:request.method,status:result.status,duration_ms:Date.now()-start});
    return result;
  },
};
