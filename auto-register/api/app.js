import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { digest } from './auth.js';
import { Failure } from './errors.js';
import { integer,validateConfig,rate,requireAdmin,audit } from './security.js';
import { isTask } from './jobs.js';
import { withLease } from './queue-store.js';

export function clientIP(req,env){
  const hops=integer(env,'TRUST_PROXY_HOPS',0,0,10);const direct=req.socket.remoteAddress||'unknown';
  if(!hops)return direct;
  const forwarded=req.headers['x-forwarded-for'];if(typeof forwarded!=='string')return direct;
  const chain=forwarded.split(',').map(v=>v.trim());if(chain.some(v=>!isIP(v))||chain.length<hops)return direct;
  return chain.at(-hops);
}
async function bodyOf(req){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw new Failure(413,'请求体过大');chunks.push(chunk);}let body;try{body=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw new Failure(400,'JSON 格式错误');}if(!body||typeof body!=='object'||Array.isArray(body))throw new Failure(400,'请求体必须为 JSON 对象');return body;}
export function createApplication({store,auth,service,jobs,deliveries,env=process.env}){
  return async(req,res)=>{
    const start=Date.now();const requestId=randomUUID();res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Request-ID',requestId);
    const respond=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    try{
      const url=new URL(req.url,'http://localhost');const path=url.pathname;const method=req.method;
      if(method==='GET'&&path==='/health')return respond(200,{ok:true});
      if(method==='GET'&&path==='/ready'){try{validateConfig(env);if(!env.SMTP_HOST||!env.SMTP_FROM)throw new Error();await Promise.all([store.ready(),auth.ready()]);return respond(200,{ok:true});}catch{return respond(503,{ok:false});}}
      const webhook=path.match(/^\/webhooks\/(\d+)$/);const ip=clientIP(req,env);
      await rate(auth.cache,env,webhook?'webhook-ingress':'ingress',ip,integer(env,webhook?'WEBHOOK_IP_PER_MINUTE':'API_IP_PER_MINUTE',webhook?1200:120,1,10000));
      if(method==='POST'&&['/auth/register/start','/auth/login/start','/v1/login/start'].includes(path))await rate(auth.cache,env,'code-ip-second',ip,integer(env,'OTP_IP_QPS',1,1,100),1);
      const body=await bodyOf(req);
      if(path.startsWith('/admin/')){
        requireAdmin({headers:new Headers({Authorization:req.headers.authorization||''})},env);
        if(method==='POST'&&path==='/admin/credentials/rewrap'){const result=await store.rewrap(body.table,body.cursor??'',body.limit??50);audit('credentials_rewrapped',{table:body.table,changed:result.changed});return respond(200,result);}
        const match=path.match(/^\/admin\/users\/([a-f0-9-]{36})\/disabled$/);if(method==='PUT'&&match){if(typeof body.disabled!=='boolean')throw new Failure(400,'disabled 必须为布尔值');await store.disableUser(match[1],body.disabled);audit('user_disabled_changed',{user_id:match[1],disabled:body.disabled});return respond(200,{ok:true});}throw new Failure(404,'接口不存在');
      }
      if(webhook){if(method!=='POST')throw new Failure(405,'Webhook 仅支持 POST');return respond(200,await deliveries.receive(webhook[1],req.headers['x-telegram-bot-api-secret-token'],body));}
      if(path.startsWith('/auth/'))return respond(200,await auth.route(method,path,body,req.headers.authorization,ip));
      const {user}=await auth.authenticate(req.headers.authorization);await rate(auth.cache,env,'user',user.id,integer(env,'API_USER_PER_MINUTE',60,1,10000));
      if(method==='GET'&&path==='/v1/accounts'){const after=url.searchParams.get('after')||'';if(after&&!/^[a-f0-9-]{36}$/.test(after))throw new Failure(400,'after 无效');const accounts=await store.accountsForUser(user.id,after);return respond(200,{accounts,next_cursor:accounts.length===100?accounts.at(-1).account_id:null});}
      if(method==='POST'&&path==='/v1/login/start'){
        const phone=typeof(body.phone??env.TG_PHONE)==='string'?(body.phone??env.TG_PHONE).trim():'';if(!/^\+\d{7,15}$/.test(phone))throw new Failure(400,'手机号必须包含国际区号，不含空格');
        await rate(auth.cache,env,'telegram-login-user',user.id,integer(env,'TG_LOGIN_PER_TEN_MINUTES',5,1,20),600);await rate(auth.cache,env,'telegram-login-phone',phone,1,60);
        const result=await withLease(auth.cache,`${env.REDIS_KEY_PREFIX||'telegram-bot:'}account-create:${user.id}`,async()=>{if(await store.accountCount(user.id)>=integer(env,'MAX_TG_ACCOUNTS_PER_USER',5,1,100))throw new Failure(429,'Telegram 账号数量达到配额');return service.route(method,path,body,user);});if(result.busy)throw new Failure(409,'用户已有登录请求');return respond(200,result.value);
      }
      const accountMatch=path.match(/^\/v1\/accounts\/([a-f0-9-]{36})(?:\/.*)?$/);if(!accountMatch)throw new Failure(404,'接口不存在');const account=accountMatch[1];await auth.requireAccount(user.id,account);
      if(method==='POST'&&path.endsWith('/verify'))await rate(auth.cache,env,'telegram-verify',account,5,600);
      if(method==='POST'&&/\/(bots|channels)$/.test(path))await rate(auth.cache,env,'telegram-create',user.id,integer(env,'TG_CREATE_PER_TEN_MINUTES',10,1,100),600);
      const jobMatch=path.match(/\/jobs\/([a-f0-9]{64})(?:\/(retry))?$/);if(jobMatch){if(method==='GET'&&!jobMatch[2])return respond(200,jobs.view(await jobs.get(jobMatch[1],user,account)));if(method==='POST'&&jobMatch[2])return respond(202,await jobs.retry(jobMatch[1],user,account));throw new Failure(404,'接口不存在');}
      if(method==='POST'&&isTask(path))return respond(202,await jobs.enqueue(path,body,user,account));
      const deliveryMatch=path.match(/\/bots\/([A-Za-z0-9_]+)\/deliveries\/(\d+)(?:\/(retry))?$/);if(deliveryMatch){const row=await deliveries.owned(user,account,deliveryMatch[1],deliveryMatch[2]);if(method==='GET'&&!deliveryMatch[3])return respond(200,deliveries.view(row));if(method==='POST'&&deliveryMatch[3])return respond(200,await deliveries.retry(row,body.allow_duplicate));throw new Failure(404,'接口不存在');}
      return respond(200,await service.route(method,path,body,user));
    }catch(error){const status=error.status||(error.errorMessage?.startsWith('FLOOD_WAIT')?429:error.errorMessage?422:500);if(status===429&&error.retry_after)res.setHeader('Retry-After',String(Math.max(1,Math.ceil(error.retry_after))));respond(status,{error:error.status?error.message:error.errorMessage||'服务内部错误',...(error.retry_after?{retry_after:error.retry_after}:{})});}
    finally{audit('request_completed',{request_id:requestId,status:res.statusCode,duration_ms:Date.now()-start});}
  };
}
