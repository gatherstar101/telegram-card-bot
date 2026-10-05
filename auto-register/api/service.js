import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api } from 'teleproto';
import { computeCheck } from 'teleproto/Password.js';
import { Failure } from './errors.js';
import { createConversion,botApi } from './conversion.js';
import { jobContext } from './jobs.js';
import { workflowContext } from './execution-context.js';

export function createService({ store, auth, connected: connect, env = process.env, checkpoint = async () => {}, fetcher = fetch }) {
async function connected(state,operation) {
  const workflow=workflowContext.getStore();const epoch=store.assertBusiness?await store.assertBusiness(state.user_id,workflow?.business_epoch):undefined;
  return connect(state,client=>operation(new Proxy(client,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return async(...args)=>{const job=jobContext.getStore();const task=job&&store.assertTask?await store.assertTask(job.id,state.user_id):null;if(store.assertBusiness)await store.assertBusiness(state.user_id,task?.business_epoch??epoch);return store.dispatch?store.dispatch(state.user_id,task?.business_epoch??epoch,'telegram_operation',()=>value.apply(target,args),task?.project_id||workflow?.project_id,task?.project_epoch??workflow?.project_epoch):value.apply(target,args);};}})));
}
const busy = new Set();
function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Failure(400, `缺少 ${name}`);
  return value.trim();
}
async function load(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Failure(400, '无效 account_id');
  const state = await store.getAccount(id);
  if (!state) throw new Failure(404, '账号不存在');
  return state;
}
async function save(id, state) { await store.saveAccount(id, state); }
async function exchange(client, peer, text) {
  const sent = await client.sendMessage(peer, { message: text });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(peer, { minId: sent.id, limit: 10 });
    const reply = [...messages].filter(m => !m.out && m.id > sent.id).sort((a,b) => a.id-b.id)[0];
    if (reply) return reply.message || '';
    await sleep(1000);
  }
  throw new Failure(504, 'BotFather 回复超时；请先检查对话，再重试创建');
}
const conversion = createConversion({ store, connected, save, env, checkpoint, fetcher });
async function route(method, path, body, user) {
  const epoch=store.assertBusiness?await store.assertBusiness(user.id,workflowContext.getStore()?.business_epoch):undefined;
  const remoteBot=async(token,method,payload)=>{
    const task=jobContext.getStore()&&store.assertTask?await store.assertTask(jobContext.getStore().id,user.id):null;
    const workflow=workflowContext.getStore();const action=()=>botApi(token,method,payload,fetcher);
    return store.dispatch?store.dispatch(user.id,task?.business_epoch??epoch,'bot_api',action,task?.project_id||workflow?.project_id,task?.project_epoch??workflow?.project_epoch):action();
  };
  if(jobContext.getStore()&&store.assertTask)await store.assertTask(jobContext.getStore().id,user.id);
  if (method === 'GET' && path === '/v1/accounts') return { accounts: await store.accountsForUser(user.id) };
  if (method === 'POST' && path === '/v1/login/start') {
    const phone = requireValue(body.phone ?? env.TG_PHONE, 'phone');
    const app=body.app_config_id&&store.telegramApp?await store.telegramApp(user.id,body.app_config_id):null;
    const api_id = Number(app?.api_id ?? body.api_id);
    const api_hash = requireValue(app?.api_hash ?? body.api_hash, 'api_hash');
    if (!Number.isSafeInteger(api_id) || api_id <= 0 || !/^[a-f0-9]{32}$/i.test(api_hash) || !/^\+\d{7,15}$/.test(phone)) throw new Failure(400, 'App 凭据或手机号格式错误');
    // Serialize by phone even when callers start separate login attempts.
    if (busy.has(phone)) throw new Failure(409, '该手机号正在操作');
    busy.add(phone);
    let release;
    try {
      release = await auth.lockPhone(phone);
      const id = store.claimPhone?await store.claimPhone(user.id,phone,randomUUID()):randomUUID();
      const previous=await store.getAccount(id);
      if(previous?.status==='authorized'&&body.reauthenticate!==true)return {account_id:id,status:'authorized',delivery:null};
      if(previous?.status==='identity_pending'&&body.reauthenticate!==true)return {account_id:id,status:'identity_pending',delivery:null,next_action:'retry_verify'};
      const state = { user_id: user.id, api_id, api_hash, phone, status: 'code_required' };
      const delivery = await connected(state, async client => {
        const result = await client.sendCode({ apiId: api_id, apiHash: api_hash }, phone);
        if (result.emailRequired || result.emailCodeSent) throw new Failure(422, '此账号需要额外邮箱验证，当前接口不支持');
        state.phone_code_hash = result.phoneCodeHash;
        return result.isCodeViaApp ? 'telegram_app' : 'other';
      });
      state.expires_at = Date.now() + 10 * 60 * 1000;
      await save(id, state);
      if(app)await store.pool.execute('INSERT INTO account_profiles(account_id,app_config_id,app_version,updated_at) VALUES(?,?,?,?)'+(store.type==='postgresql'?' ON CONFLICT(account_id) DO UPDATE SET app_config_id=EXCLUDED.app_config_id,app_version=EXCLUDED.app_version,updated_at=EXCLUDED.updated_at':' ON DUPLICATE KEY UPDATE app_config_id=VALUES(app_config_id),app_version=VALUES(app_version),updated_at=VALUES(updated_at)'),[id,app.id,app.version,Date.now()]);
      return { account_id: id, status: state.status, delivery };
    } finally { busy.delete(phone); await release?.(); }
  }
  const match = path.match(/^\/v1\/accounts\/([a-f0-9-]+)(?:\/(.*))?$/);
  if (!match) throw new Failure(404, '接口不存在');
  const [, id, suffix = ''] = match;
  const [action, username] = suffix.split('/');
  await auth.requireAccount(user.id, id);
  const initial = await load(id);
  if (initial.user_id !== user.id) throw new Failure(404, '账号不存在');
  if (busy.has(initial.phone)) throw new Failure(409, '该账号正在操作，请稍后重试');
  busy.add(initial.phone);
  let release,state,snapshot;
  try {
    release = await auth.lockPhone(initial.phone);
    state = await load(id);
    snapshot = JSON.stringify(state);
    if (state.pending_bot) {
      const recovered = await store.get(id, state.pending_bot.username);
      if (!recovered) await store.save(id, state.pending_bot);
      delete state.pending_bot;
      await save(id, state);
    }
    if (state.pending_channel) {
      const pending = state.pending_channel;
      await store.saveChannel(id, pending.request_key, pending);
      delete state.pending_channel;
      await save(id, state);
    }
    const converted = await conversion.route(method, suffix, id, state, body, epoch);
    if (converted !== undefined) return converted;
    if (method === 'GET' && !action) return { account_id: id, status: state.status };
    if (method === 'POST' && suffix === 'logout' && store.updateToken) {
      if(state.status==='revoked')return {account_id:id,status:'revoked'};
      try { await connected(state,client=>client.invoke(new Api.auth.LogOut())); }
      catch(error) {
        if(!['AUTH_KEY_UNREGISTERED','SESSION_REVOKED','SESSION_EXPIRED'].includes(error.errorMessage))throw error;
      }
      state.session='';state.status='revoked';
      delete state.phone_code_hash;delete state.expires_at;delete state.pending_bot;delete state.pending_channel;
      await save(id,state);
      return {account_id:id,status:'revoked'};
    }
    if (method === 'POST' && suffix === 'verify') {
      if(state.status==='revoked')throw new Failure(401,'Telegram 登录已撤销');
      if (state.status === 'authorized') return { account_id: id, status: state.status };
      if(state.status==='identity_conflict')throw new Failure(409,'Telegram 身份绑定冲突，请联系管理员','IDENTITY_CONFLICT','contact_administrator');
      if (state.status!=='identity_pending'&&Date.now() > state.expires_at) throw new Failure(410, '登录流程过期，请重新发送验证码');
      await connected(state, async client => {
        if (state.status === 'code_required') {
          try {
            const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: state.phone, phoneCodeHash: state.phone_code_hash, phoneCode: requireValue(body.code, 'code') }));
            if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new Failure(422, '需要已注册的 Telegram 用户账号');
            state.status = 'identity_pending';
          } catch (e) {
            if (e.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw e;
            state.status = 'password_required';
          }
        }
        if (state.status === 'password_required' && body.password) {
          const settings = await client.invoke(new Api.account.GetPassword());
          await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(settings, requireValue(body.password, 'password')) }));
          state.status = 'identity_pending';
        }
        if (state.status === 'identity_pending') {
          const me=await client.getMe();
          if (me.bot){state.status='identity_conflict';state.session='';throw new Failure(422, '必须使用个人账号');}
          if(store.recordIdentity)try{await store.recordIdentity(user.id,id,me,state.phone);}catch(error){
            if(error.code==='IDENTITY_CONFLICT'){state.status='identity_conflict';state.session='';throw error;}
            if(error instanceof Failure)throw error;
            throw new Failure(503,'身份绑定暂时无法保存，请重试 verify','IDENTITY_PERSISTENCE_FAILED','retry_verify');
          }
          state.status='authorized';
          delete state.phone_code_hash;
          delete state.expires_at;
        }
      });
      await save(id, state);
      return { account_id: id, status: state.status,...(state.status==='password_required'?{next_action:'provide_password'}:{}) };
    }
    if (action==='bots' && method==='PUT' && suffix===`bots/${username}/token` && store.updateToken) {
      const bot=await store.get(id,username);
      if(!bot)throw new Failure(404,'Bot 不存在');
      const token=requireValue(body.token,'token');
      if(!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)||token.split(':')[0]!==bot.token.split(':')[0])throw new Failure(400,'Token 必须属于同一个 Bot');
      const me=await remoteBot(token,'getMe',{});
      if(!me.is_bot||me.username?.toLowerCase()!==username.toLowerCase()||String(me.id)!==token.split(':')[0])throw new Failure(400,'Token 与 Bot 不匹配');
      await store.updateToken(id,username,token);
      return {ok:true,username};
    }
    if(action==='bots' && method==='POST' && suffix===`bots/${username}/reconcile` && store.updateToken) {
      if(state.status!=='authorized')throw new Failure(401,'请先完成 Telegram 登录');
      if(!/^[a-z][a-z0-9_]{4,31}$/i.test(username)||!/bot$/i.test(username))throw new Failure(400,'Bot 用户名无效');
      const existing=await store.get(id,username);
      if(existing)return existing;
      let bot;
      await connected(state,async client=>{
        if(!await client.checkAuthorization())throw new Failure(401,'Telegram 会话已失效');
        const peer=await client.getEntity('BotFather');
        await exchange(client,peer,'/cancel');
        await exchange(client,peer,'/token');
        const reply=await exchange(client,peer,`@${username}`);
        const token=reply.match(/\b\d+:[A-Za-z0-9_-]{30,}\b/)?.[0];
        if(!token)throw new Failure(409,'BotFather 未确认该 Bot 的归属或 Token，请人工核对');
        const me=await remoteBot(token,'getMe',{});
        if(!me.is_bot||me.username?.toLowerCase()!==username.toLowerCase())throw new Failure(409,'BotFather 返回的 Bot 不匹配');
        bot={username:me.username,name:me.first_name,token,url:`https://t.me/${me.username}`};
        state.pending_bot=bot;await save(id,state);await store.save(id,bot);delete state.pending_bot;await save(id,state);
      });
      return bot;
    }
    if (action === 'bots' && method === 'GET' && username && suffix.split('/').length === 2) {
      const bot = await store.get(id, username);
      if (!bot) throw new Failure(404, '未找到本服务保存的 Bot');
      return bot;
    }
    if (method === 'POST' && suffix === 'bots') {
      if (state.status !== 'authorized') throw new Failure(401, '请先完成 Telegram 登录');
      const name = requireValue(body.name ?? env.TG_BOT_NAME, 'name');
      const user = requireValue(body.username ?? env.TG_BOT_USERNAME, 'username');
      if (name.length > 64 || !/^[a-z][a-z0-9_]{4,31}$/i.test(user) || !/bot$/i.test(user)) throw new Failure(400, '机器人名称或用户名格式错误');
      const existing = await store.get(id, user);
      if (existing) return existing;
      let bot;
      await connected(state, async client => {
        if (!await client.checkAuthorization()) throw new Failure(401, 'Telegram 会话已失效，请重新登录');
        const peer = await client.getEntity('BotFather');
        await exchange(client, peer, '/cancel');
        if (!/name/i.test(await exchange(client, peer, '/newbot'))) throw new Failure(422, 'BotFather 未接受创建，请检查对话或账号限制');
        if (!/username/i.test(await exchange(client, peer, name))) throw new Failure(422, 'BotFather 未接受名称，请检查对话');
        await checkpoint('bot_create',{username:user});
        const reply = await exchange(client, peer, user);
        const token = reply.match(/\b\d+:[A-Za-z0-9_-]{30,}\b/)?.[0];
        if (!token) {
          const error=new Failure(422,'BotFather 未返回 Token，请核对用户名或创建限制');
          error.remote_rejected=/already taken|username is invalid|username must end/i.test(reply);
          throw error;
        }
        if(store.updateToken) {
          const me=await remoteBot(token,'getMe',{});
          if(!me.is_bot||me.username?.toLowerCase()!==user.toLowerCase()||String(me.id)!==token.split(':')[0])throw new Failure(409,'BotFather 返回的 Bot 与请求不一致，需要核对');
        }
        bot = { username: user, name, token, url: `https://t.me/${user}` };
        // Persist the remote result before inserting the bot record.
        state.pending_bot = bot;
        await save(id, state);
        await store.save(id, bot);
        delete state.pending_bot;
        await save(id, state);
      });
      return bot;
    }
    throw new Failure(404, '接口不存在');
  } finally {
    try { if(state?.status==='identity_conflict')state.session='';if(state&&JSON.stringify(state)!==snapshot)await save(id,state); }
    finally {busy.delete(initial.phone);await release?.();}
  }
}
return { route, handleWebhook: conversion.handleWebhook };
}
