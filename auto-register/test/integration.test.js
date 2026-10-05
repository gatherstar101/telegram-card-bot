import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testMailer } from './helpers/smtp.js';
import { createClient } from 'redis';
import { createStore } from '../api/store.js';
import { digest } from '../api/auth.js';
import { createAuthRuntime } from '../api/auth-runtime.js';

// Opt-in: use a running API and the same database/Redis environment. No Telegram
// operations or external emails are sent; SMTP is captured by a local server.
test('real SQL/Redis authentication, persistence and HTTP ownership', { skip: process.env.INTEGRATION_TEST !== '1' }, async () => {
  const store = await createStore();
  const redis = createClient({ ...(process.env.REDIS_URL ? {url:process.env.REDIS_URL} : {socket:{host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT||6379),reconnectStrategy:false},username:process.env.REDIS_USER||undefined,password:process.env.REDIS_PASSWORD||undefined,database:Number(process.env.REDIS_DB||0)}) });
  redis.on('error', () => {});
  await redis.connect();
  const db = store.pool;
  const prefix = process.env.REDIS_KEY_PREFIX || 'telegram-bot:';
  const mail=[]; const users=[]; const account=randomUUID(); const phone='+447700'+String(Math.floor(Math.random()*1000000)).padStart(6,'0');
  const stamp=randomUUID();const ip='integration-'+stamp;const emails=[`integration-${stamp}@example.test`,`integration-other-${stamp}@example.test`];
  const smtp=await testMailer(mail);
  const auth=await createAuthRuntime(store,{...process.env,SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_FROM:'test@example.test',SMTP_SECURE:'false',SMTP_REQUIRE_TLS:'false',SMTP_USER:'',SMTP_PASSWORD:''});
  const base=process.env.TEST_API_URL || 'http://127.0.0.1:3100';
  const request=async(path,token,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const tokens=[];const challenges=[];
  try {
    for (const email of emails) {
      const start=await auth.route('POST','/auth/register/start',{email,password:'integration-long-password'},null,ip);
      challenges.push(start.challenge_id);
      assert.match(mail.at(-1).code || '',/^\d{6}$/);
      assert.equal(await redis.ttl(prefix+'challenge:'+start.challenge_id),600);
      const results=await Promise.all([1,2].map(()=>request('/auth/register/verify',null,'POST',{challenge_id:start.challenge_id,code:mail.at(-1).code})));
      assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results.map(r=>({status:r.status,error:r.body.error}))));
      assert.equal(results.filter(r=>r.status===401).length,1);
      const result=results.find(r=>r.status===200).body; users.push(result.user);tokens.push(result.access_token);
      assert.equal(await redis.ttl(prefix+'session:'+digest(result.access_token)),7200);
      assert.equal((await request('/auth/me',result.access_token)).body.id,result.user.id);
    }
    await store.saveAccount(account,{user_id:users[0].id,api_id:12345,api_hash:'a'.repeat(32),phone,session:'integration-session',status:'authorized'});
    assert.equal((await store.getAccount(account)).session,'integration-session');
    await assert.rejects(store.saveAccount(account,{user_id:users[1].id}),/ownership/);
    const bot={name:'Integration bot',username:'test_'+stamp.replaceAll('-','').slice(0,20)+'bot',token:'9'+String(Math.floor(Math.random()*1e12))+':'+ 'a'.repeat(35)};
    await store.save(account,bot);
    const landing={customer_id:'test',landing_url:'https://example.test/',card_text:'test',card_image:'',button_text:'Go',webhook_secret:'b'.repeat(64)};
    await store.configureLanding(account,bot.username,landing);
    await store.configureLanding(account,bot.username,{...landing,webhook_secret:'c'.repeat(64)});
    assert.equal((await store.getLanding(account,bot.username)).webhook_secret,landing.webhook_secret);
    await store.reserveChannel(account,{request_key:'channel-test',customer_id:'test',bot_username:bot.username,title:'test',about:''});
    await store.saveChannel(account,'channel-test',{channel_id:'123',access_hash:'456'});
    await store.channelReady(account,'channel-test','https://t.me/+test');
    const post={request_key:'post-test',message_text:'test',bot_url:'https://t.me/'+bot.username,landing_url:landing.landing_url,random_id:'123'};
    await store.reservePost(account,'channel-test',post);
    await assert.rejects(store.reservePost(account,'channel-test',post));
    await store.postReady(account,'channel-test','post-test',789);
    assert.equal((await store.getPost(account,'channel-test','post-test')).message_id,789);
    const paths=[`/v1/accounts/${account}`,`/v1/accounts/${account}/bots/${bot.username}`,`/v1/accounts/${account}/bots/${bot.username}/landing`,`/v1/accounts/${account}/channels/channel-test`];
    for(const path of paths){assert.equal((await request(path,tokens[0])).status,200);assert.equal((await request(path,tokens[1])).status,404);assert.equal((await request(path)).status,401);}
    assert.equal((await request(`/v1/accounts/${account}/bots/${bot.username}`,tokens[0])).body.token,bot.token);
    assert.equal((await request('/v1/accounts',tokens[1])).body.accounts.length,0);
    assert.equal((await request(`/v1/accounts/${account}/bots`,tokens[1],'POST',{name:'x',username:'anotherbot'})).status,404);
    assert.equal((await request(`/v1/accounts/${account}/channels`,tokens[1],'POST',{})).status,404);
    assert.equal((await request('/auth/logout',tokens[0],'POST',{})).status,200);
    assert.equal((await request('/auth/me',tokens[0])).status,401);
    await redis.del(prefix+'mail-cooldown:'+digest(emails[0]));
    const login=await auth.route('POST','/auth/login/start',{email:emails[0],password:'integration-long-password'},null,ip);
    challenges.push(login.challenge_id);
    const verified=await request('/auth/login/verify',null,'POST',{challenge_id:login.challenge_id,code:mail.at(-1).code});assert.equal(verified.status,200);
    const session=verified.body;tokens.push(session.access_token);
    assert.equal(session.user.id,users[0].id);
    await redis.expire(prefix+'session:'+digest(session.access_token),0);
    assert.equal((await request('/auth/me',session.access_token)).status,401);
    console.log('Verified real tables, local SMTP, HTTP OTP verification, TTLs, replay, persistence and cross-user access');
  } finally {
    await db.execute('DELETE FROM channel_posts WHERE account_id=?',[account]);
    for (const table of ['channel_info','bot_info','tg_info'])await db.execute(`DELETE FROM ${table} WHERE account_id=?`,[account]);
    for(const user of users){await db.execute('DELETE FROM user_security WHERE user_id=?',[user.id]);await db.execute('DELETE FROM user_info WHERE id=?',[user.id]);}
    const keys=[...tokens.map(token=>prefix+'session:'+digest(token)),...challenges.map(id=>prefix+'challenge:'+id)];
    for(const email of emails)keys.push(prefix+'mail-cooldown:'+digest(email),prefix+'rate:email:'+digest(email),prefix+'rate:password-email:'+digest(email));
    keys.push(prefix+'rate:auth-ip:'+digest(ip),prefix+'rate:verify-ip:'+digest(ip),prefix+'telegram-lock:'+digest(phone));
    await redis.del(keys);await auth.close();await smtp.close();await redis.quit();await store.close();
  }
});
