import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword, verifyPassword, digest } from '../api/auth.js';

function harness({ mailError = false } = {}) {
  let time = 0;
  const records = new Map();
  const emails = [];
  const users = new Map();
  const read = key => {
    const record = records.get(key);
    if (record && record.expires <= time) { records.delete(key); return null; }
    return record || null;
  };
  const redis = {
    get: async key => read(key)?.value || null,
    set: async (key,value,options={}) => {if(options.NX && read(key))return null;records.set(key,{value,expires:options.EX?time+options.EX*1000:Infinity});return 'OK';},
    del: async key => Number(records.delete(key)),
    eval: async (script,{keys,arguments:args}) => {
      const key=keys[0];const record=read(key);
      if(script.includes('INCR')) {
        const value=Number(record?.value || 0)+1;
        records.set(key,{value:String(value),expires:record?.expires ?? time+Number(args[0])*1000});return value;
      }
      if(script.includes('challenge.code_hash')) {
        if(!record)return [0,'']; const challenge=JSON.parse(record.value);
        if(challenge.purpose!==args[1])return [0,''];
        if(challenge.code_hash!==args[0]) {
          challenge.attempts++;
          if(challenge.attempts>=5)records.delete(key);else record.value=JSON.stringify(challenge);
          return [0,''];
        }
        records.delete(key);return [1,record.value];
      }
      if(record?.value===args[0])return Number(records.delete(key));return 0;
    },
  };
  const store={
    userByEmail:async email=>[...users.values()].find(user=>user.email===email)||null,
    userById:async id=>users.get(id)||null,
    createUser:async user=>{if([...users.values()].some(item=>item.email===user.email))throw {code:'ER_DUP_ENTRY'};users.set(user.id,user);},
    ownsAccount:async(user,id)=>id==='owned-'+user,
  };
  const auth=createAuth({redis,store,secret:'a'.repeat(64),sendCode:async(email,code,purpose)=>{if(mailError)throw new Error('SMTP unavailable');emails.push({email,code,purpose});},now:()=>time});
  return {auth,redis,records,emails,users,advance:ms=>{time+=ms;},register:async(email='user@example.test')=>{
    const started=await auth.route('POST','/auth/register/start',{email,password:'long-test-password'},null,'127.0.0.1');
    return {started,result:await auth.route('POST','/auth/register/verify',{challenge_id:started.challenge_id,code:emails.at(-1).code},null,'127.0.0.1')};
  }};
}

test('passwords use salted scrypt and preserve password spaces',async()=>{
 const a=await hashPassword(' padded-password ');const b=await hashPassword(' padded-password ');
 assert.notEqual(a,b);assert.equal(await verifyPassword(' padded-password ',a),true);assert.equal(await verifyPassword('padded-password',a),false);
});

test('registration verifies email once, stores no plaintext password, grants 2h session',async()=>{
 const h=harness();const {started,result}=await h.register('User@Example.Test');
 assert.equal(started.expires_in,600);assert.equal(result.expires_in,7200);assert.equal(result.user.email,'user@example.test');
 assert.equal(h.users.get(result.user.id).password_hash.includes('long-test-password'),false);
 assert.equal(h.records.has('telegram-bot:challenge:'+started.challenge_id),false);
 assert.ok(h.records.has('telegram-bot:session:'+digest(result.access_token)));
 const me=await h.auth.route('GET','/auth/me',{},'Bearer '+result.access_token,'127.0.0.1');assert.deepEqual(me,result.user);
 await assert.rejects(h.auth.route('POST','/auth/register/verify',{challenge_id:started.challenge_id,code:h.emails[0].code},null,'127.0.0.1'),/已使用/);
 h.advance(7200*1000+1);await assert.rejects(h.auth.authenticate('Bearer '+result.access_token),/失效/);
});

test('10m expiry and five failed OTP attempts; purpose cannot be changed',async()=>{
 const h=harness();let started=await h.auth.route('POST','/auth/register/start',{email:'a@example.test',password:'long-test-password'},null,'ip');
 const code=h.emails[0].code;
 await assert.rejects(h.auth.route('POST','/auth/login/verify',{challenge_id:started.challenge_id,code},null,'ip'),/验证码/);
 for(let i=0;i<5;i++)await assert.rejects(h.auth.route('POST','/auth/register/verify',{challenge_id:started.challenge_id,code:code==='999999'?'111111':'999999'},null,'ip'),/验证码/);
 await assert.rejects(h.auth.route('POST','/auth/register/verify',{challenge_id:started.challenge_id,code},null,'ip'),/验证码/);
 started=await h.auth.route('POST','/auth/register/start',{email:'b@example.test',password:'long-test-password'},null,'ip');h.advance(600001);
 await assert.rejects(h.auth.route('POST','/auth/register/verify',{challenge_id:started.challenge_id,code:h.emails.at(-1).code},null,'ip'),/过期/);
});

test('login requires password and a new email code; logout revokes only that token',async()=>{
 const h=harness();const {result:first}=await h.register();h.advance(61000);
 await assert.rejects(h.auth.route('POST','/auth/login/start',{email:'user@example.test',password:'wrong-password'},null,'ip'),/邮箱或密码/);
 const challenge=await h.auth.route('POST','/auth/login/start',{email:'user@example.test',password:'long-test-password'},null,'ip');
 const second=await h.auth.route('POST','/auth/login/verify',{challenge_id:challenge.challenge_id,code:h.emails.at(-1).code},null,'ip');
 assert.equal(second.user.id,first.user.id);
 await h.auth.route('POST','/auth/logout',{},'Bearer '+second.access_token,'ip');
 await assert.rejects(h.auth.authenticate('Bearer '+second.access_token),/失效/);
 assert.equal((await h.auth.authenticate('Bearer '+first.access_token)).user.id,first.user.id);
 await assert.rejects(h.auth.requireAccount(first.user.id,'other-account'),/不存在/);
 await h.auth.requireAccount(first.user.id,'owned-'+first.user.id);
});

test('email cooldown and phone operation locks prevent overlapping actions',async()=>{
 const h=harness();const body={email:'a@example.test',password:'long-test-password'};
 await h.auth.route('POST','/auth/register/start',body,null,'ip');
 await assert.rejects(h.auth.route('POST','/auth/register/start',body,null,'ip'),/60 秒/);
 const release=await h.auth.lockPhone('+441234567890');await assert.rejects(h.auth.lockPhone('+441234567890'),/正在操作/);await release();await (await h.auth.lockPhone('+441234567890'))();
});

test('failed email delivery removes challenge; Redis failure does not authenticate',async()=>{
 const failed=harness({mailError:true});
 await assert.rejects(failed.auth.route('POST','/auth/register/start',{email:'user@example.test',password:'long-test-password'},null,'ip'),error=>error.status===503);
 assert.equal(failed.users.size,0);
 assert.equal([...failed.records.keys()].some(key=>key.includes('challenge:')),false);
 assert.equal([...failed.records.keys()].some(key=>key.includes('mail-cooldown:')),true);
 const h=harness();const {result}=await h.register();
 h.redis.get=async()=>{throw new Error('Redis unavailable');};
 await assert.rejects(h.auth.authenticate('Bearer '+result.access_token),/Redis unavailable/);
});
