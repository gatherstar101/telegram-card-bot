import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createStore} from '../api/store.js';
import {createDatabase} from '../api/database.js';
import {createAuthRuntime} from '../api/auth-runtime.js';
import {Jobs} from '../api/jobs.js';
import {Products} from '../api/products.js';
import {Deliveries} from '../api/deliveries.js';

const keys=()=>({CREDENTIAL_KEY_ID:'v1',CREDENTIAL_KEYS:JSON.stringify({v1:randomBytes(32).toString('base64')}),AUTH_HMAC_SECRET:'production-regression-secret-at-least-32-characters',PUBLIC_BASE_URL:'https://api.example.test'});
test('production tracking rejects unpublished versions and preserves historical releases',async()=>{
  const env=keys();let redirects=0;
  const store={pool:{},webhookBot:async()=>({user_id:'owner'}),assertBusiness:async()=>0,
    botPolicy:async()=>({id:'project',environment:'production',status:'active',published_version:1}),
    isPublishedVersion:async(id,version)=>[1,3].includes(version),
    projectConfig:async(id,version)=>({landing:{landing_url:'https://example.test/v'+version}}),
    event:async()=>{},dispatch:async(user,epoch,kind,action)=>{redirects++;return action();}};
  const deliveries=new Deliveries(store,{cache:{}},env);
  const token=version=>new URL(deliveries.trackedLink('100',{project_id:'project',environment:'production',version,business_epoch:0,project_epoch:0},'')).pathname.split('/').at(-1);
  await assert.rejects(deliveries.redirect(token(2),{}),error=>error.code==='VERSION_NOT_PUBLISHED');
  assert.equal(redirects,0);
  assert.equal(await deliveries.redirect(token(1),{}),'https://example.test/v1');
  assert.equal(await deliveries.redirect(token(3),{}),'https://example.test/v3','previously released versions survive rollback');
});

