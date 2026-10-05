import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createStore} from '../api/store.js';
import {createDatabase} from '../api/database.js';
import {createAuthRuntime} from '../api/auth-runtime.js';
import {createService} from '../api/service.js';
import {installProductStore} from '../api/product-store.js';
import {credentials} from '../api/security.js';
import {Deliveries} from '../api/deliveries.js';
import {Failure} from '../api/errors.js';
import {backfillPhoneIndex} from '../api/phone-index.js';
import {digest} from '../api/auth.js';

test('identity persistence failure retains session, retries without SignIn and blocks business',async()=>{
  const account=randomUUID(),user={id:randomUUID()};let signs=0,fail=true;
  let saved={user_id:user.id,phone:'+447700123456',status:'code_required',phone_code_hash:'hash',expires_at:Date.now()+600000};
  const store={getAccount:async()=>structuredClone(saved),saveAccount:async(id,state)=>{saved=structuredClone(state);},
    claimPhone:async()=>account,recordIdentity:async()=>{if(fail)throw new Error('injected database outage');}};
  const service=createService({store,auth:{requireAccount:async()=>{},lockPhone:async()=>async()=>{}},
    connected:async(state,action)=>{try{return await action({invoke:async()=>{signs++;return {};},getMe:async()=>({id:123})});}finally{state.session='authenticated-session';}}});
  const verify=`/v1/accounts/${account}/verify`;
  await assert.rejects(service.route('POST',verify,{code:'12345'},user),error=>error.code==='IDENTITY_PERSISTENCE_FAILED'&&error.status===503&&error.next_action==='retry_verify');
  assert.equal(saved.status,'identity_pending');assert.equal(saved.session,'authenticated-session');
  await assert.rejects(service.route('POST',`/v1/accounts/${account}/bots`,{},user),error=>error.status===401);
  assert.equal((await service.route('POST','/v1/login/start',{phone:saved.phone,api_id:12345,api_hash:'a'.repeat(32)},user)).next_action,'retry_verify');
  saved.expires_at=0;fail=false;
  assert.equal((await service.route('POST',verify,{},user)).status,'authorized');assert.equal(signs,1);
  assert.equal(saved.phone_code_hash,undefined);assert.equal(saved.expires_at,undefined);
});

test('real identity conflict clears session after connector finalization',async()=>{
  const account=randomUUID(),user={id:randomUUID()};let saved={user_id:user.id,phone:'+447700123456',session:'session',status:'identity_pending'};
  const service=createService({store:{getAccount:async()=>structuredClone(saved),saveAccount:async(id,state)=>{saved=structuredClone(state);},recordIdentity:async()=>{throw new Failure(409,'conflict','IDENTITY_CONFLICT');}},
    auth:{requireAccount:async()=>{},lockPhone:async()=>async()=>{}},connected:async(state,action)=>{try{return await action({getMe:async()=>({id:123})});}finally{state.session='connector-final-session';}}});
  await assert.rejects(service.route('POST',`/v1/accounts/${account}/verify`,{},user),error=>error.code==='IDENTITY_CONFLICT');
  assert.equal(saved.status,'identity_conflict');assert.equal(saved.session,'');
});

