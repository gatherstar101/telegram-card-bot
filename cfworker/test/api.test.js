import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { env,exports as workerExports } from 'cloudflare:workers';
import { applyD1Migrations,reset,runInDurableObject,evictDurableObject } from 'cloudflare:test';
import { createStore } from '../src/store.js';
import { digest } from '../../auto-register/api/auth.js';
import { createService } from '../../auto-register/api/service.js';
import { botApi } from '../../auto-register/api/conversion.js';
import { createAuthRuntime } from '../src/auth-runtime.js';

let emails;
let telegramCalls;
let logSpy;
let codeIP;
const store = createStore(env.DB,env);
async function call(path,{method='GET',body,token,secret,ip}={}) {
  const response = await workerExports.default.fetch(`https://worker.example.test${path}`,{
    method,headers:{'Content-Type':'application/json','CF-Connecting-IP':ip??(path.endsWith('/start')?`192.0.2.${++codeIP+42}`:'192.0.2.42'),...(token?{Authorization:`Bearer ${token}`} : {}),...(secret?{'X-Telegram-Bot-Api-Secret-Token':secret}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json();
  return {...data,status:response.status,retry_after:Number(response.headers.get('Retry-After')),data};
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  emails=[]; telegramCalls=[];codeIP=0;
  logSpy=vi.spyOn(console,'log').mockImplementation(()=>{});
  vi.spyOn(globalThis,'fetch').mockImplementation(async (url,options) => {
    if (String(url) === env.MAIL_API_URL) {
      emails.push(JSON.parse(options.body));
      return Response.json({id:'test-mail'});
    }
    if (String(url).startsWith('https://api.telegram.org/')) {
      telegramCalls.push({url:String(url),body:JSON.parse(options.body)});
      return Response.json({ok:true,result:true});
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());
const password = 'Long-enough-test-password-42';
const otp = () => emails.at(-1).text.match(/\b\d{6}\b/)[0];
async function register(email='alice@example.test') {
  const started=await call('/auth/register/start',{method:'POST',body:{email,password}});
  expect(started.status).toBe(200);
  return call('/auth/register/verify',{method:'POST',body:{challenge_id:started.challenge_id,code:otp()}});
}
async function fixture() {
  const login=await register();
  const id=crypto.randomUUID();
  await store.saveAccount(id,{user_id:login.user.id,api_id:12345,api_hash:'a'.repeat(32),phone:'+447000000001',session:'',status:'authorized'});
  const bot={name:'Customer bot',username:'customer_test_bot',token:'123456789:'+'a'.repeat(35)};
  await store.save(id,bot);
  return {login,id,bot,base:`/v1/accounts/${id}`};
}

async function finishJob(response,login,id,phone='+447000000001') {
  expect(response.status).toBe(202);
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest(phone)}`));
  await runInDurableObject(actor,async object=>{
    object.ctx.storage.sql.exec('UPDATE jobs SET next_at=? WHERE id=?',Date.now()-1,response.job_id);
    await object.alarm();
  });
  const job=await call(`/v1/accounts/${id}/jobs/${response.job_id}`,{token:login.access_token});
  expect(job.data.status).toBe('succeeded');return job.result;
}
it('registers, persists a password hash, authenticates and revokes a session',async () => {
  const login=await register();
  expect(login.status).toBe(200);
  expect(login.expires_in).toBe(7200);
  expect((await store.userById(login.user.id)).password_hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  expect((await call('/auth/me',{token:login.access_token})).id).toBe(login.user.id);
  expect((await call('/auth/logout',{method:'POST',token:login.access_token})).status).toBe(200);
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(401);
});
it('consumes the same OTP only once under concurrent requests',async () => {
  const start=await call('/auth/register/start',{method:'POST',body:{email:'once@example.test',password}});
  expect(start.expires_in).toBe(600);
  expect(start.code).toBeUndefined();
  const body={challenge_id:start.challenge_id,code:otp()};
  const responses=await Promise.all(Array.from({length:4},()=>call('/auth/register/verify',{method:'POST',body})));
  expect(responses.filter(r=>r.status===200)).toHaveLength(1);
  expect(responses.filter(r=>r.status===401)).toHaveLength(3);
});
it('limits wrong OTP attempts and enforces expiry even before an alarm runs',async () => {
  const start=await call('/auth/register/start',{method:'POST',body:{email:'wrong@example.test',password}});
  const code=otp();
  const wrong=code==='111111'?'222222':'111111';
  for(let i=0;i<5;i++)expect((await call('/auth/register/verify',{method:'POST',body:{challenge_id:start.challenge_id,code:wrong}})).status).toBe(401);
  expect((await call('/auth/register/verify',{method:'POST',body:{challenge_id:start.challenge_id,code}})).status).toBe(401);
  const other=await call('/auth/register/start',{method:'POST',body:{email:'expired@example.test',password}});
  const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}challenge:${other.challenge_id}`));
  await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec('UPDATE entry SET expires_at=?',Date.now()-1));
  expect((await call('/auth/register/verify',{method:'POST',body:{challenge_id:other.challenge_id,code:otp()}})).status).toBe(401);
});
it('retains session state after Durable Object eviction and expires at the configured TTL',async () => {
  const login=await register();
  const stub=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}session:${digest(login.access_token)}`));
  await evictDurableObject(stub);
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(200);
  await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec('UPDATE entry SET expires_at=?',Date.now()-1));
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(401);
});
it('logs in an existing user with password plus email OTP and throttles mail delivery',async () => {
  const user=await register();
  expect((await call('/auth/login/start',{method:'POST',body:{email:user.user.email,password:'Wrong-password-value'}})).status).toBe(401);
  expect((await call('/auth/login/start',{method:'POST',body:{email:user.user.email,password}})).status).toBe(429);
  const cooldown=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}mail-cooldown:${digest(user.user.email)}`));
  await cooldown.del();
  const start=await call('/auth/login/start',{method:'POST',body:{email:user.user.email,password}});
  expect(start.status).toBe(200);
  const login=await call('/auth/login/verify',{method:'POST',body:{challenge_id:start.challenge_id,code:otp()}});
  expect(login.user.id).toBe(user.user.id);
  expect(login.access_token).not.toBe(user.access_token);
});
it('returns 503 for mail failures and leaves no usable registration challenge',async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('unavailable',{status:503}));
  expect((await call('/auth/register/start',{method:'POST',body:{email:'failed@example.test',password}})).status).toBe(503);
  expect(await store.userByEmail('failed@example.test')).toBeNull();
  expect((await call('/auth/register/start',{method:'POST',body:{email:'failed@example.test',password}})).status).toBe(429);
});
it('routes owned accounts to actors and hides other users accounts and bot tokens',async () => {
  const {login,id,bot,base}=await fixture();
  expect((await call('/v1/accounts',{token:login.access_token})).accounts).toHaveLength(1);
  expect((await call(base,{token:login.access_token})).status).toBe(200);
  expect((await call(`${base}/bots/${bot.username}`,{token:login.access_token})).token).toBe(bot.token);
  expect((await finishJob(await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:bot.name,username:bot.username}}),login,id)).token).toBe(bot.token);
  const other=await register('bob@example.test');
  expect((await call(base,{token:other.access_token})).status).toBe(404);
  expect((await call(`${base}/bots/${bot.username}`,{token:other.access_token})).status).toBe(404);
  await expect(store.saveAccount(id,{user_id:other.user.id})).rejects.toThrow('ownership');
  expect((await call(base)).status).toBe(401);
});
it('configures landing, sets a webhook using Worker env and validates webhook secrets',async () => {
  const {login,id,bot,base}=await fixture();
  const landing=await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'customer-a',landing_url:'https://landing.example.test/offer',card_text:'活动介绍'}});
  expect(landing.status).toBe(200);
  expect(landing.webhook_secret).toBeUndefined();
  expect((await call(`${base}/bots/${bot.username}/landing`,{token:login.access_token})).landing_url).toBe('https://landing.example.test/offer');
  const webhook=await call(`${base}/bots/${bot.username}/webhook`,{method:'POST',token:login.access_token,body:{}});
  expect(webhook.webhook_url).toBe('https://bot.example.test/webhooks/123456789');
  const config=await store.getLanding(id,bot.username);
  const body={update_id:1,message:{chat:{id:42,type:'private'},text:'/start customer-a'}};
  expect((await call('/webhooks/123456789',{method:'POST',body})).status).toBe(403);
  expect((await call('/webhooks/123456789',{method:'POST',secret:config.webhook_secret,body})).status).toBe(200);
  const delivery=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX}123456789`));
  await runInDurableObject(delivery,async object=>{object.ctx.storage.sql.exec('UPDATE deliveries SET next_at=?',Date.now()-1);await object.alarm();});
  expect(telegramCalls.at(-1).body.reply_markup.inline_keyboard[0][0].url).toBe(landing.landing_url);
});
it('stores channel identifiers losslessly and posts with atomic reservation',async () => {
  const {login,id,bot,base}=await fixture();
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'customer-a',landing_url:'https://landing.example.test'}});
  await store.reserveChannel(id,{request_key:'channel-a',customer_id:'customer-a',bot_username:bot.username,title:'Channel',about:''});
  await store.saveChannel(id,'channel-a',{channel_id:'9007199254740993',access_hash:'9223372036854775807'});
  await store.channelReady(id,'channel-a','https://t.me/+test-invite');
  const channel=await call(`${base}/channels/channel-a`,{token:login.access_token});
  expect(channel.channel_id).toBe('9007199254740993');
  expect(channel.access_hash).toBeUndefined();
  const post={request_key:'post-a',message_text:'Content',landing_url:'https://landing.example.test/',bot_url:`https://t.me/${bot.username}?start=channel`,random_id:'9007199254740999'};
  const reserved=await Promise.allSettled([store.reservePost(id,'channel-a',post),store.reservePost(id,'channel-a',post)]);
  expect(reserved.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await store.postReady(id,'channel-a','post-a',123);
  const result=await finishJob(await call(`${base}/channels/channel-a/posts`,{method:'POST',token:login.access_token,body:{request_key:'post-a',text:'Content'}}),login,id);
  expect(result.message_id).toBe(123);
  expect(result.random_id).toBe('9007199254740999');
});
it('runs Telegram login, verify, bot and channel flows with a fake remote client inside the account actor',async () => {
  const login=await register();
  const phone='+447000000002';
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest(phone)}`));
  const fake={
    sendCode:async()=>({phoneCodeHash:'test-code-hash',isCodeViaApp:true}),
    invoke:async request=> request.className==='messages.ExportChatInvite'?{link:'https://t.me/+created-invite'}:request.className==='messages.SendMessage'?{id:987}:{},
    getMe:async()=>({bot:false}),checkAuthorization:async()=>true,getEntity:async()=>({}),
    sendMessage:async(_,args)=>{fake.message=args.message;return{id:1};},
    getMessages:async()=>[{id:2,out:false,message:fake.message==='/newbot'?'Choose a name':fake.message==='New Bot'?'Choose a username':fake.message==='new_customer_bot'?'Token 987654321:'+'b'.repeat(35):'Cancelled'}],
    createChannel:async()=>({id:{toString:()=> '9007199254740994'},accessHash:{toString:()=> '9223372036854775806'}}),
  };
  await runInDurableObject(actor,object=>{
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,fetcher:async()=>Response.json({ok:true,result:{id:987654321,is_bot:true,username:'new_customer_bot'}}),checkpoint:effect=>object.jobs.checkpoint(effect),connected:async(state,fn)=>{const result=await fn(fake);state.session='test-persisted-session';return result;}});
  });
  const start=await call('/v1/login/start',{method:'POST',token:login.access_token,body:{phone,api_id:12345,api_hash:'a'.repeat(32)}});
  expect(start.status).toBe(200);
  expect(start.delivery).toBe('telegram_app');
  const base=`/v1/accounts/${start.account_id}`;
  expect((await call(`${base}/verify`,{method:'POST',token:login.access_token,body:{code:'12345'}})).data.status).toBe('authorized');
  expect((await store.getAccount(start.account_id)).session).toBe('test-persisted-session');
  const bot=await finishJob(await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:'New Bot',username:'new_customer_bot'}}),login,start.account_id,phone);
  expect(bot.token).toBe('987654321:'+'b'.repeat(35));
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'new-customer',landing_url:'https://landing.example.test'}});
  const channel=await finishJob(await call(`${base}/channels`,{method:'POST',token:login.access_token,body:{request_key:'new-channel',bot_username:bot.username,title:'New Channel'}}),login,start.account_id,phone);
  expect(channel.invite_url).toBe('https://t.me/+created-invite');
  const post=await finishJob(await call(`${base}/channels/new-channel/posts`,{method:'POST',token:login.access_token,body:{request_key:'new-post',text:'New post'}}),login,start.account_id,phone);
  expect(post.message_id).toBe(987);
});
it('rejects malformed and oversized JSON before account operations',async () => {
  const login=await register();
  expect((await call('/v1/login/start',{method:'POST',token:login.access_token,body:{phone:'invalid'}})).status).toBe(400);
  expect((await call('/auth/register/start',{method:'POST',body:[]})).status).toBe(400);
  expect((await call('/auth/register/start',{method:'POST',body:{payload:'x'.repeat(17000)}})).status).toBe(413);
  expect((await call('/health')).ok).toBe(true);
});
it('prevents simultaneous login attempts from interleaving on the same phone actor',async()=>{
  const login=await register(),phone='+447000000003';
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest(phone)}`));
  await runInDurableObject(actor,object=>{
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async(_,fn)=>fn({sendCode:async()=>{
      await new Promise(resolve=>setTimeout(resolve,50));return {phoneCodeHash:'lock-test-hash'};
    }})});
  });
  const request={method:'POST',token:login.access_token,body:{phone,api_id:12345,api_hash:'a'.repeat(32)}};
  const responses=await Promise.all([call('/v1/login/start',request),call('/v1/login/start',request)]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,429]);
});

