import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {createStore} from '../api/store.js';
import {createDatabase} from '../api/database.js';
import {createAuthRuntime} from '../api/auth-runtime.js';
import {createApplication} from '../api/app.js';
import {createService} from '../api/service.js';
import {Jobs} from '../api/jobs.js';
import {Deliveries} from '../api/deliveries.js';
import {Products,projectInput} from '../api/products.js';
import {digest,hashPassword,verifyPassword} from '../api/auth.js';
import {testMailer} from './helpers/smtp.js';
import {bootstrapAdmin} from '../api/admin.js';

const projectBody=account=>({account_id:account,name:'Customer campaign',customer_id:'customer-a',test_bot:{name:'Test',username:'campaign_test_bot'},production_bot:{name:'Production',username:'campaign_production_bot'},landing_url:'https://example.test/landing',card_text:'Welcome',button_text:'Open',test_user_ids:['9001'],channel:{title:'Campaign',about:'About',post_text:'Join us'}});
test('project input separates environments, validates identities and rejects ownership injection',()=>{
  const input=projectBody(randomUUID());assert.equal(projectInput(input).config.landing.landing_url,input.landing_url);
  for(const invalid of [{...input,user_id:randomUUID()},{...input,test_user_ids:['@name']},{...input,production_bot:input.test_bot},{...input,landing_url:'javascript:alert(1)'},{...input,channel:{title:'x',unknown:true}}])assert.throws(()=>projectInput(invalid),error=>error.status===400);
});

