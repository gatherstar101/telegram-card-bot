import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {adminConfiguration,bootstrapAdmin,userPatch} from '../api/admin.js';
import {createStore} from '../api/store.js';
import {createAuthRuntime} from '../api/auth-runtime.js';
import {createApplication} from '../api/app.js';
import {digest,hashPassword,verifyPassword} from '../api/auth.js';
import {testMailer} from './helpers/smtp.js';
import {adminIPGuard,adminIPKey} from '../api/security.js';

test('administrator credentials are mandatory, normalized and never use defaults',()=>{
  for(const env of [{},{ADMIN_EMAIL:'admin@example.test'},{ADMIN_PASSWORD:'strong-password'},{ADMIN_EMAIL:'invalid',ADMIN_PASSWORD:'strong-password'},{ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:'short'}])assert.throws(()=>adminConfiguration(env));
  assert.deepEqual(adminConfiguration({ADMIN_EMAIL:' Admin@Example.Test ',ADMIN_PASSWORD:' strong-password '}),{email:'admin@example.test',password:' strong-password '});
});

test('user editing accepts only explicit fields and hashes passwords',async()=>{
  for(const body of [{},{role:'admin'},{id:randomUUID()},{api_hash:'secret'},{disabled:'true'},{password:'short'}])await assert.rejects(userPatch(body),error=>error.status===400);
  const patch=await userPatch({email:' User@Example.Test ',password:'strong-new-password',disabled:false});
  assert.equal(patch.email,'user@example.test');assert.equal(patch.disabled,false);
  assert.equal(await verifyPassword('strong-new-password',patch.password_hash),true);
  assert.equal(patch.password,undefined);
});

test('administrator IP guard preserves retry TTL and rejects Redis outages',async()=>{
  let called;
  const cache={adminIPBanTTL:async(key,max)=>{called={key,max};return 823;},adminAuthFailure:async(key,max,seconds)=>{called={key,max,seconds};return 3600;}};
  await assert.rejects(adminIPGuard(cache,{},'198.51.100.1'),error=>error.status===429&&error.retry_after===823&&error.admin_ip_banned);
  assert.equal(called.max,2);assert.equal(called.key,adminIPKey({},'198.51.100.1'));
  await assert.rejects(adminIPGuard(cache,{},'198.51.100.1',{failed:true}),error=>error.status===429&&error.retry_after===3600);
  assert.equal(called.seconds,3600);
  await assert.rejects(adminIPGuard({adminIPBanTTL:async()=>{throw new Error('Redis offline');}}, {},'198.51.100.1'),error=>error.status===503);
});