it('encrypts credentials, authenticates ciphertext and migrates legacy data with administrator authorization',async()=>{
  const {login,id,bot}=await fixture();
  const raw=await env.DB.prepare('SELECT * FROM tg_info WHERE account_id=?').bind(id).first();
  for(const field of ['api_hash','phone','session'])expect(raw[field]).toMatch(/^enc:test-v1:/);
  expect((await env.DB.prepare('SELECT token FROM bot_info WHERE account_id=?').bind(id).first()).token).not.toContain(bot.token);
  await env.DB.prepare('UPDATE tg_info SET session=api_hash WHERE account_id=?').bind(id).run();
  await expect(store.getAccount(id)).rejects.toThrow('解密失败');
  await env.DB.prepare('UPDATE tg_info SET session=? WHERE account_id=?').bind('old-imported-session',id).run();
  await expect(store.getAccount(id)).rejects.toThrow('旧凭据');
  expect((await call('/admin/credentials/rewrap',{method:'POST',token:login.access_token,body:{table:'tg_info'}})).status).toBe(401);
  expect((await call('/admin/credentials/rewrap',{method:'POST',token:env.ADMIN_API_KEY,body:{table:'tg_info'}})).changed).toBe(1);
  expect((await store.getAccount(id)).session).toBe('old-imported-session');
  const rotated=createStore(env.DB,{...env,CREDENTIAL_KEY_ID:'test-v2',CREDENTIAL_KEYS:JSON.stringify({...JSON.parse(env.CREDENTIAL_KEYS),'test-v2':Buffer.alloc(32,9).toString('base64')})});
  expect((await rotated.rewrap('tg_info')).changed).toBe(1);
  expect((await rotated.rewrap('bot_info')).changed).toBe(1);
  expect((await rotated.get(id,bot.username)).token).toBe(bot.token);
  await expect(store.getAccount(id)).rejects.toThrow('解密失败');
});
it('revokes sessions and pending OTPs, accepts fresh sessions and revokes sessions after password changes',async()=>{
  const {login,id}=await fixture();
  const cooldown=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}mail-cooldown:${digest(login.user.email)}`));
  await cooldown.del();
  const pending=await call('/auth/login/start',{method:'POST',body:{email:login.user.email,password}}),code=otp();
  expect((await call('/auth/logout-all',{method:'POST',token:login.access_token})).status).toBe(200);
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(401);
  expect((await call('/auth/login/verify',{method:'POST',body:{challenge_id:pending.challenge_id,code}})).status).toBe(401);
  await cooldown.del();
  const start=await call('/auth/login/start',{method:'POST',body:{email:login.user.email,password}});
  const next=await call('/auth/login/verify',{method:'POST',body:{challenge_id:start.challenge_id,code:otp()}});
  expect((await call(`/v1/accounts/${id}`,{token:next.access_token})).status).toBe(200);
  expect((await call('/auth/password',{method:'POST',token:next.access_token,body:{current_password:password,new_password:'Changed-long-password-42'}})).status).toBe(200);
  expect((await call('/auth/me',{token:next.access_token})).status).toBe(401);
});
it('disables users and cancels queued work before it can execute',async()=>{
  const {login,id,bot,base}=await fixture();
  const job=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:bot.name,username:bot.username}});
  expect((await call(`/admin/users/${login.user.id}/disabled`,{method:'PUT',token:env.ADMIN_API_KEY,body:{disabled:true}})).status).toBe(200);
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(401);
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await runInDurableObject(actor,async object=>{object.ctx.storage.sql.exec('UPDATE jobs SET next_at=?',Date.now()-1);await object.alarm();expect(object.jobs.row(job.job_id).status).toBe('cancelled');});
  await call(`/admin/users/${login.user.id}/disabled`,{method:'PUT',token:env.ADMIN_API_KEY,body:{disabled:false}});
  expect((await call(`/v1/accounts/${id}`,{token:login.access_token})).status).toBe(401);
});
it('persists idempotent jobs after eviction, encrypts results and applies queue backpressure',async()=>{
  const {login,id,bot,base}=await fixture();const body={name:bot.name,username:bot.username};
  const job=await call(`${base}/bots`,{method:'POST',token:login.access_token,body});
  expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{username:bot.username,name:bot.name}})).job_id).toBe(job.job_id);
  expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{...body,name:'Different'}})).status).toBe(409);
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await evictDurableObject(actor);expect((await finishJob(job,login,id)).token).toBe(bot.token);
  await runInDurableObject(actor,object=>{expect(object.jobs.row(job.job_id).result).not.toContain(bot.token);object.jobs.env={...env,JOB_QUEUE_LIMIT:'2'};});
  for(const request_key of ['queued-1','queued-2'])expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{...body,request_key}})).status).toBe(202);
  expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{...body,request_key:'queued-3'}})).status).toBe(429);
  const other=await register('jobs-other@example.test');expect((await call(`${base}/jobs/${job.job_id}`,{token:other.access_token})).status).toBe(404);
});
async function channelFixture(mode) {
  const f=await fixture();const {login,id,bot,base}=f;
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'a',landing_url:'https://landing.example.test'}});
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  const remote={creates:0,creator:false};
  await runInDurableObject(actor,object=>{
    const fake={checkAuthorization:async()=>true,createChannel:async()=>{
      remote.creates++;
      if(mode==='ambiguous')throw new Error('connection lost after remote creation');
      if(remote.creates===1)throw Object.assign(new Error('rejected'),{errorMessage:'CHANNELS_TOO_MUCH'});
      return {id:{toString:()=> '123456'},accessHash:{toString:()=> '654321'}};
    },invoke:async request=>request.className==='channels.GetChannels'?{chats:[{id:{toString:()=> '123456'},title:'Channel',creator:remote.creator,megagroup:false}]}:{link:'https://t.me/+recovered'}};
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,checkpoint:effect=>object.jobs.checkpoint(effect),connected:async(_,fn)=>fn(fake)});
  });
  const run=async()=>runInDurableObject(actor,async object=>{object.ctx.storage.sql.exec('UPDATE jobs SET next_at=?',Date.now()-1);await object.alarm();});
  const job=await call(`${base}/channels`,{method:'POST',token:login.access_token,body:{request_key:'channel',title:'Channel',bot_username:bot.username}});
  await run();return {...f,job,run,remote};
}
it('cleans up definite channel rejection and retries without leaving a stuck reservation',async()=>{
  const {login,id,base,job,remote}=await channelFixture('rejected');
  expect((await call(`${base}/jobs/${job.job_id}`,{token:login.access_token})).data.status).toBe('failed');
  expect(await store.getChannel(id,'channel')).toBeNull();
  const retried=await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}});
  expect((await finishJob(retried,login,id)).invite_url).toBe('https://t.me/+recovered');expect(remote.creates).toBe(2);
});
it('holds uncertain channel results and verifies remote ownership before reconciliation',async()=>{
  const {login,id,base,job,run,remote}=await channelFixture('ambiguous');
  expect((await call(`${base}/jobs/${job.job_id}`,{token:login.access_token})).data.status).toBe('uncertain');
  expect((await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}})).status).toBe(409);
  const recovery=await call(`${base}/channels/channel/reconcile`,{method:'POST',token:login.access_token,body:{request_key:'recover',channel_id:'123456',access_hash:'654321'}});
  await run();expect((await call(`${base}/jobs/${recovery.job_id}`,{token:login.access_token})).error.status).toBe(403);
  remote.creator=true;
  await finishJob(await call(`${base}/jobs/${recovery.job_id}/retry`,{method:'POST',token:login.access_token,body:{}}),login,id);
  expect((await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}})).data.status).toBe('succeeded');expect(remote.creates).toBe(1);
});
it('deduplicates webhook deliveries across eviction and retries explicit 429 responses',async()=>{
  const {login,id,bot,base}=await fixture();
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'a',landing_url:'https://landing.example.test'}});
  const secret=(await store.getLanding(id,bot.username)).webhook_secret,body={update_id:200,message:{chat:{id:42,type:'private'},text:'/start'}};
  const responses=await Promise.all(Array.from({length:5},()=>call('/webhooks/123456789',{method:'POST',secret,body})));expect(responses.every(r=>r.status===200)).toBe(true);
  const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX}123456789`));await evictDurableObject(actor);
  const run=()=>runInDurableObject(actor,async object=>{object.ctx.storage.sql.exec('UPDATE deliveries SET next_at=?',Date.now()-1);await object.alarm();});
  await runInDurableObject(actor,object=>{
    object.send=(token,method,payload)=>botApi(token,method,payload,async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:3}},{status:429}));
  });
  await run();
  expect((await call(`${base}/bots/${bot.username}/deliveries/200`,{token:login.access_token})).data.status).toBe('queued');
  await runInDurableObject(actor,object=>{object.send=async(token,method,body)=>{telegramCalls.push({url:`https://api.telegram.org/bot${token}/${method}`,body});return true;};});
  await run();expect(telegramCalls.filter(c=>c.url.endsWith('/sendMessage'))).toHaveLength(1);
  await call('/webhooks/123456789',{method:'POST',secret,body});await run();expect(telegramCalls.filter(c=>c.url.endsWith('/sendMessage'))).toHaveLength(1);
});
it('requires explicit consent to retry an ambiguous webhook instead of automatically duplicating messages',async()=>{
  const {login,id,bot,base}=await fixture();
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'a',landing_url:'https://landing.example.test'}});
  const secret=(await store.getLanding(id,bot.username)).webhook_secret,body={update_id:201,message:{chat:{id:42,type:'private'},text:'/start'}};
  await call('/webhooks/123456789',{method:'POST',secret,body});
  const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX}123456789`));
  await runInDurableObject(actor,object=>{object.send=async()=>{throw new Error('response lost after message accepted');};});
  await runInDurableObject(actor,async object=>{object.ctx.storage.sql.exec('UPDATE deliveries SET next_at=?',Date.now()-1);await object.alarm();expect(object.row(201).status).toBe('uncertain');});
  await call('/webhooks/123456789',{method:'POST',secret,body});await runInDurableObject(actor,object=>object.alarm());expect(telegramCalls.filter(c=>c.url.endsWith('/sendMessage'))).toHaveLength(0);
  const path=`${base}/bots/${bot.username}/deliveries/201/retry`;
  expect((await call(path,{method:'POST',token:login.access_token,body:{}})).status).toBe(409);
  expect((await call(path,{method:'POST',token:login.access_token,body:{allow_duplicate:true}})).status).toBe(200);
});
it('limits Telegram verification attempts and redacts credentials from request logs',async()=>{
  const {login,bot,base}=await fixture();
  for(let i=0;i<5;i++)expect((await call(`${base}/verify`,{method:'POST',token:login.access_token,body:{code:'12345'}})).status).toBe(200);
  expect((await call(`${base}/verify`,{method:'POST',token:login.access_token,body:{code:'12345'}})).status).toBe(429);
  const logs=logSpy.mock.calls.flat().join('\n');
  for(const sensitive of [password,login.access_token,bot.token,'+447000000001',env.ADMIN_API_KEY,env.CREDENTIAL_KEYS])expect(logs).not.toContain(sensitive);
  expect((await call('/ready')).status).toBe(200);
});
it('enforces shared OTP IP QPS and a sixty-second cooldown across email purposes',async()=>{
  const ip='192.0.2.200';
  const start=await call('/auth/register/start',{method:'POST',ip,body:{email:'qps-a@example.test',password}});expect(start.status).toBe(200);
  const blocked=await call('/auth/register/start',{method:'POST',ip,body:{email:'qps-b@example.test',password}});expect(blocked.status).toBe(429);expect(blocked.retry_after).toBe(1);expect(emails).toHaveLength(1);
  const again=await call('/auth/register/start',{method:'POST',ip:'192.0.2.201',body:{email:'qps-a@example.test',password}});expect(again.status).toBe(429);expect(again.retry_after).toBeGreaterThanOrEqual(59);
  const login=await call('/auth/register/verify',{method:'POST',body:{challenge_id:start.challenge_id,code:otp()}});
  expect((await call('/auth/login/start',{method:'POST',body:{email:login.user.email,password}})).status).toBe(429);
  const cooldown=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}mail-cooldown:${digest(login.user.email)}`));
  await runInDurableObject(cooldown,(_,ctx)=>ctx.storage.sql.exec('UPDATE entry SET expires_at=?',Date.now()-1));
  expect((await call('/auth/login/start',{method:'POST',body:{email:login.user.email,password}})).status).toBe(200);
});
it('holds a shared sixty-second Telegram phone cooldown even across different source IPs',async()=>{
  const login=await register(),phone='+447000000020';let sends=0;
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest(phone)}`));
  await runInDurableObject(actor,object=>{object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async(_,fn)=>fn({sendCode:async()=>{sends++;return {phoneCodeHash:'cooldown-hash'};}})});});
  const request={method:'POST',token:login.access_token,body:{phone,api_id:12345,api_hash:'a'.repeat(32)}};
  expect((await call('/v1/login/start',request)).status).toBe(200);
  const blocked=await call('/v1/login/start',request);expect(blocked.status).toBe(429);expect(blocked.retry_after).toBeGreaterThanOrEqual(59);expect(sends).toBe(1);
  const cooldown=env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`${env.AUTH_STATE_PREFIX}limit:telegram-login-phone:${digest(phone)}`));
  await runInDurableObject(cooldown,(_,ctx)=>ctx.storage.sql.exec('UPDATE entry SET expires_at=?',Date.now()-1));
  expect((await call('/v1/login/start',request)).status).toBe(200);expect(sends).toBe(2);
});
it('recovers interrupted jobs after eviction without repeating a checkpointed remote creation',async()=>{
  const {login,id,bot,base}=await fixture();
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  const job=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:'Restart',username:'restart_customer_bot'}});
  await runInDurableObject(actor,object=>object.ctx.storage.sql.exec("UPDATE jobs SET status='running',effect='bot_create' WHERE id=?",job.job_id));
  await evictDurableObject(actor);await runInDurableObject(actor,object=>object.alarm());
  expect((await call(`${base}/jobs/${job.job_id}`,{token:login.access_token})).data.status).toBe('uncertain');
  expect((await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}})).status).toBe(409);
  await runInDurableObject(actor,object=>object.ctx.storage.sql.exec("UPDATE jobs SET status='succeeded' WHERE id=?",job.job_id));
  const safe=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:bot.name,username:bot.username}});
  await runInDurableObject(actor,object=>object.ctx.storage.sql.exec("UPDATE jobs SET status='running',effect=NULL WHERE id=?",safe.job_id));
  await evictDurableObject(actor);await runInDurableObject(actor,object=>object.alarm());
  expect((await call(`${base}/jobs/${safe.job_id}`,{token:login.access_token})).result.token).toBe(bot.token);
});
it('revokes the Telegram authorization and clears the stored session independently of platform login',async()=>{
  const {login,id,base}=await fixture();let revoked=false;
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await runInDurableObject(actor,object=>{object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async(_,fn)=>fn({invoke:async request=>{expect(request.className).toBe('auth.LogOut');revoked=true;return {};}})});});
  expect((await call(`${base}/logout`,{method:'POST',token:login.access_token,body:{}})).data.status).toBe('revoked');
  expect(revoked).toBe(true);expect((await store.getAccount(id)).session).toBe('');
  expect((await call('/auth/me',{token:login.access_token})).status).toBe(200);
  expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:'New',username:'revoked_customer_bot'}})).status).toBe(401);
});
it('validates a replacement Bot Token before storing it encrypted and never echoes it',async()=>{
  const {login,id,bot,base}=await fixture(),token='123456789:'+'z'.repeat(35);
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await runInDurableObject(actor,object=>{
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async()=>{throw new Error('MTProto must not be used');},fetcher:async()=>Response.json({ok:true,result:{id:123456789,is_bot:true,username:bot.username}})});
  });
  const result=await call(`${base}/bots/${bot.username}/token`,{method:'PUT',token:login.access_token,body:{token}});
  expect(result.status).toBe(200);expect(JSON.stringify(result)).not.toContain(token);
  expect((await store.get(id,bot.username)).token).toBe(token);
  expect((await call(`${base}/bots/${bot.username}/token`,{method:'PUT',token:login.access_token,body:{token:'222222222:'+'z'.repeat(35)}})).status).toBe(400);
});
it('reschedules storage outages with backoff rather than continuously hammering D1',async()=>{
  const {login,bot,base}=await fixture();
  const job=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:bot.name,username:bot.username}});
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await runInDurableObject(actor,async object=>{
    object.ctx.storage.sql.exec('UPDATE jobs SET next_at=?',Date.now()-1);
    const original=object.store.userById;
    object.store.userById=async()=>{throw new Error('D1 unavailable');};
    await object.alarm();expect(await object.ctx.storage.getAlarm()).toBeGreaterThan(Date.now()+29000);
    expect(object.jobs.row(job.job_id).status).toBe('queued');object.store.userById=original;
  });
});
it('drains a bounded webhook batch while preserving update deduplication',async()=>{
  const {login,id,bot,base}=await fixture();
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'a',landing_url:'https://landing.example.test'}});
  const secret=(await store.getLanding(id,bot.username)).webhook_secret;
  for(const update_id of [301,302,303])expect((await call('/webhooks/123456789',{method:'POST',secret,body:{update_id,message:{chat:{id:update_id,type:'private'},text:'/start'}}})).status).toBe(200);
  const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX}123456789`));let sends=0;
  await runInDurableObject(actor,async object=>{
    object.send=async()=>{sends++;return true;};object.ctx.storage.sql.exec('UPDATE deliveries SET next_at=?',Date.now()-1);await object.alarm();
    for(const id of [301,302,303])expect(object.row(id).status).toBe('sent');await object.alarm();
  });expect(sends).toBe(3);
});
it('keeps the earliest scheduled delivery alarm during continuing webhook traffic',async()=>{
  const {login,id,bot,base}=await fixture();
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'a',landing_url:'https://landing.example.test'}});
  const secret=(await store.getLanding(id,bot.username)).webhook_secret;
  const actor=env.WEBHOOK_DELIVERIES.get(env.WEBHOOK_DELIVERIES.idFromName(`${env.AUTH_STATE_PREFIX}123456789`));
  const update=update_id=>call('/webhooks/123456789',{method:'POST',secret,body:{update_id,message:{chat:{id:update_id,type:'private'},text:'/start'}}});
  await update(401);const first=await runInDurableObject(actor,(_,ctx)=>ctx.storage.getAlarm());
  await update(402);await update(403);
  expect(await runInDurableObject(actor,(_,ctx)=>ctx.storage.getAlarm())).toBe(first);
});
it('distinguishes an explicit BotFather refusal from an unrecognized post-creation reply',async()=>{
  const {login,id,base}=await fixture();let reply='Sorry, this username is already taken.';
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest('+447000000001')}`));
  await runInDurableObject(actor,object=>{
    const fake={checkAuthorization:async()=>true,getEntity:async()=>({}),sendMessage:async(_,args)=>{fake.message=args.message;return {id:1};},getMessages:async()=>[{id:2,out:false,message:fake.message==='/newbot'?'Choose a name':fake.message==='Bot1'?'Choose a username':fake.message==='harden_customer_bot'?reply:'Cancelled'}]};
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,checkpoint:effect=>object.jobs.checkpoint(effect),connected:async(_,fn)=>fn(fake)});
  });
  const job=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:'Bot1',username:'harden_customer_bot'}});
  const run=()=>runInDurableObject(actor,async object=>{object.ctx.storage.sql.exec('UPDATE jobs SET next_at=?',Date.now()-1);await object.alarm();});
  await run();expect((await call(`${base}/jobs/${job.job_id}`,{token:login.access_token})).data.status).toBe('failed');
  reply='The response changed and the creation result cannot be recognized.';
  expect((await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}})).status).toBe(202);
  await run();expect((await call(`${base}/jobs/${job.job_id}`,{token:login.access_token})).data.status).toBe('uncertain');
  expect((await call(`${base}/jobs/${job.job_id}/retry`,{method:'POST',token:login.access_token,body:{}})).status).toBe(409);
});