test('real SQL/Redis unified onboarding, isolated release, metrics, revocation and recovery',{skip:process.env.SECURITY_INTEGRATION!=='1',timeout:120000},async()=>{
  const database='tg_product_'+randomUUID().replaceAll('-','');const prefix=database+':';
  const env={...process.env,DB_DATABASE:database,REDIS_KEY_PREFIX:prefix,PUBLIC_BASE_URL:'https://api.example.test',TRUST_PROXY_HOPS:'1',API_USER_PER_MINUTE:'1000',API_IP_PER_MINUTE:'1000',OTP_IP_QPS:'100',JOB_QUEUE_LIMIT:'100'};
  let store,auth,smtp,server;const mail=[];const users=[];const tokens=[];let jobs,products;
  const remote=new Map();const sent=[];const posts=[];let botNumber=Date.now();let messageNumber=0;let telegramCalls=0;let failInfo=false;
  const fetcher=async(url,options)=>{
    telegramCalls++;
    const token=url.match(/\/bot([^/]+)\//)?.[1];const bot=[...remote.values()].find(item=>item.token===token);assert.ok(bot,'fake Bot must exist');
    const method=url.split('/').at(-1);const body=JSON.parse(options.body);
    let result={};if(method==='getMe')result={id:Number(token.split(':')[0]),is_bot:true,username:bot.username};
    if(method==='setWebhook')bot.webhook=body.url;
    if(method==='getWebhookInfo'){if(failInfo)throw new Error('simulated read failure');result={url:bot.webhook,pending_update_count:0};}
    return {ok:true,json:async()=>({ok:true,result})};
  };
  const connected=async(state,action)=>{
    let reply='';let creating=false;
    const client={
      sendCode:async()=>{telegramCalls++;return {phoneCodeHash:'hash',isCodeViaApp:true};},
      getMe:async()=>({id:900000+Number(state.phone.slice(-4)),username:'owner',firstName:'Owner'}),
      checkAuthorization:async()=>true,
      getEntity:async()=>({id:'BotFather'}),
      getMessages:async()=>[{id:messageNumber+1,out:false,message:reply}],
      sendMessage:async(peer,{message})=>{
        telegramCalls++;messageNumber++;
        if(message==='/cancel')reply='Cancelled';
        else if(message==='/newbot'){creating=true;reply='Choose name';}
        else if(creating&&!/bot$/i.test(message))reply='Choose username';
        else if(/bot$/i.test(message)){const bot={username:message.replace(/^@/,''),token:String(++botNumber)+':'+ 'a'.repeat(35)};remote.set(bot.username,bot);reply='Done '+bot.token;}
        else reply='Ok';return {id:messageNumber};
      },
      createChannel:async()=>{telegramCalls++;return {id:++messageNumber,accessHash:12345};},
      invoke:async(request)=>{telegramCalls++;if(request.message)posts.push(request.message);return {link:'https://t.me/+test-invite',id:++messageNumber};},
    };
    return action(client);
  };
  const advance=async(workflow,target)=>{
    for(let i=0;i<45;i++){
      await store.pool.execute('UPDATE workflow_runs SET next_at=0 WHERE id=?',[workflow]);
      await products.runOnce();await jobs.runOnce();
      const view=await products.workflowView(users[0],projectId,workflow);
      if(view.status===target)return view;
      assert.ok(!['failed','needs_reconciliation','suspended'].includes(view.status),JSON.stringify(view));
    }throw new Error('workflow did not reach '+target);
  };
  let projectId;
  try{
    store=await createStore(env);smtp=await testMailer(mail);
    auth=await createAuthRuntime(store,{...env,SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),SMTP_FROM:'test@example.test',SMTP_REQUIRE_TLS:'false',SMTP_USER:'',SMTP_PASSWORD:''});
    for(let i=0;i<2;i++){const user={id:randomUUID(),email:`user-${i}@example.test`,password_hash:await hashPassword('initial-user-password')};await store.createUser(user);users.push(await store.userById(user.id));const token=randomBytes(32).toString('hex');tokens.push(token);await auth.cache.set(prefix+'session:'+digest(token),JSON.stringify({user_id:user.id,auth_version:0,expires_at:Date.now()+7200000}),{EX:7200});}
    const service=createService({store,auth,connected,env,fetcher,checkpoint:(...args)=>jobs.checkpoint(...args)});
    jobs=new Jobs(store,auth,env,(...args)=>service.route(...args));
    const deliveries=new Deliveries(store,auth,env,async(token,method,payload)=>{telegramCalls++;sent.push({token,method,payload});return {message_id:sent.length};});
    products=new Products(store,auth,jobs,service,env,fetcher);
    server=http.createServer(createApplication({store,auth,service,jobs,deliveries,products,env}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;let requestNumber=1;
    const request=async(path,method='GET',body,token=tokens[0])=>{
      const response=await fetch(base+path,{method,redirect:'manual',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'User-Agent':'product-test','X-Forwarded-For':`198.51.100.${requestNumber++}`},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,location:response.headers.get('Location'),body:response.status===302?null:await response.json()};
    };
    const app=await request('/v1/telegram-apps','POST',{name:'Own App',api_id:12345,api_hash:'a'.repeat(32)});assert.equal(app.status,200);assert.equal(app.body.api_hash,undefined);
    assert.equal((await request('/v1/onboarding')).body.stage,'authenticate_telegram');
    assert.equal((await request('/v1/telegram-apps')).body.apps.length,1);
    assert.equal((await request('/v1/telegram-apps/'+app.body.id,'PATCH',{name:'Other',api_id:12345,api_hash:'a'.repeat(32)},tokens[1])).status,404);
    const login=await request('/v1/login/start','POST',{app_config_id:app.body.id,phone:'+447700123401'});assert.equal(login.status,200);
    const account=login.body.account_id;assert.equal((await request(`/v1/accounts/${account}/verify`,'POST',{code:'12345'})).body.status,'authorized');
    const repeat=await service.route('POST','/v1/login/start',{app_config_id:app.body.id,phone:'+447700123401'},users[0]);assert.equal(repeat.account_id,account);assert.equal(repeat.status,'authorized');
    await assert.rejects(store.claimPhone(users[1].id,'+447700123401',randomUUID()),error=>error.code==='IDENTITY_CONFLICT');
    const ownAccounts=(await request('/v1/accounts')).body.accounts;assert.equal(ownAccounts[0].profile.username,'owner');
    const create=await request('/v1/projects','POST',projectBody(account));assert.equal(create.status,200);projectId=create.body.id;
    await bootstrapAdmin(store,{ADMIN_EMAIL:'admin-product@example.test',ADMIN_PASSWORD:'product-admin-password'});
    const adminLogin=await request('/admin/login','POST',{email:'admin-product@example.test',password:'product-admin-password'});assert.equal(adminLogin.status,200);
    assert.equal((await request(`/admin/users/${users[0].id}/limits`,'PUT',{MAX_PROJECTS_PER_USER:1},adminLogin.body.access_token)).status,200);
    assert.equal((await request('/v1/me/limits')).body.effective.MAX_PROJECTS_PER_USER,1);
    assert.equal((await request('/v1/projects','POST',{...projectBody(account),name:'Over quota'})).status,429);
    assert.equal((await request('/admin/users?q=user-0','GET',undefined,adminLogin.body.access_token)).body.users.length,1);
    assert.equal((await request('/v1/projects/'+projectId,'GET',undefined,tokens[1])).status,404);
    assert.equal((await request('/v1/projects/'+projectId+'/publish','POST',{})).status,409);
    assert.equal((await request('/v1/projects/'+projectId+'/preview')).body.card.card_text,'Welcome');
    const accepted=await request('/v1/projects/'+projectId+'/provision','POST',{});assert.equal(accepted.status,202);
    assert.equal((await request('/v1/projects/'+projectId+'/provision','POST',{})).status,409);
    products=new Products(store,auth,jobs,service,env,fetcher); // process restart resumes persisted steps
    const testRun=await advance(accepted.body.workflow_id,'waiting_test');assert.equal(testRun.completed_steps,testRun.total_steps-1);
    assert.equal((await request('/v1/projects/'+projectId+'/test-confirmation','POST',{confirmed:true})).status,409);
    const testResource=await store.resource(projectId,'test','bot');const testLanding=await store.getLanding(account,testResource.username);
    const update=(id,visitor=9001)=>({update_id:id,message:{text:'/start channel_a',chat:{id:visitor,type:'private'},from:{id:visitor,username:'visitor',first_name:'Visitor',language_code:'en'}}});
    assert.equal((await deliveries.receive(testResource.bot_id,testLanding.webhook_secret,update(1,9002))).ignored,true);
    await deliveries.receive(testResource.bot_id,testLanding.webhook_secret,update(2));assert.equal((await deliveries.receive(testResource.bot_id,testLanding.webhook_secret,update(2))).duplicate,true);
    const recordEvent=store.event;let failCardEvent=true;store.event=async(...args)=>{if(args[0].type==='card_sent'&&failCardEvent){failCardEvent=false;throw new Error('injected test evidence write failure');}return recordEvent(...args);};
    try{await deliveries.runOnce();}finally{store.event=recordEvent;}assert.equal(sent.length,1);
    const deliveryPath=`/v1/accounts/${account}/bots/${testResource.username}/deliveries/2`;
    assert.equal((await request(deliveryPath)).body.status,'uncertain');assert.equal((await request(deliveryPath)).body.message_id,'1');
    assert.equal((await request('/v1/projects/'+projectId+'/test-confirmation','POST',{confirmed:true})).status,409);
    assert.equal((await request(deliveryPath+'/reconcile','POST',{},tokens[1])).status,404);
    assert.equal((await request(deliveryPath+'/reconcile','POST',{})).body.status,'sent');
    assert.equal((await request(deliveryPath+'/reconcile','POST',{})).body.status,'sent');assert.equal(sent.length,1,'reconciliation must never send another card');
    const testLink=sent[0].payload.reply_markup.inline_keyboard[0][0].url;
    const redirect=await request(new URL(testLink).pathname);assert.equal(redirect.status,302);assert.equal(redirect.location,'https://example.test/landing');
    assert.equal((await request(new URL(testLink).pathname+'x')).status,400);
    const channelLink=posts[0].match(/查看活动：(\S+)/)[1];
    const channelToken=new URL(channelLink).pathname.split('/').at(-1).split('.')[0];
    const channelPayload=JSON.parse(Buffer.from(channelToken,'base64url').toString());
    assert.equal(channelPayload.exp,null);assert.equal(channelPayload.environment,'test');assert.ok(channelPayload.source.endsWith('-test'));
    assert.equal((await request(new URL(channelLink).pathname)).status,302);
    assert.equal((await request('/v1/projects/'+projectId+'/test-confirmation','POST',{confirmed:true})).body.status,'succeeded');
    const live=await request('/v1/projects/'+projectId+'/publish','POST',{});assert.equal(live.status,202);await advance(live.body.workflow_id,'succeeded');
    const production=await store.resource(projectId,'production','bot');assert.notEqual(production.bot_id,testResource.bot_id);
    const productionLanding=await store.getLanding(account,production.username);assert.notEqual(productionLanding.webhook_secret,testLanding.webhook_secret);
    const ordinary=update(9,9002);ordinary.message.text='Hello';
    await deliveries.receive(production.bot_id,productionLanding.webhook_secret,ordinary);
    await deliveries.receive(production.bot_id,productionLanding.webhook_secret,ordinary);
    const [ordinaryEvents]=await store.pool.execute('SELECT data,raw_update FROM business_events WHERE type=?',['telegram_update']);
    assert.equal(ordinaryEvents.length,1);assert.ok(ordinaryEvents[0].raw_update.startsWith('enc:'));
    await deliveries.receive(production.bot_id,productionLanding.webhook_secret,update(10,9002));await deliveries.runOnce();assert.equal(sent.length,2);
    const productionLink=sent[1].payload.reply_markup.inline_keyboard[0][0].url;
    assert.equal((await request(`/v1/accounts/${account}/bots/${production.username}/landing`,'PUT',{customer_id:'a',landing_url:'https://example.test/unsafe'})).status,409);
    await request('/v1/projects/'+projectId+'/conversions','POST',{event_id:'order-1',source:'channel_a',value:10,currency:'USD'});
    assert.equal((await request('/v1/projects/'+projectId+'/conversions','POST',{event_id:'order-1'})).body.duplicate,true);
    const stats=(await request('/v1/projects/'+projectId+'/statistics')).body.statistics;assert.ok(stats.some(row=>row.type==='card_sent'&&row.environment==='production'));assert.ok(stats.some(row=>row.type==='link_visit'));
    const events=(await request('/v1/projects/'+projectId+'/events')).body.events;assert.ok(events.some(row=>row.data.telegram_user_id==='9001'));assert.ok(events.every(row=>row.raw_update===undefined));
    const [raw]=await store.pool.execute('SELECT data,raw_update FROM business_events WHERE type=?',['bot_start']);assert.ok(raw.every(row=>row.data.startsWith('enc:')&&row.raw_update.startsWith('enc:')));
    // A failed read step is explicitly retried; completed creation steps survive.
    const draft=await request('/v1/projects/'+projectId,'PUT',{...projectBody(account),card_text:'Version two'});assert.equal(draft.body.draft_version,2);
    const secondTest=await request('/v1/projects/'+projectId+'/provision','POST',{});failInfo=true;
    let failed;
    for(let i=0;i<15;i++){await store.pool.execute('UPDATE workflow_runs SET next_at=0 WHERE id=?',[secondTest.body.workflow_id]);await products.runOnce();await jobs.runOnce();failed=await products.workflowView(users[0],projectId,secondTest.body.workflow_id);if(failed.status==='failed')break;}
    assert.equal(failed.status,'failed');assert.ok(failed.completed_steps>0);assert.equal(remote.size,2);
    failInfo=false;assert.equal((await request(`/v1/projects/${projectId}/workflows/${secondTest.body.workflow_id}/retry`,'POST',{})).status,202);await advance(secondTest.body.workflow_id,'waiting_test');
    await deliveries.receive(testResource.bot_id,testLanding.webhook_secret,update(20));await deliveries.runOnce();assert.equal(sent.at(-1).payload.text,'Version two');await request(new URL(sent.at(-1).payload.reply_markup.inline_keyboard[0][0].url).pathname);
    await request('/v1/projects/'+projectId+'/test-confirmation','POST',{confirmed:true});const secondLive=await request('/v1/projects/'+projectId+'/publish','POST',{});
    const pendingVersionLink=deliveries.trackedLink(production.bot_id,{project_id:projectId,environment:'production',version:2,business_epoch:await store.assertBusiness(users[0].id),project_epoch:(await store.project(users[0].id,projectId)).epoch},'');
    const blockedVersion=await request(new URL(pendingVersionLink).pathname);assert.equal(blockedVersion.status,403);assert.equal(blockedVersion.body.code,'VERSION_NOT_PUBLISHED');
    await advance(secondLive.body.workflow_id,'succeeded');assert.equal((await request(new URL(pendingVersionLink).pathname)).status,302);
    const rollback=await request('/v1/projects/'+projectId+'/rollback','POST',{version:1,confirmed:true});assert.equal(rollback.status,202);await advance(rollback.body.workflow_id,'succeeded');assert.equal((await store.project(users[0].id,projectId)).published_version,1);assert.equal(remote.size,2);
    assert.equal((await request(new URL(pendingVersionLink).pathname)).status,302,'previously successful links remain eligible after rollback');
    assert.equal((await request('/v1/projects/'+projectId+'/versions')).body.versions.length,2);assert.ok((await request('/v1/projects/'+projectId+'/workflows')).body.workflows.length>=5);
    const delivered=sent.length;
    await deliveries.receive(production.bot_id,productionLanding.webhook_secret,update(11,9002));
    await request('/v1/projects/'+projectId+'/pause','POST',{});assert.equal((await request(new URL(productionLink).pathname)).status,403);await deliveries.runOnce();assert.equal(sent.length,delivered);
    await request('/v1/projects/'+projectId+'/resume','POST',{});assert.equal((await request(new URL(productionLink).pathname)).status,409);assert.equal(sent.length,delivered);
    await deliveries.receive(production.bot_id,productionLanding.webhook_secret,update(12,9002));
    const before=telegramCalls;await store.disableUser(users[0].id,true);
    assert.equal((await deliveries.receive(production.bot_id,productionLanding.webhook_secret,update(13,9002))).ignored,true);await deliveries.runOnce();await products.runOnce();await jobs.runOnce();assert.equal(telegramCalls,before);
    await assert.rejects(store.dispatch(users[0].id,undefined,'blocked',async()=>telegramCalls++),error=>error.code==='USER_DISABLED');
    assert.equal((await request('/v1/projects/'+projectId)).status,401);
    await store.disableUser(users[0].id,false);await deliveries.runOnce();assert.equal(sent.length,delivered);
    let mutations=0;
    const interrupted=createService({store,auth,env,connected:async(state,action)=>action({checkAuthorization:async()=>true,getEntity:async()=>({id:'father'}),sendMessage:async()=>{mutations++;await store.disableUser(users[0].id,true);return {id:1};},getMessages:async()=>{throw new Error('must not poll after disable');}})});
    await assert.rejects(interrupted.route('POST',`/v1/accounts/${account}/bots`,{name:'Interrupted',username:'interrupted_example_bot'},users[0]),error=>error.code==='USER_DISABLED');assert.equal(mutations,1);await store.disableUser(users[0].id,false);
    const stoppedBeforeToken=createService({store,auth,env,fetcher:async()=>assert.fail('Bot API must not run after disable'),connected:(state,action)=>connected(state,client=>action({...client,getMessages:async(...args)=>{const replies=await client.getMessages(...args);if(replies.some(reply=>reply.message.startsWith('Done ')))await store.disableUser(users[0].id,true);return replies;}}))});
    await assert.rejects(stoppedBeforeToken.route('POST',`/v1/accounts/${account}/bots`,{name:'Token guard',username:'token_guard_example_bot'},users[0]),error=>error.code==='USER_DISABLED');await store.disableUser(users[0].id,false);
    // Expired login records remain available for reauthorization; no orphaning.
    const pending=randomUUID();await store.saveAccount(pending,{user_id:users[0].id,api_id:12345,api_hash:'b'.repeat(32),phone:'+447700000001',status:'code_required',expires_at:0});await store.accountCount(users[0].id);assert.ok(await store.getAccount(pending));
    const reset=await auth.route('POST','/auth/password/reset/start',{email:users[1].email},null,'reset-test');assert.ok(mail.at(-1).code);
    await auth.route('POST','/auth/password/reset/verify',{challenge_id:reset.challenge_id,code:mail.at(-1).code,new_password:'reset-user-password'},null,'reset-test');assert.equal(await verifyPassword('reset-user-password',(await store.userById(users[1].id)).password_hash),true);await assert.rejects(auth.authenticate('Bearer '+tokens[1]),error=>error.status===401);
    await assert.rejects(auth.route('POST','/auth/password/reset/verify',{challenge_id:reset.challenge_id,code:mail.at(-1).code,new_password:'reset-again-password'},null,'reset-test'),error=>error.status===401);
    // Rotate every new encrypted table, including composite-key cursors.
    const keyId='rotated';const rotated=await createStore({...env,CREDENTIAL_KEY_ID:keyId,CREDENTIAL_KEYS:JSON.stringify({...JSON.parse(env.CREDENTIAL_KEYS),[keyId]:randomBytes(32).toString('base64')})});
    try{for(const table of ['tg_info','bot_info','telegram_apps','telegram_identities','project_versions','telegram_visitors','business_events','api_jobs','webhook_deliveries']){let cursor='';for(let page=0;page<100;page++){const result=await rotated.rewrap(table,cursor,1);cursor=result.next_cursor;if(result.done)break;assert.ok(page<99,'rotation completed');}}assert.equal((await rotated.projectConfig(projectId,2)).landing.card_text,'Version two');assert.equal((await rotated.telegramApp(users[0].id,app.body.id)).api_hash,'a'.repeat(32));}finally{await rotated.close();}
    const firstFlow=randomUUID(),activeFlow=randomUUID();
    for(const [flow,status] of [[firstFlow,'failed'],[activeFlow,'queued']])await store.pool.execute('INSERT INTO workflow_runs(id,project_id,user_id,environment,version,status,business_epoch,project_epoch,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[flow,projectId,users[0].id,'test',2,status,await store.assertBusiness(users[0].id),(await store.project(users[0].id,projectId)).epoch,0,Date.now(),Date.now()]);
    await store.pool.execute('UPDATE project_info SET active_workflow=? WHERE id=?',[activeFlow,projectId]);
    await products.changeRun(users[0],await store.project(users[0].id,projectId),firstFlow,'cancel');
    assert.equal((await store.project(users[0].id,projectId)).active_workflow,activeFlow,'cancelling an old run preserves current run');
    const enabledLogin=await auth.route('POST','/auth/login/start',{email:users[0].email,password:'initial-user-password'},null,'reenabled-test');
    const enabledSession=await request('/auth/login/verify','POST',{challenge_id:enabledLogin.challenge_id,code:mail.at(-1).code});assert.equal(enabledSession.status,200);tokens[0]=enabledSession.body.access_token;
    assert.equal((await request('/v1/projects/'+projectId+'/archive','POST',{})).status,200);
    assert.equal((await request('/v1/projects/'+projectId+'/pause','POST',{})).status,409);
    assert.equal((await request('/v1/projects/'+projectId+'/resume','POST',{})).status,409);
    console.log('Product integration passed: '+env.DB_TYPE+', real SQL/Redis/HTTP/SMTP, simulated Telegram, separate Bot release, metrics, full stop and reset');
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));await auth?.close();await smtp?.close();await store?.close();
    const admin=await createDatabase({...env,DB_DATABASE:process.env.DB_DATABASE,DB_AUTO_CREATE_DATABASE:'false'});try{await admin.pool.query(`DROP DATABASE ${env.DB_TYPE==='postgresql'?'"'+database+'"':'`'+database+'`'}`);}finally{await admin.pool.end();}
  }
});