test('real SQL/Redis: atomic receipts, identity rollback and indexed login migration',{skip:process.env.SECURITY_INTEGRATION!=='1',timeout:120000},async t=>{
  const database='tg_reliability_'+randomUUID().replaceAll('-','');
  const env={...process.env,DB_DATABASE:database,DB_POOL_SIZE:'1',REDIS_KEY_PREFIX:database+':',CREDENTIAL_KEY_ID:'v1',CREDENTIAL_KEYS:JSON.stringify({v1:randomBytes(32).toString('base64')})};
  let store,observer,auth;
  try{
    store=await createStore(env);observer=await createStore({...env,DB_AUTO_CREATE_DATABASE:'false'});auth=await createAuthRuntime(store,env);
    const crypt=credentials(env);const user={id:randomUUID(),email:'owner@example.test',password_hash:'test'},other={id:randomUUID(),email:'other@example.test',password_hash:'test'};
    await store.createUser(user);await store.createUser(other);
    const account=randomUUID(),otherAccount=randomUUID();const phone='+447700123456';
    const state={user_id:user.id,api_id:12345,api_hash:'a'.repeat(32),phone,session:'simulated',status:'code_required'};
    await store.saveAccount(account,state);await store.saveAccount(otherAccount,{...state,user_id:other.id,phone:'+447700123457'});
    await t.test('late phone insert failure rolls back identity; retry succeeds on one connection',async()=>{
      const failing={...store,transaction:action=>store.transaction(connection=>action({...connection,execute:async(sql,args)=>{
        if(sql.startsWith('INSERT INTO telegram_phone_claims'))throw new Error('injected phone persistence failure');return connection.execute(sql,args);
      }}))};installProductStore(failing,crypt,env);
      await assert.rejects(failing.recordIdentity(user.id,account,{id:1001},phone),/injected phone/);
      assert.equal((await store.pool.execute('SELECT * FROM telegram_identities'))[0].length,0);
      assert.equal((await store.pool.execute('SELECT * FROM telegram_phone_claims'))[0].length,0);
      await store.recordIdentity(user.id,account,{id:1001},phone);await store.recordIdentity(user.id,account,{id:1001,username:'updated'},phone);
      assert.equal((await store.accountsForUser(user.id))[0].profile.username,'updated');
      await assert.rejects(store.recordIdentity(other.id,account,{id:1001},phone),error=>error.status===404);
    });
    await t.test('phone ownership conflict rolls back a newly inserted Telegram identity',async()=>{
      const second=randomUUID();await store.saveAccount(second,state);
      await assert.rejects(store.recordIdentity(user.id,second,{id:1002},phone),error=>error.code==='IDENTITY_CONFLICT');
      assert.equal((await store.pool.execute('SELECT * FROM telegram_identities WHERE telegram_user_id=?',['1002']))[0].length,0);
    });
    await t.test('concurrent claims keep exactly one owner across replicas',async()=>{
      const competing=randomUUID();await store.saveAccount(competing,{...state,phone:'+447700123460'});
      const claims=await Promise.allSettled([store.recordIdentity(other.id,otherAccount,{id:2000},'+447700123457'),observer.recordIdentity(user.id,competing,{id:2000},'+447700123460')]);
      assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(claims.find(result=>result.status==='rejected').reason.code,'IDENTITY_CONFLICT');
      assert.equal((await store.pool.execute('SELECT * FROM telegram_identities WHERE telegram_user_id=?',['2000']))[0].length,1);
    });
    await t.test('indexed login reuses own pending account without decrypting other phones',async()=>{
      const pending=randomUUID();await store.saveAccount(pending,{...state,phone:'+447700123458'});
      const noDecrypt={...store};installProductStore(noDecrypt,{...crypt,open:()=>{throw new Error('login must not decrypt');}},env);
      assert.equal(await noDecrypt.claimPhone(user.id,'+447700123458',randomUUID()),pending);
      assert.equal(await noDecrypt.phoneAccount(user.id,'+447700123458'),pending);
      await assert.rejects(noDecrypt.claimPhone(other.id,phone,randomUUID()),error=>error.code==='IDENTITY_CONFLICT');
      const suggested=randomUUID();assert.equal(await noDecrypt.claimPhone(other.id,'+447700123458',suggested),suggested,'unverified phone does not reserve global ownership');
      await store.saveAccount(account,{...state,status:'authorized'});
      await store.pool.execute("UPDATE tg_info SET phone='unrelated-corrupt-ciphertext' WHERE account_id=?",[otherAccount]);
      assert.equal(await noDecrypt.claimPhone(user.id,'+447700123459',suggested),suggested);
      await store.saveAccount(otherAccount,{...state,user_id:other.id,phone:'+447700123457'});
    });
    await t.test('missing legacy indexes fail closed; offline backfill preserves ownership and is restartable',async()=>{
      await store.pool.execute('UPDATE tg_info SET phone_key=NULL WHERE account_id=?',[account]);
      await assert.rejects(store.ready(),error=>error.code==='PHONE_INDEX_NOT_READY');
      await assert.rejects(store.claimPhone(other.id,phone,randomUUID()),error=>error.code==='PHONE_INDEX_NOT_READY');
      const result=spawnSync(process.execPath,['scripts/backfill-phones.js'],{env,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).changed,1);
      assert.deepEqual(await backfillPhoneIndex(store.pool,crypt),{changed:0});await store.ready();
      assert.equal((await store.pool.execute('SELECT phone_key FROM tg_info WHERE account_id=?',[account]))[0][0].phone_key,digest(phone));
      await assert.rejects(store.claimPhone(other.id,phone,randomUUID()),error=>error.code==='IDENTITY_CONFLICT');
      assert.equal(await store.claimPhone(user.id,phone,randomUUID()),account);
    });
    await t.test('offline migration resumes after a later batch fails and never rewrites phone ciphertext',async()=>{
      let last,original;
      for(let i=0;i<101;i++){
        const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');await store.saveAccount(id,{...state,phone:'+447700'+String(100000+i)});
        const [rows]=await store.pool.execute('SELECT phone FROM tg_info WHERE account_id=?',[id]);last=id;original=rows[0].phone;
        await store.pool.execute('UPDATE tg_info SET phone_key=NULL WHERE account_id=?',[id]);
      }
      await store.pool.execute('UPDATE tg_info SET phone=? WHERE account_id=?',[crypt.seal('invalid',`tg:${last}:phone`),last]);
      await assert.rejects(backfillPhoneIndex(store.pool,crypt),error=>error.status===503);
      assert.equal(Number((await store.pool.execute('SELECT COUNT(*) AS n FROM tg_info WHERE phone_key IS NULL'))[0][0].n),1);
      await store.pool.execute('UPDATE tg_info SET phone=? WHERE account_id=?',[original,last]);
      assert.deepEqual(await backfillPhoneIndex(store.pool,crypt),{changed:1});
      assert.equal((await store.pool.execute('SELECT phone FROM tg_info WHERE account_id=?',[last]))[0][0].phone,original);await store.ready();
    });
    const bot={username:'receipt_test_bot',name:'Receipt',token:'123456789:'+ 'a'.repeat(35)};
    await store.save(account,bot);await store.configureLanding(account,bot.username,{customer_id:'test',landing_url:'https://example.test/',card_text:'Hello',card_image:'',button_text:'Open',webhook_secret:'s'.repeat(64)});
    const update=id=>({update_id:id,message:{text:'/start',chat:{id:9000+id,type:'private'}}});let sends=0;
    const send=async()=>({message_id:++sends});
    await t.test('event failure rolls back sent status and preserves receipt as uncertain without resending',async()=>{
      const failing={...store,event:async(event,connection)=>{if(event.type==='card_sent')throw new Error('injected event failure');return store.event(event,connection);}};
      const deliveries=new Deliveries(failing,auth,env,send);await deliveries.receive('123456789','s'.repeat(64),update(1));await deliveries.runOnce();
      const view=deliveries.view(await deliveries.owned(user,account,bot.username,'1'));assert.equal(view.status,'uncertain');assert.equal(view.message_id,'1');
      assert.equal((await store.pool.execute("SELECT * FROM business_events WHERE type='card_sent'"))[0].length,0);
      await deliveries.runOnce();assert.equal(sends,1);
    });
    await t.test('receipt and event become visible together only after committing',async()=>{
      const checking={...store,event:async(event,connection)=>{
        if(event.type==='card_sent'){const [rows]=await observer.pool.execute('SELECT status FROM webhook_deliveries WHERE bot_id=? AND update_id=?',['123456789','2']);assert.equal(rows[0].status,'sending');}
        return store.event(event,connection);
      }};
      const deliveries=new Deliveries(checking,auth,env,send);await deliveries.receive('123456789','s'.repeat(64),update(2));await deliveries.runOnce();
      assert.equal(deliveries.view(await deliveries.owned(user,account,bot.username,'2')).message_id,'2');
      const [events]=await store.pool.execute("SELECT * FROM business_events WHERE type='card_sent'");assert.equal(events.length,1);assert.equal(JSON.parse(crypt.open(events[0].data,`event:${events[0].id}:data`)).message_id,'2');
      assert.equal((await deliveries.owned(user,account,bot.username,'2')).status,'sent');
    });
    await t.test('lost lease cannot persist receipt or evidence; expired claim does not resend',async()=>{
      const replacement=randomUUID();const deliveries=new Deliveries(store,auth,env,async()=>{sends++;await observer.pool.execute('UPDATE webhook_deliveries SET lease=? WHERE bot_id=? AND update_id=?',[replacement,'123456789','3']);return {message_id:sends};});
      await deliveries.receive('123456789','s'.repeat(64),update(3));await deliveries.runOnce();
      const row=await deliveries.owned(user,account,bot.username,'3');assert.equal(row.status,'sending');assert.equal(row.lease,replacement);assert.equal(row.remote_message_id,null);
      assert.equal((await store.pool.execute("SELECT * FROM business_events WHERE type='card_sent'"))[0].length,1);
      await store.pool.execute('UPDATE webhook_deliveries SET lease_until=0 WHERE bot_id=? AND update_id=?',['123456789','3']);await deliveries.runOnce();
      assert.equal((await deliveries.owned(user,account,bot.username,'3')).status,'uncertain');assert.equal(sends,3);
    });
    await t.test('zero affected rows rolls back without producing success evidence',async()=>{
      const deliveries=new Deliveries(store,auth,env,send);await deliveries.receive('123456789','s'.repeat(64),update(4));
      const updateRow=deliveries.queue.update.bind(deliveries.queue);deliveries.queue.update=async(row,values,...args)=>values.status==='sent'?0:updateRow(row,values,...args);
      await deliveries.runOnce();assert.equal((await deliveries.owned(user,account,bot.username,'4')).status,'sending');
      assert.equal((await store.pool.execute("SELECT * FROM business_events WHERE type='card_sent'"))[0].length,1);
    });
    await t.test('reconciliation only repairs persisted receipts, rolls back failures and preserves original event time',async()=>{
      const original=await new Deliveries(store,auth,env,send).owned(user,account,bot.username,'1');const before=sends;
      const failing=new Deliveries({...store,event:async()=>{throw new Error('injected reconciliation failure');}},auth,env,send);
      await assert.rejects(failing.reconcile(original),/injected reconciliation/);
      assert.equal((await failing.owned(user,account,bot.username,'1')).status,'uncertain');
      const deliveries=new Deliveries(store,auth,env,send);assert.equal((await deliveries.reconcile(original)).status,'sent');assert.equal((await deliveries.reconcile(original)).status,'sent');assert.equal(sends,before);
      const [events]=await store.pool.execute("SELECT * FROM business_events WHERE type='card_sent' AND event_key=?",[digest('sent:123456789:1')]);assert.equal(events.length,1);assert.equal(Number(events[0].occurred_at),JSON.parse(crypt.open(original.payload,'delivery:123456789:1')).remote_sent_at);
      await assert.rejects(deliveries.reconcile(await deliveries.owned(user,account,bot.username,'3')),error=>error.code==='DELIVERY_RECEIPT_REQUIRED');
    });
  }finally{
    await auth?.close();await observer?.close();await store?.close();
    const admin=await createDatabase({...env,DB_DATABASE:env.DB_TYPE==='postgresql'?'postgres':database,DB_AUTO_CREATE_DATABASE:'false'});
    try{await admin.pool.query(`DROP DATABASE ${env.DB_TYPE==='postgresql'?'"'+database+'"':'`'+database+'`'}`);}finally{await admin.pool.end();}
  }
});
