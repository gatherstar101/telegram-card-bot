import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID,randomBytes } from 'node:crypto';
import { credentials } from '../api/security.js';
import { clientIP,createApplication } from '../api/app.js';
import { createStore } from '../api/store.js';
import { createAuthRuntime } from '../api/auth-runtime.js';
import { Jobs } from '../api/jobs.js';
import { Deliveries } from '../api/deliveries.js';
import { Failure } from '../api/errors.js';
import {createService} from '../api/service.js';
import { digest,hashPassword } from '../api/auth.js';
const keys=()=>({CREDENTIAL_KEY_ID:'v1',CREDENTIAL_KEYS:JSON.stringify({v1:randomBytes(32).toString('base64')})});

test('credentials reject plaintext, changed AAD and missing old keys',()=>{
 const env=keys();const c=credentials(env);const encrypted=c.seal('secret','tg:one:session');assert.equal(c.open(encrypted,'tg:one:session'),'secret');assert.throws(()=>c.open(encrypted,'tg:other:session'));assert.throws(()=>c.open('secret','tg:one:session'));assert.equal(credentials(env,{allowPlaintext:true}).open('legacy','x'),'legacy');assert.throws(()=>credentials(keys()).open(encrypted,'tg:one:session'));assert.notEqual(c.seal('secret','tg:one:session'),encrypted);
});
test('proxy headers require explicit trusted hop count',()=>{
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'198.51.100.1, 10.0.0.1'}};
 assert.equal(clientIP(req,{}),'127.0.0.1');assert.equal(clientIP(req,{TRUST_PROXY_HOPS:'1'}),'10.0.0.1');assert.equal(clientIP(req,{TRUST_PROXY_HOPS:'2'}),'198.51.100.1');req.headers['x-forwarded-for']='malformed';assert.equal(clientIP(req,{TRUST_PROXY_HOPS:'1'}),'127.0.0.1');
});
test('webhook configuration without a secret fails closed',async()=>{
 const store={pool:{},webhookBot:async()=>({webhook_secret:null})};
 const delivery=new Deliveries(store,{cache:{}},keys());
 await assert.rejects(delivery.receive('1','',{update_id:1}),e=>e.status===503);
});

