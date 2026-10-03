import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { env,exports as workerExports } from 'cloudflare:workers';
import { applyD1Migrations,reset,runInDurableObject,evictDurableObject } from 'cloudflare:test';
import { createStore } from '../src/store.js';
import { digest } from '../../auto-register/api/auth.js';
import { createService } from '../../auto-register/api/service.js';
import { createAuthRuntime } from '../src/auth-runtime.js';

let emails;
let telegramCalls;
const store = createStore(env.DB);
async function call(path,{method='GET',body,token,secret}={}) {
  const response = await workerExports.default.fetch(`https://worker.example.test${path}`,{
    method,headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.42',...(token?{Authorization:`Bearer ${token}`} : {}),...(secret?{'X-Telegram-Bot-Api-Secret-Token':secret}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json();
  return {...data,status:response.status,data};
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
  emails=[]; telegramCalls=[];
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
  expect((await call('/auth/register/start',{method:'POST',body:{email:'failed@example.test',password}})).status).toBe(200);
});
it('routes owned accounts to actors and hides other users accounts and bot tokens',async () => {
  const {login,id,bot,base}=await fixture();
  expect((await call('/v1/accounts',{token:login.access_token})).accounts).toHaveLength(1);
  expect((await call(base,{token:login.access_token})).status).toBe(200);
  expect((await call(`${base}/bots/${bot.username}`,{token:login.access_token})).token).toBe(bot.token);
  expect((await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:bot.name,username:bot.username}})).token).toBe(bot.token);
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
  const body={message:{chat:{id:42,type:'private'},text:'/start customer-a'}};
  expect((await call('/webhooks/123456789',{method:'POST',body})).status).toBe(403);
  expect((await call('/webhooks/123456789',{method:'POST',secret:config.webhook_secret,body})).status).toBe(200);
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
  const result=await call(`${base}/channels/channel-a/posts`,{method:'POST',token:login.access_token,body:{request_key:'post-a',text:'Content'}});
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
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async(state,fn)=>{const result=await fn(fake);state.session='test-persisted-session';return result;}});
  });
  const start=await call('/v1/login/start',{method:'POST',token:login.access_token,body:{phone,api_id:12345,api_hash:'a'.repeat(32)}});
  expect(start.status).toBe(200);
  expect(start.delivery).toBe('telegram_app');
  const base=`/v1/accounts/${start.account_id}`;
  expect((await call(`${base}/verify`,{method:'POST',token:login.access_token,body:{code:'12345'}})).data.status).toBe('authorized');
  expect((await store.getAccount(start.account_id)).session).toBe('test-persisted-session');
  const bot=await call(`${base}/bots`,{method:'POST',token:login.access_token,body:{name:'New Bot',username:'new_customer_bot'}});
  expect(bot.token).toBe('987654321:'+'b'.repeat(35));
  await call(`${base}/bots/${bot.username}/landing`,{method:'PUT',token:login.access_token,body:{customer_id:'new-customer',landing_url:'https://landing.example.test'}});
  const channel=await call(`${base}/channels`,{method:'POST',token:login.access_token,body:{request_key:'new-channel',bot_username:bot.username,title:'New Channel'}});
  expect(channel.invite_url).toBe('https://t.me/+created-invite');
  const post=await call(`${base}/channels/new-channel/posts`,{method:'POST',token:login.access_token,body:{request_key:'new-post',text:'New post'}});
  expect(post.message_id).toBe(987);
});
it('rejects malformed and oversized JSON before account operations',async () => {
  const login=await register();
  expect((await call('/v1/login/start',{method:'POST',token:login.access_token,body:{phone:'invalid'}})).status).toBe(400);
  expect((await call('/auth/register/start',{method:'POST',body:[]})).status).toBe(400);
  expect((await call('/auth/register/start',{method:'POST',body:{payload:'x'.repeat(17000)}})).status).toBe(413);
  expect((await call('/health')).ok).toBe(true);
});
it('prevents simultaneous login attempts from interleaving on the same phone actor',async () => {
  const login=await register();
  const phone='+447000000003';
  const actor=env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX}${digest(phone)}`));
  let started,finish;
  const entered=new Promise(resolve=>{started=resolve;});
  const hold=new Promise(resolve=>{finish=resolve;});
  await runInDurableObject(actor,object=>{
    object.service=createService({store:object.store,auth:createAuthRuntime(object.store,env),env,connected:async(state,fn)=>fn({sendCode:async()=>{started();await hold;return {phoneCodeHash:'lock-test-hash'};}})});
  });
  const request={method:'POST',token:login.access_token,body:{phone,api_id:12345,api_hash:'a'.repeat(32)}};
  const first=call('/v1/login/start',request);
  await entered;
  try { expect((await call('/v1/login/start',request)).status).toBe(409); }
  finally { finish(); }
  expect((await first).status).toBe(200);
});