test('real SQL/Redis/SMTP administrator bootstrap, editing, authorization and atomic audits',{skip:process.env.SECURITY_INTEGRATION!=='1'},async()=>{
  const stamp=randomUUID();const password='administrator-test-password';
  const env={...process.env,ADMIN_EMAIL:`admin-${stamp}@example.test`,ADMIN_PASSWORD:password,
    ADMIN_API_KEY:'k'.repeat(40),TRUST_PROXY_HOPS:'1',API_IP_PER_MINUTE:'1000',OTP_IP_QPS:'100',ADMIN_AUTH_MAX_FAILURES:'2',ADMIN_IP_BAN_SECONDS:'3600'};
  let store,auth,smtp,server,secondServer,reopened;const mail=[];const users=[];const tokens=[];const requestIds=[];const ips=new Set();let nextIP=50;
  const prefix=env.REDIS_KEY_PREFIX||'telegram-bot:';
  try{
    store=await createStore(env);
    const initialized=await bootstrapAdmin(store,env);users.push(initialized.user.id);
    assert.equal(initialized.created,true);assert.equal(initialized.user.role,'admin');
    const admin=await store.userById(initialized.user.id);
    assert.equal(await verifyPassword(password,admin.password_hash),true);assert.ok(!admin.password_hash.includes(password));
    const again=await Promise.all([1,2,3].map(()=>bootstrapAdmin(store,{...env,ADMIN_PASSWORD:'changed-env-password'})));
    assert.ok(again.every(result=>!result.created&&result.user.id===admin.id));
    assert.equal(await verifyPassword(password,(await store.userById(admin.id)).password_hash),true);
    const concurrentEmail=`concurrent-${stamp}@example.test`;
    const firstStarts=await Promise.all([1,2,3].map(()=>bootstrapAdmin(store,{...env,ADMIN_EMAIL:concurrentEmail})));
    const concurrentId=firstStarts[0].user.id;users.push(concurrentId);
    assert.equal(firstStarts.filter(result=>result.created).length,1);
    assert.ok(firstStarts.every(result=>result.user.id===concurrentId));
    assert.equal((await store.auditLogs('',concurrentId,100)).length,1);
    smtp=await testMailer(mail);
    auth=await createAuthRuntime(store,{...env,SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_FROM:'test@example.test',SMTP_REQUIRE_TLS:'false',SMTP_SECURE:'false',SMTP_USER:'',SMTP_PASSWORD:''});
    server=http.createServer(createApplication({store,auth,env,service:{},jobs:{},deliveries:{}}));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=async(path,{token,method='GET',body,raw,headers={},apiBase=base}={})=>{
      const ip=headers['X-Forwarded-For']||`198.51.100.${nextIP++}`;ips.add(ip);
      const response=await fetch(apiBase+path,{method,headers:{'Content-Type':'application/json','User-Agent':'admin-audit-test/1.0','X-Forwarded-For':ip,...(token?{Authorization:'Bearer '+token}:{}),...headers},...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{})});
      const id=response.headers.get('X-Request-ID');if(id)requestIds.push(id);
      return {status:response.status,body:await response.json(),id,retry:response.headers.get('Retry-After')};
    };
    assert.equal((await request('/admin/login',{method:'POST',body:{email:admin.email,password:'incorrect-password'}})).status,401);
    const verified=await request('/admin/login',{method:'POST',body:{email:admin.email,password}});
    assert.equal(verified.status,200);assert.equal(verified.body.user.role,'admin');assert.equal(mail.length,0);const adminToken=verified.body.access_token;tokens.push(adminToken);
    assert.equal((await request('/auth/login/start',{method:'POST',body:{email:admin.email,password}})).status,401);
    assert.equal(mail.length,0,'ordinary login must not provide a second administrator password entry');
    const email=`user-${stamp}@example.test`;
    const register=await request('/auth/register/start',{method:'POST',body:{email,password:'ordinary-user-password',role:'admin'}});
    assert.equal(register.status,200);
    const registered=await request('/auth/register/verify',{method:'POST',body:{challenge_id:register.body.challenge_id,code:mail.at(-1).code,role:'admin'}});
    assert.equal(registered.status,200);assert.equal(registered.body.user.role,'user');const user=registered.body.user;users.push(user.id);const userToken=registered.body.access_token;tokens.push(userToken);
    assert.equal((await request('/admin/login',{method:'POST',body:{email,password:'ordinary-user-password'}})).status,401);
    await assert.rejects(bootstrapAdmin(store,{...env,ADMIN_EMAIL:email}),/普通用户/);
    const second=randomUUID();users.push(second);await store.createUser({id:second,email:`other-${stamp}@example.test`,password_hash:await hashPassword('other-user-password')});
    const endpoint=`/admin/users/${user.id}`;
    const denied=await request(endpoint,{token:userToken,method:'PATCH',body:{email:'unauthorized@example.test'}});assert.equal(denied.status,403);
    assert.equal((await request('/admin/users')).status,401);
    assert.equal((await request('/admin/users',{token:'invalid'})).status,401);
    assert.equal((await request(endpoint,{token:adminToken})).body.email,email);
    const listed=await request('/admin/users?limit=1',{token:adminToken});assert.equal(listed.status,200);assert.equal(listed.body.users.length,1);assert.ok(listed.body.next_cursor);
    assert.equal((await request('/admin/users?after=invalid',{token:adminToken})).status,400);
    assert.equal((await request(endpoint,{token:adminToken,method:'PATCH',body:{role:'admin'}})).status,400);
    assert.equal((await request(endpoint,{token:adminToken,method:'PATCH',raw:'invalid-json'})).status,400);
    const collision=await request(endpoint,{token:adminToken,method:'PATCH',body:{email:`other-${stamp}@example.test`}});assert.equal(collision.status,409);
    assert.equal((await store.userById(user.id)).auth_version,0);
    // A database failure inserting the success audit must roll back the update
    // and session revocation. The request failure is audited separately.
    const getConnection=store.pool.getConnection.bind(store.pool);let failAudit=true;
    store.pool.getConnection=async()=>{const connection=await getConnection();const execute=connection.execute.bind(connection);connection.execute=(sql,args)=>{if(failAudit&&sql.includes('INSERT INTO audit_logs')){failAudit=false;throw new Error('test audit outage');}return execute(sql,args);};return connection;};
    const rolledBack=await request(endpoint,{token:adminToken,method:'PATCH',body:{email:'rolled-back@example.test'}});
    store.pool.getConnection=getConnection;
    assert.equal(rolledBack.status,500);assert.equal((await store.userById(user.id)).email,email);assert.equal((await store.userById(user.id)).auth_version,0);
    const newEmail=`changed-${stamp}@example.test`;const newPassword='ordinary-reset-password';
    const updated=await request(endpoint,{token:adminToken,method:'PATCH',body:{email:newEmail,password:newPassword,disabled:true},headers:{'X-Forwarded-For':'198.51.100.42'}});
    assert.equal(updated.status,200);assert.equal(updated.body.user.disabled,true);assert.equal(updated.body.user.email,newEmail);assert.equal(updated.body.user.password_hash,undefined);
    assert.equal((await request('/auth/me',{token:userToken})).status,401);
    const saved=await store.userById(user.id);assert.equal(saved.auth_version,1);assert.equal(await verifyPassword(newPassword,saved.password_hash),true);
    assert.equal((await request(endpoint+'/disabled',{token:env.ADMIN_API_KEY,method:'PUT',body:{disabled:false}})).status,200);
    assert.equal((await store.userById(user.id)).auth_version,2);
    assert.equal((await request(`/admin/users/${admin.id}`,{token:adminToken,method:'PATCH',body:{disabled:true}})).status,403);
    const missing=await request(`/admin/users/${randomUUID()}`,{token:adminToken,method:'PATCH',body:{disabled:true}});assert.equal(missing.status,404);
    assert.equal((await request('/admin/credentials/rewrap',{token:adminToken,method:'POST',body:{table:'tg_info',limit:1}})).status,200);
    const audits=await request(`/admin/audit-logs?user_id=${user.id}`,{token:adminToken});assert.equal(audits.status,200);
    const success=audits.body.logs.find(log=>log.request_id===updated.id);
    assert.equal(success.status,200);assert.equal(success.actor_id,admin.id);assert.equal(success.actor_type,'admin');assert.equal(success.ip,'198.51.100.42');assert.match(success.peer_ip,/127\.0\.0\.1/);
    assert.equal(success.user_agent,'admin-audit-test/1.0');assert.equal(success.method,'PATCH');assert.equal(success.action,'users.update');assert.equal(success.target_id,user.id);
    assert.match(success.completed_at,/Z$/);assert.ok(Date.parse(success.completed_at)>=Date.parse(success.started_at));
    assert.deepEqual(success.changes.password,{changed:true});assert.equal(success.changes.email.after,newEmail);
    const denial=audits.body.logs.find(log=>log.request_id===denied.id);assert.equal(denial.status,403);assert.equal(denial.actor_id,user.id);
    assert.ok(audits.body.logs.some(log=>log.actor_type==='api_key'&&log.status===200));
    const serialized=JSON.stringify(await store.auditLogs('', '',100));for(const secret of [password,newPassword,env.ADMIN_API_KEY,adminToken,saved.password_hash])assert.ok(!serialized.includes(secret));
    const page=await request('/admin/audit-logs?limit=1',{token:adminToken});assert.ok(page.body.next_cursor);
    const next=await request(`/admin/audit-logs?limit=1&before=${page.body.next_cursor}`,{token:adminToken});assert.ok(BigInt(next.body.logs[0].id)<BigInt(page.body.logs[0].id));
    assert.equal((await request('/admin/audit-logs?before=9999999999999999999',{token:adminToken})).status,400);
    reopened=await createStore({...env,DB_AUTO_CREATE_DATABASE:'false'});
    assert.equal((await reopened.userById(admin.id)).role,'admin');assert.equal((await reopened.userById(user.id)).email,newEmail);assert.ok((await reopened.auditLogs('',user.id,100)).some(log=>log.request_id===updated.id));

    const bruteIP='203.0.113.10';const bruteHeaders={'X-Forwarded-For':bruteIP};const banKey=adminIPKey(env,bruteIP);
    const badLogin={method:'POST',body:{email:admin.email,password:'incorrect-password'},headers:bruteHeaders};
    assert.equal((await request('/admin/login',badLogin)).status,401);
    assert.equal(await auth.cache.get(banKey),'1');assert.ok(await auth.cache.ttl(banKey)>3500);
    const banned=await request('/admin/login',badLogin);assert.equal(banned.status,429);assert.equal(Number(banned.retry),3600);assert.equal(banned.body.retry_after,3600);
    assert.equal(await auth.cache.get(banKey),'2');
    assert.equal((await request('/admin/login',{...badLogin,body:{email:admin.email,password}})).status,429);
    assert.equal((await request('/admin/users',{token:adminToken,headers:bruteHeaders})).status,429);
    const deniedKey=await request('/admin/users',{token:env.ADMIN_API_KEY,headers:bruteHeaders});assert.equal(deniedKey.status,429);
    const [blockedAudits]=await store.pool.execute('SELECT status,ip,user_agent,changes FROM audit_logs WHERE request_id=?',[deniedKey.id]);
    assert.equal(blockedAudits[0].status,429);assert.equal(blockedAudits[0].ip,bruteIP);assert.equal(blockedAudits[0].user_agent,'admin-audit-test/1.0');
    const blockedChanges=typeof blockedAudits[0].changes==='string'?JSON.parse(blockedAudits[0].changes):blockedAudits[0].changes;assert.equal(blockedChanges.security.ip_banned,true);
    // Shorten the real Redis TTL to verify expiry without waiting an hour.
    await auth.cache.set(banKey,'2',{XX:true,EX:1});
    const notExtended=await request('/admin/users',{token:env.ADMIN_API_KEY,headers:bruteHeaders});assert.equal(notExtended.status,429);assert.equal(Number(notExtended.retry),1);assert.ok(await auth.cache.ttl(banKey)<=1);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await request('/admin/users',{token:env.ADMIN_API_KEY,headers:bruteHeaders})).status,200);assert.equal(await auth.cache.get(banKey),null);

    // Failures are shared across all admin routes and are not reset by success.
    const sharedIP='203.0.113.11';const sharedHeaders={'X-Forwarded-For':sharedIP};
    assert.equal((await request('/admin/users',{token:'invalid-key',headers:sharedHeaders})).status,401);
    assert.equal((await request('/admin/users',{token:env.ADMIN_API_KEY,headers:sharedHeaders})).status,200);
    assert.equal((await request('/admin/login',{...badLogin,headers:sharedHeaders})).status,429);
    assert.equal((await request('/admin/audit-logs',{token:env.ADMIN_API_KEY,headers:sharedHeaders})).status,429);

    // Two service instances race on the same Redis key; only one first failure.
    secondServer=http.createServer(createApplication({store,auth,env,service:{},jobs:{},deliveries:{}}));
    await new Promise((resolve,reject)=>{secondServer.once('error',reject);secondServer.listen(0,'127.0.0.1',resolve);});
    const otherBase=`http://127.0.0.1:${secondServer.address().port}`;const concurrentIP='203.0.113.12';const concurrentHeaders={'X-Forwarded-For':concurrentIP};
    const failures=await Promise.all([request('/admin/users',{token:'invalid-key',headers:concurrentHeaders}),request('/admin/audit-logs',{token:'invalid-key',headers:concurrentHeaders,apiBase:otherBase})]);
    assert.deepEqual(failures.map(result=>result.status).sort(),[401,429]);assert.equal(await auth.cache.get(adminIPKey(env,concurrentIP)),'2');
    assert.equal((await request('/admin/users',{token:env.ADMIN_API_KEY,headers:concurrentHeaders,apiBase:otherBase})).status,429);
    const unauthIP='203.0.113.13';const unauthHeaders={'X-Forwarded-For':unauthIP};
    assert.equal((await request('/admin/users',{headers:unauthHeaders})).status,401);
    assert.equal((await request('/admin/users',{headers:unauthHeaders})).status,429);
    const invalidIP='203.0.113.14';const invalidHeaders={'X-Forwarded-For':invalidIP};
    assert.equal((await request('/admin/login',{method:'POST',body:{email:admin.email,password:'short'},headers:invalidHeaders})).status,400);
    assert.equal((await request('/admin/login',{method:'POST',raw:'invalid-json',headers:invalidHeaders})).status,429);

    // Authenticated business validation/permission failures do not count.
    const businessIP='203.0.113.15';const businessHeaders={'X-Forwarded-For':businessIP};
    for(let i=0;i<2;i++){
      assert.equal((await request(endpoint,{token:env.ADMIN_API_KEY,method:'PATCH',body:{role:'admin'},headers:businessHeaders})).status,400);
      assert.equal((await request(`/admin/users/${admin.id}`,{token:env.ADMIN_API_KEY,method:'PATCH',body:{disabled:true},headers:businessHeaders})).status,403);
    }
    assert.equal((await request('/admin/users',{token:env.ADMIN_API_KEY,headers:businessHeaders})).status,200);assert.equal(await auth.cache.get(adminIPKey(env,businessIP)),null);
    const checkIP=auth.cache.adminIPBanTTL;
    auth.cache.adminIPBanTTL=async()=>{throw new Error('test Redis guard outage');};
    try{assert.equal((await request('/admin/users',{token:env.ADMIN_API_KEY})).status,503);}finally{auth.cache.adminIPBanTTL=checkIP;}
    await store.revokeSessions(admin.id);assert.equal((await request('/admin/users',{token:adminToken})).status,401);
    // Check that role authorization is read freshly for each request as well.
    const session=await auth.adminLogin({email:admin.email,password},'admin-relogin');tokens.push(session.access_token);
    await store.pool.execute('DELETE FROM user_admins WHERE user_id=?',[admin.id]);
    assert.equal((await request('/admin/users',{token:session.access_token})).status,403);
    console.log(`Administrator integration passed: ${store.type}, real Redis/SMTP/HTTP, IP bans, concurrent failures, expiry, rollback and audits`);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    if(secondServer)await new Promise(resolve=>secondServer.close(resolve));
    await reopened?.close();
    if(auth){for(const token of tokens)await auth.cache.del(prefix+'session:'+digest(token));for(const ip of ips)await auth.cache.del(adminIPKey(env,ip));await auth.close();}
    await smtp?.close();
    if(store){
      if(requestIds.length)await store.pool.execute(`DELETE FROM audit_logs WHERE request_id IN (${requestIds.map(()=>'?').join(',')})`,requestIds);
      for(const id of users){await store.pool.execute('DELETE FROM audit_logs WHERE actor_id=? OR target_id=?',[id,id]);await store.pool.execute('DELETE FROM user_admins WHERE user_id=?',[id]);await store.pool.execute('DELETE FROM user_security WHERE user_id=?',[id]);await store.pool.execute('DELETE FROM user_info WHERE id=?',[id]);}await store.close();
    }
  }
});