test('production SQL boundaries: one connection, atomic queue links, leases and retention', {skip:process.env.SECURITY_INTEGRATION!=='1',timeout:120000},async t=>{
  const database='tg_production_'+randomUUID().replaceAll('-','');
  const env={...process.env,...keys(),DB_DATABASE:database,DB_POOL_SIZE:'1',REDIS_KEY_PREFIX:database+':'};
  let store,observer,auth;
  try{
    store=await createStore(env);observer=await createStore({...env,DB_AUTO_CREATE_DATABASE:'false'});auth=await createAuthRuntime(store,env);
    await t.test('concurrent startup upgrades missing columns under the database schema lock',async()=>{
      await store.pool.execute('ALTER TABLE api_jobs DROP COLUMN project_id, DROP COLUMN workflow_id');
      await store.pool.execute(env.DB_TYPE==='postgresql'?'DROP INDEX ix_tg_phone':'ALTER TABLE tg_info DROP INDEX ix_tg_phone');
      await store.pool.execute('ALTER TABLE tg_info DROP COLUMN phone_key');
      await store.pool.execute('ALTER TABLE webhook_deliveries DROP COLUMN remote_message_id');
      await assert.rejects(createStore({...env,DB_AUTO_CREATE_DATABASE:'false',DB_SCHEMA_INIT:'false'}),error=>['ER_BAD_FIELD_ERROR','42703'].includes(error.code));
      const results=await Promise.allSettled([createStore(env),createStore(env)]);
      for(const result of results)if(result.status==='fulfilled')await result.value.close();
      for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);
      await store.pool.execute('SELECT project_id,workflow_id FROM api_jobs LIMIT 0');
      await store.pool.execute('SELECT phone_key FROM tg_info LIMIT 0');await store.pool.execute('SELECT remote_message_id FROM webhook_deliveries LIMIT 0');
    });
    await t.test('DML-only runtime account starts without schema privileges',async()=>{
      const role='tg_rt_'+randomBytes(6).toString('hex');const password=randomBytes(24).toString('base64url');let runtime;
      try{
        if(env.DB_TYPE==='postgresql'){
          await store.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
          await store.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
          await store.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
          await store.pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
        }else{
          await store.pool.query(`CREATE USER '${role}'@'%' IDENTIFIED BY ?`,[password]);
          await store.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* TO '${role}'@'%'`);
        }
        runtime=await createStore({...env,DB_USER:role,DB_PASSWORD:password,DB_AUTO_CREATE_DATABASE:'false',DB_SCHEMA_INIT:'false'});
        const id=randomUUID();await runtime.createUser({id,email:id+'@example.test',password_hash:'test'});assert.ok(await runtime.userById(id));
        await assert.rejects(runtime.pool.query('CREATE TABLE forbidden_runtime_ddl (id INT)'),error=>['ER_TABLEACCESS_DENIED_ERROR','42501'].includes(error.code));
      }finally{
        await runtime?.close();
        if(env.DB_TYPE==='postgresql'){await store.pool.query(`DROP OWNED BY ${role}`);await store.pool.query(`DROP ROLE ${role}`);}
        else await store.pool.query(`DROP USER '${role}'@'%'`);
      }
    });
    const user={id:randomUUID(),email:database+'@example.test',password_hash:'test',auth_version:0};await store.createUser(user);
    const account=randomUUID();await store.saveAccount(account,{user_id:user.id,api_id:12345,api_hash:'a'.repeat(32),phone:'+447700123456',status:'authorized',session:'simulated'});
    const project=randomUUID();const config={test_bot:{name:'Test',username:'boundary_test_bot'},production_bot:{name:'Production',username:'boundary_production_bot'},landing:{customer_id:'test',landing_url:'https://example.test/v1',card_text:'Hello',card_image:'',button_text:'Open'},test_user_ids:['9001'],channel:{title:'Boundary',about:'',post_text:'Hello'}};
    await store.saveProject(user.id,project,{account_id:account,name:'Boundary',customer_id:'test',config},10);
    let calls=0;const execute=async()=>{calls++;return {ok:true};};const jobs=new Jobs(store,auth,env,execute);const products=new Products(store,auth,jobs,{},env);
    let run;
    await t.test('provision with DB_POOL_SIZE=1 uses the transaction connection',async()=>{
      const view=await products.start(user,project,'test');run=view.workflow_id;
      assert.equal(view.status,'queued');
      assert.ok(view.steps.findIndex(step=>step.code==='verify_webhook')<view.steps.findIndex(step=>step.code==='publish_post'));
    });
    const lease=randomUUID();await store.pool.execute("UPDATE workflow_runs SET status='running',lease=?,lease_until=? WHERE id=?",[lease,Date.now()+120000,run]);
    await store.pool.execute("UPDATE workflow_steps SET status='running' WHERE workflow_id=? AND position=0",[run]);
    const binding={project_id:project,workflow_id:run,position:0,lease};const path=`/v1/accounts/${account}/channels/example/posts`;const body={text:'Hello',request_key:'atomic'};
    await t.test('failure at step association rolls back the queued job',async()=>{
      const failing={...store,transaction:action=>store.transaction(connection=>action({execute:async(sql,args)=>{
        if(sql.startsWith('UPDATE workflow_steps SET job_id='))throw new Error('injected crash before association');
        return connection.execute(sql,args);
      }}))};
      await assert.rejects(new Jobs(failing,auth,env,execute).enqueue(path,body,user,account,binding),/injected crash/);
      assert.equal((await store.pool.execute('SELECT id FROM api_jobs'))[0].length,0);
      assert.equal((await store.pool.execute('SELECT job_id FROM workflow_steps WHERE workflow_id=? AND position=0',[run]))[0][0].job_id,null);
    });
    let accepted;
    await t.test('another worker cannot claim an uncommitted job',async()=>{
      let signal;const inserted=new Promise(resolve=>{signal=resolve;});let continueWrite;const proceed=new Promise(resolve=>{continueWrite=resolve;});
      const waiting={...store,transaction:action=>store.transaction(connection=>action({execute:async(sql,args)=>{
        const result=await connection.execute(sql,args);
        if(sql.startsWith('INSERT INTO api_jobs')){signal();await proceed;}
        return result;
      }}))};
      const pending=new Jobs(waiting,auth,env,execute).enqueue(path,body,user,account,binding);
      await inserted;
      try{assert.equal(await new Jobs(observer,auth,env,execute).queue.claim(60),null);}finally{continueWrite();}
      accepted=await pending;
      const row=await jobs.get(accepted.job_id,user,account);assert.equal(row.workflow_id,run);assert.equal(row.project_id,project);
      assert.equal((await store.pool.execute('SELECT job_id FROM workflow_steps WHERE workflow_id=? AND position=0',[run]))[0][0].job_id,row.id);
    });
    await t.test('pause rejects further enqueue and cancels the committed task before execution',async()=>{
      await products.route('POST',`/v1/projects/${project}/pause`,new URL('https://example.test'),{},user);
      await assert.rejects(jobs.enqueue(path,body,user,account,binding),error=>error.code==='PROJECT_INACTIVE');
      await jobs.runOnce();assert.equal(calls,0);assert.equal((await jobs.get(accepted.job_id,user,account)).status,'cancelled');
      await store.pool.execute("UPDATE api_jobs SET status='queued' WHERE id=?",[accepted.job_id]);
      await jobs.runOnce();assert.equal(calls,0);assert.equal((await jobs.get(accepted.job_id,user,account)).status,'cancelled');
    });
    await t.test('explicit workflow ownership fails closed when the step link is absent',async()=>{
      await store.pool.execute('UPDATE workflow_steps SET job_id=NULL WHERE workflow_id=? AND position=0',[run]);
      await assert.rejects(store.assertTask(accepted.job_id,user.id),error=>error.code==='PROJECT_INACTIVE');
      await store.pool.execute('UPDATE workflow_steps SET job_id=? WHERE workflow_id=? AND position=0',[accepted.job_id,run]);
    });
    await t.test('retention keeps tasks needed by suspended or failed workflows',async()=>{
      await store.pool.execute('UPDATE api_jobs SET updated_at=0 WHERE id=?',[accepted.job_id]);
      await jobs.queue.cleanup(86400);assert.ok(await jobs.get(accepted.job_id,user,account));
      await store.pool.execute("UPDATE workflow_runs SET status='cancelled' WHERE id=?",[run]);
      await jobs.queue.cleanup(86400);await assert.rejects(jobs.get(accepted.job_id,user,account),error=>error.status===404);
    });
    await t.test('a lost workflow lease cannot publish or clear the active workflow',async()=>{
      await products.route('POST',`/v1/projects/${project}/resume`,new URL('https://example.test'),{},user);
      const current=await store.project(user.id,project);
      await store.pool.execute('UPDATE project_info SET active_workflow=?,tested_version=1 WHERE id=?',[run,project]);
      await store.pool.execute("UPDATE workflow_runs SET environment='production',status='running',lease=?,lease_until=?,project_epoch=? WHERE id=?",[randomUUID(),Date.now()+120000,current.epoch,run]);
      await store.pool.execute("UPDATE workflow_steps SET status='succeeded' WHERE workflow_id=?",[run]);
      const stale={id:run,user_id:user.id,project_id:project,business_epoch:0,project_epoch:current.epoch,environment:'production',version:1,lease};
      await assert.rejects(products.complete(stale,current),error=>error.code==='WORKFLOW_LEASE_EXPIRED');
      assert.equal((await store.project(user.id,project)).published_version,null);
      assert.equal((await store.project(user.id,project)).active_workflow,run);
      const row=(await store.pool.execute('SELECT * FROM workflow_runs WHERE id=?',[run]))[0][0];
      await products.complete(row,current);
      assert.equal(await store.isPublishedVersion(project,1),true);
      assert.equal(await store.isPublishedVersion(project,2),false);
    });
    let nextRun,newLease;
    await t.test('a stale worker cannot mark a step successful or failed after losing its lease',async()=>{
      nextRun=(await products.start(user,project,'test')).workflow_id;newLease=randomUUID();
      const interrupted=new Products(store,auth,jobs,{},env);
      interrupted.executeStep=async claimed=>{await store.pool.execute('UPDATE workflow_runs SET lease=? WHERE id=?',[newLease,claimed.id]);};
      await interrupted.runOnce();
      const row=(await store.pool.execute('SELECT status,lease FROM workflow_runs WHERE id=?',[nextRun]))[0][0];assert.equal(row.lease,newLease);assert.equal(row.status,'running');
      const step=(await store.pool.execute('SELECT status,completed_at,error FROM workflow_steps WHERE workflow_id=? AND position=0',[nextRun]))[0][0];assert.equal(step.status,'running');assert.equal(step.completed_at,null);assert.equal(step.error,null);
    });
    await t.test('workflow retry persists intent and restores a failed job in the worker',async()=>{
      const accepted=await jobs.enqueue(path,{...body,request_key:'worker-retry'},user,account,{...binding,workflow_id:nextRun,lease:newLease});
      await store.pool.execute("UPDATE api_jobs SET status='failed' WHERE id=?",[accepted.job_id]);
      await store.pool.execute("UPDATE workflow_steps SET code='publish_post',status='failed' WHERE workflow_id=? AND position=0",[nextRun]);
      await store.pool.execute("UPDATE workflow_runs SET status='failed',lease=NULL,lease_until=0 WHERE id=?",[nextRun]);
      let retries=0;const retryJobs=new Jobs(store,auth,env,execute);const retry=retryJobs.retry.bind(retryJobs);retryJobs.retry=async(...args)=>{retries++;return retry(...args);};
      const retryProducts=new Products(store,auth,retryJobs,{},env);
      const current=await store.project(user.id,project);assert.equal((await retryProducts.changeRun(user,current,nextRun,'retry')).status,'queued');assert.equal(retries,0,'API does not perform child retries after committing');
      await retryProducts.runOnce();assert.equal(retries,1);assert.equal((await retryJobs.get(accepted.job_id,user,account)).status,'queued');
      assert.equal((await retryProducts.workflowView(user,project,nextRun)).status,'running');assert.equal(calls,0);
    });
  }finally{
    await auth?.close();await observer?.close();await store?.close();
    const admin=await createDatabase({...env,DB_DATABASE:process.env.DB_DATABASE,DB_AUTO_CREATE_DATABASE:'false'});
    try{await admin.pool.query(`DROP DATABASE ${env.DB_TYPE==='postgresql'?'"'+database+'"':'`'+database+'`'}`);}finally{await admin.pool.end();}
  }
});