test('real SQL/Redis security, OTP throttling, durable job recovery and webhook dedup',{skip:process.env.SECURITY_INTEGRATION!=='1'},async()=>{
 const env={...process.env,TRUST_PROXY_HOPS:'1',API_USER_PER_MINUTE:'1000'};
 const store=await createStore(env);const auth=await createAuthRuntime(store,env);const id=randomUUID();const account=randomUUID();const prefix=env.REDIS_KEY_PREFIX||'telegram-bot:';const token=randomBytes(32).toString('hex');const phone='+447700'+String(Math.floor(Math.random()*1e6)).padStart(6,'0');
 await store.createUser({id,email:`security-${id}@example.test`,password_hash:await hashPassword('security-long-password')});
 await auth.cache.set(prefix+'session:'+digest(token),JSON.stringify({user_id:id,auth_version:0,expires_at:Date.now()+7200000}),{EX:7200});
 await store.saveAccount(account,{user_id:id,api_id:12345,api_hash:'a'.repeat(32),phone,session:'sensitive-session',status:'authorized'});
 let calls=0;let failBot=false;let jobs;
 const bot={username:'security_'+id.replaceAll('-','').slice(0,15)+'bot',name:'Security bot',token:String(Math.floor(Math.random()*1e12))+':'+ 'z'.repeat(35),url:'https://t.me/example_bot'};
 const service={route:async(method,path,body,user)=>{
  if(path==='/v1/login/start'){const account_id=randomUUID();await store.saveAccount(account_id,{user_id:user.id,api_id:12345,api_hash:'b'.repeat(32),phone:body.phone,session:'test-login',status:'code_required',expires_at:Date.now()+600000});return {account_id,status:'code_required'};}
  calls++;
  if(path.endsWith('/bots')){await jobs.checkpoint('bot_create');if(failBot)throw new Error('network with sensitive details');await store.save(account,bot);return bot;}
  if(path.endsWith('/reconcile')){await store.save(account,bot);return bot;}
  return {ok:true};
 }};
 jobs=new Jobs(store,auth,env,(...args)=>service.route(...args));
 let sends=0;let behavior='ok';
 const deliveries=new Deliveries(store,auth,env,async()=>{sends++;if(behavior==='429'){const e=new Failure(502,'rate');e.telegram_code=429;e.retry_after=1;throw e;}if(behavior==='network')throw new Error('unknown sensitive token');return true;});
 const server=http.createServer(createApplication({store,auth,service,jobs,deliveries,env}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 let ip=10;const request=async(path,body,options={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Forwarded-For':options.ip||`198.51.100.${ip++}`,...options.headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),retry:r.headers.get('Retry-After')};};
 try{
  const [raw]=await store.pool.execute('SELECT api_hash,phone,session FROM tg_info WHERE account_id=?',[account]);for(const v of Object.values(raw[0]))assert.match(v,/^enc:v1:/);assert.equal((await store.getAccount(account)).session,'sensitive-session');
  assert.equal((await request('/ready')).status,503);assert.equal((await request('/health')).status,200);
  const email=`cooldown-${id}@example.test`;const registration={email,password:'security-long-password'};
  assert.equal((await request('/auth/register/start',registration,{ip:'198.51.100.240'})).status,503);
  const qps=await request('/auth/login/start',registration,{ip:'198.51.100.240'});assert.equal(qps.status,429);assert.ok(Number(qps.retry)>0);
  const cooldown=await request('/auth/register/start',registration,{ip:'198.51.100.241'});assert.equal(cooldown.status,429);assert.ok(cooldown.body.retry_after<=60&&cooldown.body.retry_after>0);
  const loginBody={phone};const login=await request('/v1/login/start',loginBody);assert.equal(login.status,200);assert.equal((await request('/v1/login/start',loginBody)).status,429);
  assert.equal((await request('/auth/me')).body.id,id);assert.ok(await auth.cache.ttl(prefix+'session:'+digest(token))<=7200);
  const user=(await auth.authenticate('Bearer '+token)).user;const path=`/v1/accounts/${account}/bots`;const body={request_key:'security-bot',name:bot.name,username:bot.username};
  failBot=true;const accepted=await request(path,body);assert.equal(accepted.status,202);assert.equal((await jobs.enqueue(path,body,user,account)).job_id,accepted.body.job_id);await assert.rejects(jobs.enqueue(path,{...body,name:'Changed'},user,account),e=>e.status===409);
  await jobs.runOnce();assert.equal((await jobs.get(accepted.body.job_id,user,account)).status,'uncertain');assert.equal(calls,1);await assert.rejects(jobs.retry(accepted.body.job_id,user,account),e=>e.status===409);
  failBot=false;const reconcile=await jobs.enqueue(`${path}/${bot.username}/reconcile`,{request_key:'recover'},user,account);await jobs.runOnce();assert.equal((await jobs.get(reconcile.job_id,user,account)).status,'succeeded');await jobs.retry(accepted.body.job_id,user,account);assert.equal((await jobs.get(accepted.body.job_id,user,account)).status,'succeeded');assert.equal(calls,2);
  const [cipher]=await store.pool.execute('SELECT token FROM bot_info WHERE account_id=?',[account]);assert.match(cipher[0].token,/^enc:v1:/);assert.equal((await store.get(account,bot.username)).token,bot.token);
  const postPath=`/v1/accounts/${account}/channels/test/posts`;const resumed=await jobs.enqueue(postPath,{request_key:'resume',text:'hello'},user,account);await store.pool.execute("UPDATE api_jobs SET status='running',lease_until=0 WHERE id=?",[resumed.job_id]);const otherJobs=new Jobs(store,auth,env,(...args)=>service.route(...args));await Promise.all([jobs.runOnce(),otherJobs.runOnce()]);assert.equal((await jobs.get(resumed.job_id,user,account)).status,'succeeded');assert.equal(calls,3);
  await store.configureLanding(account,bot.username,{customer_id:'test',landing_url:'https://example.test/',card_text:'Hello',card_image:'',button_text:'Go',webhook_secret:'s'.repeat(64)});
  const botId=bot.token.split(':')[0];const update=n=>({update_id:n,message:{text:'/start',chat:{id:100+n,type:'private'}}});
  const delivery=await deliveries.receive(botId,'s'.repeat(64),update(1));assert.equal(delivery.ok,true);assert.equal((await deliveries.receive(botId,'s'.repeat(64),update(1))).duplicate,true);await Promise.all([deliveries.runOnce(),deliveries.runOnce()]);assert.equal(sends,1);assert.equal((await deliveries.owned(user,account,bot.username,'1')).status,'sent');
  behavior='429';await deliveries.receive(botId,'s'.repeat(64),update(2));await deliveries.runOnce();let row=await deliveries.owned(user,account,bot.username,'2');assert.equal(row.status,'queued');await deliveries.queue.update(row,{next_at:0});behavior='ok';await deliveries.runOnce();assert.equal((await deliveries.owned(user,account,bot.username,'2')).status,'sent');assert.equal(sends,3);
  behavior='network';await deliveries.receive(botId,'s'.repeat(64),update(3));await deliveries.runOnce();row=await deliveries.owned(user,account,bot.username,'3');assert.equal(row.status,'uncertain');await assert.rejects(deliveries.retry(row,false),e=>e.status===409);await deliveries.retry(row,true);behavior='ok';await deliveries.runOnce();assert.equal((await deliveries.owned(user,account,bot.username,'3')).status,'sent');
  await deliveries.receive(botId,'s'.repeat(64),update(4));await store.pool.execute("UPDATE webhook_deliveries SET status='sending',lease_until=0 WHERE bot_id=? AND update_id='4'",[botId]);const before=sends;await deliveries.runOnce();assert.equal((await deliveries.owned(user,account,bot.username,'4')).status,'uncertain');assert.equal(sends,before);
  const queued=await jobs.enqueue(postPath,{request_key:'cancel',text:'hello'},user,account);await store.revokeSessions(id);await assert.rejects(auth.authenticate('Bearer '+token),e=>e.status===401);await jobs.runOnce();assert.equal((await jobs.get(queued.job_id,user,account)).status,'cancelled');
  const sessionToken=randomBytes(32).toString('hex');await auth.cache.set(prefix+'session:'+digest(sessionToken),JSON.stringify({user_id:id,auth_version:1,expires_at:Date.now()+7200000}),{EX:7200});
  await auth.route('POST','/auth/password',{current_password:'security-long-password',new_password:'security-new-password'},'Bearer '+sessionToken,'password-test');await assert.rejects(auth.authenticate('Bearer '+sessionToken),e=>e.status===401);
  await store.disableUser(id,true);assert.equal((await store.userById(id)).disabled,true);await store.disableUser(id,false);assert.equal((await store.userById(id)).disabled,false);
  const localService=createService({store,auth,env,connected:async(state,fn)=>fn({invoke:async()=>({})}),fetcher:async()=>({ok:true,json:async()=>({ok:true,result:{id:Number(botId),is_bot:true,username:bot.username}})})});
  const currentUser=await store.userById(id);const updated=await localService.route('PUT',`/v1/accounts/${account}/bots/${bot.username}/token`,{token:botId+':'+ 'n'.repeat(35)},currentUser);assert.equal(updated.ok,true);assert.equal(updated.token,undefined);assert.equal((await store.get(account,bot.username)).token,botId+':'+ 'n'.repeat(35));
  const logout=await localService.route('POST',`/v1/accounts/${account}/logout`,{},currentUser);assert.equal(logout.status,'revoked');assert.equal((await store.getAccount(account)).session,'');
  await store.pool.execute("UPDATE tg_info SET api_hash='legacy-hash' WHERE account_id=?",[account]);await assert.rejects(store.getAccount(account),e=>e.status===503);await store.rewrap('tg_info','',100);assert.equal((await store.getAccount(account)).api_hash,'legacy-hash');
  console.log('Docker security integration: real SQL/Redis and HTTP, simulated Telegram side effects passed');
 }finally{
  await new Promise(resolve=>server.close(resolve));
  for(const table of ['api_jobs','channel_posts','channel_info','bot_info','tg_info'])await store.pool.execute(`DELETE FROM ${table} WHERE user_id=?` .replace('WHERE user_id=?',table==='channel_posts'?'WHERE account_id=?':'WHERE user_id=?'),[table==='channel_posts'?account:id]);
  await store.pool.execute('DELETE FROM webhook_deliveries WHERE bot_id=?',[bot.token.split(':')[0]]);await store.pool.execute('DELETE FROM user_security WHERE user_id=?',[id]);await store.pool.execute('DELETE FROM user_info WHERE id=?',[id]);await auth.close();await store.close();
 }
});
