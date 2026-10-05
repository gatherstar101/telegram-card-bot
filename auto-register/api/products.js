import { randomUUID } from 'node:crypto';
import { Failure, errorDetails } from './errors.js';
import { integer, credentials,audit } from './security.js';
import { landingConfig,botApi } from './conversion.js';
import { workflowContext } from './execution-context.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const text=(value,name,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Failure(400,`${name} 格式无效`);return value.trim();};
export function projectInput(body) {
  const allowed=['account_id','name','customer_id','test_bot','production_bot','landing_url','card_text','card_image','button_text','test_user_ids','channel'];
  if(Object.keys(body).some(key=>!allowed.includes(key))||!uuid(body.account_id))throw new Failure(400,'项目参数或 account_id 无效');
  const bot=(value)=>{if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['name','username'].includes(key)))throw new Failure(400,'需要测试和生产 Bot 信息');const username=text(value.username,'username',32);if(!/^[a-z][a-z0-9_]{4,31}$/i.test(username)||!/bot$/i.test(username))throw new Failure(400,'Bot 用户名无效');return {name:text(value.name,'Bot name',64),username};};
  const test=bot(body.test_bot),production=bot(body.production_bot);
  if(test.username.toLowerCase()===production.username.toLowerCase())throw new Failure(400,'测试与生产必须使用不同 Bot');
  if(!Array.isArray(body.test_user_ids)||body.test_user_ids.length<1||body.test_user_ids.length>100||body.test_user_ids.some(id=>typeof id!=='string'||!/^\d{1,16}$/.test(id)))throw new Failure(400,'test_user_ids 必须为 1–100 个 Telegram 数字用户 ID 字符串');
  const {webhook_secret,...landing}=landingConfig(body);
  let channel=null;
  if(body.channel!==undefined&&body.channel!==null){if(typeof body.channel!=='object'||Object.keys(body.channel).some(key=>!['title','about','post_text'].includes(key)))throw new Failure(400,'Channel 配置无效');channel={title:text(body.channel.title,'channel title',128),about:body.channel.about||'',post_text:body.channel.post_text?text(body.channel.post_text,'post_text',3000):null};if(typeof channel.about!=='string'||channel.about.length>255)throw new Failure(400,'Channel about 无效');}
  return {account_id:body.account_id,name:text(body.name,'name',128),customer_id:landing.customer_id,config:{test_bot:test,production_bot:production,landing,test_user_ids:[...new Set(body.test_user_ids)],channel}};
}

export class Products {
  constructor(store,auth,jobs,service,env,fetcher=fetch) {Object.assign(this,{store,auth,jobs,service,env,fetcher});this.crypt=credentials(env);this.lastCleanup=0;}
  async one(sql,args=[],connection=this.store.pool) {return (await connection.execute(sql,args))[0][0]||null;}
  async rows(sql,args=[]) {return (await this.store.pool.execute(sql,args))[0];}
  async projectView(user,id) {const project=await this.store.project(user.id,id);return {...project,config:await this.store.projectConfig(id,project.draft_version),resources:await this.store.resources(id)};}
  async workflowView(user,projectId,id) {
    await this.store.project(user.id,projectId);
    const run=await this.one('SELECT * FROM workflow_runs WHERE id=? AND project_id=? AND user_id=?',[id,projectId,user.id]);if(!run)throw new Failure(404,'流程不存在');
    const steps=await this.rows('SELECT position,code,status,attempts,job_id,started_at,completed_at,error FROM workflow_steps WHERE workflow_id=? ORDER BY position',[id]);
    return {workflow_id:id,project_id:projectId,environment:run.environment,version:run.version,status:run.status,completed_steps:steps.filter(step=>step.status==='succeeded').length,total_steps:steps.length,stage:steps.find(step=>step.status!=='succeeded')?.code||null,next_action:run.status==='waiting_test'?'test_and_confirm':run.status==='needs_reconciliation'?'reconcile':run.status==='failed'?'review_and_retry':run.status==='suspended'?'resume_and_retry':null,steps:steps.map(step=>({...step,error:typeof step.error==='string'?JSON.parse(step.error):step.error}))};
  }
  async start(user,projectId,environment,requestedVersion=null) {
    const project=await this.store.project(user.id,projectId);const version=requestedVersion??Number(project.draft_version);const config=await this.store.projectConfig(projectId,version);
    if(project.status!=='active')throw new Failure(409,'项目未启用','PROJECT_INACTIVE','review');
    const epoch=await this.store.assertBusiness(user.id);
    const account=await this.store.getAccount(project.account_id);if(account?.status!=='authorized')throw new Failure(401,'Telegram 登录已失效','TELEGRAM_SESSION_EXPIRED','reauthenticate');
    if(environment==='production'&&requestedVersion===null&&Number(project.tested_version)!==Number(project.draft_version))throw new Failure(409,'请先验证当前草稿版本','TEST_REQUIRED','test_and_confirm');
    const id=randomUUID(),now=Date.now();
    await this.store.transaction(async connection=>{
      // All project operations take user -> project locks, matching disable.
      await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[user.id]);
      if(await this.store.businessState(user.id,connection)!==epoch)throw new Failure(409,'用户业务状态已改变');
      const locked=await this.one('SELECT * FROM project_info WHERE id=? AND user_id=? FOR UPDATE',[projectId,user.id],connection);
      if(locked.status!=='active'||Number(locked.draft_version)!==Number(project.draft_version))throw new Failure(409,'项目配置已改变');
      if(locked.active_workflow)throw new Failure(409,'项目已有执行流程');
      if(environment==='production'&&requestedVersion===null&&Number(locked.tested_version)!==Number(locked.draft_version))throw new Failure(409,'当前版本尚未验收');
      if(requestedVersion!==null&&!await this.one("SELECT id FROM workflow_runs WHERE project_id=? AND environment='production' AND version=? AND status='succeeded'",[projectId,version],connection))throw new Failure(409,'只能回滚到曾成功发布的版本');
      const n=await this.one("SELECT COUNT(*) AS n FROM workflow_runs WHERE user_id=? AND status IN ('queued','running')",[user.id],connection);
      if(Number(n.n)>=await this.store.userLimit(user.id,'MAX_ACTIVE_WORKFLOWS_PER_USER',connection))throw new Failure(429,'开通并发达到配额','WORKFLOW_QUOTA','wait');
      const resource=await this.one("SELECT bot_id FROM project_resources WHERE project_id=? AND environment=? AND kind='bot'",[projectId,environment],connection);
      const pending=await this.one("SELECT COUNT(*) AS n FROM workflow_runs WHERE user_id=? AND status IN ('queued','running')",[user.id],connection);
      if(!resource&&await this.store.botCount(user.id,connection)+Number(pending.n)>=await this.store.userLimit(user.id,'MAX_BOTS_PER_USER',connection))throw new Failure(429,'Bot 配额不足','RESOURCE_QUOTA','review');
      if(config.channel&&!await this.store.resource(projectId,environment,'channel',connection)&&await this.store.channelCount(user.id,connection)+Number(pending.n)>=await this.store.userLimit(user.id,'MAX_CHANNELS_PER_USER',connection))throw new Failure(429,'Channel 配额不足','RESOURCE_QUOTA','review');
      await connection.execute('INSERT INTO workflow_runs(id,project_id,user_id,environment,version,status,business_epoch,project_epoch,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,projectId,user.id,environment,version,'queued',epoch,locked.epoch,now,now,now]);
      const steps=['create_bot','configure_landing','register_webhook','verify_webhook',...(config.channel?['create_channel',...(config.channel.post_text?['publish_post']:[])]:[]),...(environment==='test'?['confirm_test']:[])];
      for(let position=0;position<steps.length;position++)await connection.execute('INSERT INTO workflow_steps(workflow_id,position,code,status) VALUES(?,?,?,?)',[id,position,steps[position],'queued']);
      await connection.execute('UPDATE project_info SET active_workflow=?,updated_at=? WHERE id=?',[id,now,projectId]);
    });
    return this.workflowView(user,projectId,id);
  }
  async route(method,path,url,body,user) {
    if(method==='GET'&&path==='/v1/me/limits')return this.store.userLimits(user.id);
    if(method==='GET'&&path==='/v1/onboarding'){
      const apps=await this.store.telegramApps(user.id);const accounts=await this.store.accountsForUser(user.id);const projects=await this.store.projects(user.id);
      const stage=!apps.length?'configure_telegram_app':!accounts.some(account=>account.status==='authorized')?'authenticate_telegram':!projects.length?'configure_project':'manage_projects';
      return {stage,app_configured:apps.length>0,telegram_authorized:accounts.some(account=>account.status==='authorized'),accounts,projects};
    }
    const appMatch=path.match(/^\/v1\/telegram-apps(?:\/([a-f0-9-]{36}))?$/);
    if(appMatch){const id=appMatch[1];if(method==='GET'&&!id){const after=this.cursor(url);const apps=await this.store.telegramApps(user.id,after);return {apps,next_cursor:apps.length===100?apps.at(-1).id:null};}
      if((method==='POST'&&!id)||(method==='PATCH'&&id)){if(Object.keys(body).some(key=>!['name','api_id','api_hash'].includes(key))||!Number.isSafeInteger(Number(body.api_id))||Number(body.api_id)<1||! /^[a-f0-9]{32}$/i.test(body.api_hash||''))throw new Failure(400,'App 配置无效');return this.store.putTelegramApp(user.id,id||randomUUID(),{name:text(body.name,'name',64),api_id:Number(body.api_id),api_hash:body.api_hash,update:method==='PATCH',maximum:await this.store.userLimit(user.id,'MAX_TG_APPS_PER_USER')});}
      throw new Failure(404,'接口不存在');
    }
    const match=path.match(/^\/v1\/projects(?:\/([a-f0-9-]{36})(?:\/(.*))?)?$/);if(!match)return undefined;
    const [,id,suffix='']=match;
    if(method==='GET'&&!id){const list=await this.store.projects(user.id,this.cursor(url));return {projects:list,next_cursor:list.length===100?list.at(-1).id:null};}
    if((method==='POST'&&!id)||(method==='PUT'&&id&&!suffix)){
      const input=projectInput(body);input.update=method==='PUT';
      if(id){const project=await this.store.project(user.id,id);const resources=await this.store.resources(project.id);for(const resource of resources.filter(r=>r.kind==='bot')){const previous=(await this.store.projectConfig(id,project.draft_version))[`${resource.environment}_bot`];const next=input.config[`${resource.environment}_bot`];if(next.username.toLowerCase()!==resource.username.toLowerCase()||next.name!==previous.name)throw new Failure(409,'已创建的 Bot 名称和用户名不能通过修改草稿替换');}if(resources.some(resource=>resource.kind==='channel')){const old=(await this.store.projectConfig(id,project.draft_version)).channel;if(!input.config.channel||old.title!==input.config.channel.title||old.about!==input.config.channel.about)throw new Failure(409,'已有频道的 title/about 不能通过修改草稿替换');}}
      return this.store.saveProject(user.id,id||randomUUID(),input,await this.store.userLimit(user.id,'MAX_PROJECTS_PER_USER'));
    }
    if(!id)throw new Failure(404,'接口不存在');
    const project=await this.store.project(user.id,id);
    if(method==='GET'&&!suffix)return this.projectView(user,id);
    if(method==='GET'&&suffix==='preview'){const config=await this.store.projectConfig(id,project.draft_version);return {version:project.draft_version,test_bot:config.test_bot,production_bot:config.production_bot,card:config.landing,channel:config.channel};}
    if(method==='POST'&&['provision','publish'].includes(suffix))return this.start(user,id,suffix==='publish'?'production':'test');
    if(method==='POST'&&suffix==='rollback'){if(!Number.isInteger(body.version)||body.version<1||body.confirmed!==true)throw new Failure(400,'需要 version 和 confirmed=true');return this.start(user,id,'production',body.version);}
    if(method==='GET'&&suffix==='workflows'){const after=this.cursor(url);const workflows=await this.rows('SELECT id,environment,version,status,created_at,updated_at FROM workflow_runs WHERE project_id=? AND user_id=? AND id>? ORDER BY id LIMIT 100',[id,user.id,after]);return {workflows,next_cursor:workflows.length===100?workflows.at(-1).id:null};}
    if(method==='GET'&&suffix==='versions'){const versions=await this.rows('SELECT version,created_at FROM project_versions WHERE project_id=? ORDER BY version DESC LIMIT 100',[id]);return {versions};}
    const runMatch=suffix.match(/^workflows\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/);
    if(runMatch){const [,runId,action]=runMatch;if(method==='GET'&&!action)return this.workflowView(user,id,runId);if(method==='POST'&&action)return this.changeRun(user,project,runId,action);}
    if(method==='POST'&&suffix==='test-confirmation')return this.confirmTest(user,project,body);
    if(method==='GET'&&suffix==='events'){const events=await this.store.events(user.id,id,this.cursor(url));return {events,next_cursor:events.length===100?events.at(-1).id:null};}
    if(method==='GET'&&suffix==='statistics')return {statistics:await this.store.statistics(user.id,id)};
    if(method==='POST'&&suffix==='conversions'){
      if(Object.keys(body).some(key=>!['event_id','source','value','currency'].includes(key)))throw new Failure(400,'成交回传参数无效');
      const eventId=text(body.event_id,'event_id',64);if(body.source!==undefined&&!/^[A-Za-z0-9_-]{1,64}$/.test(body.source))throw new Failure(400,'source 无效');if(body.value!==undefined&&(!Number.isFinite(body.value)||body.value<0))throw new Failure(400,'value 无效');if(body.currency!==undefined&&!/^[A-Z]{3}$/.test(body.currency))throw new Failure(400,'currency 无效');
      const created=await this.store.event({user_id:user.id,project_id:id,environment:'production',type:'conversion_reported',event_key:`conversion:${id}:${eventId}`,source:body.source||null,data:{event_id:eventId,value:body.value??null,currency:body.currency??null}});return {ok:true,duplicate:!created,verification:'customer_reported'};
    }
    if(method==='POST'&&['pause','archive','resume'].includes(suffix)){
      await this.store.transaction(async connection=>{
        await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[user.id]);await this.store.businessState(user.id,connection);
        const locked=await this.one('SELECT * FROM project_info WHERE id=? AND user_id=? FOR UPDATE',[id,user.id],connection);
        if(locked.status==='archived'&&suffix!=='archive')throw new Failure(409,'归档项目不可恢复');
        if(locked.active_workflow)await connection.execute("UPDATE workflow_runs SET status='suspended',updated_at=? WHERE id=?",[Date.now(),locked.active_workflow]);
        await connection.execute("UPDATE webhook_deliveries SET status='cancelled',updated_at=? WHERE status='queued' AND bot_id IN (SELECT bot_id FROM project_resources WHERE project_id=?)",[Date.now(),id]);
        await connection.execute("UPDATE api_jobs SET status='cancelled',updated_at=? WHERE status='queued' AND id IN (SELECT s.job_id FROM workflow_steps s JOIN workflow_runs r ON r.id=s.workflow_id WHERE r.project_id=?)",[Date.now(),id]);
        await connection.execute('UPDATE project_info SET status=?,epoch=epoch+1,active_workflow=NULL,updated_at=? WHERE id=?',[suffix==='resume'?'active':suffix==='archive'?'archived':'paused',Date.now(),id]);
      });return {ok:true,status:suffix==='resume'?'active':suffix==='archive'?'archived':'paused',remote_resources_preserved:true};
    }
    throw new Failure(404,'接口不存在');
  }
  cursor(url) {const value=url.searchParams.get('after')||'';if(value&&!uuid(value))throw new Failure(400,'after 无效');return value;}
  async confirmTest(user,project,body) {
    if(body.confirmed!==true)throw new Failure(400,'需要 confirmed=true');
    const run=await this.one("SELECT * FROM workflow_runs WHERE project_id=? AND user_id=? AND environment='test' AND status='waiting_test' AND id=?",[project.id,user.id,project.active_workflow]);if(!run)throw new Failure(409,'项目尚未进入测试验收');
    const resource=await this.store.resource(project.id,'test','bot');
    const evidence=await this.one("SELECT id FROM business_events WHERE project_id=? AND bot_id=? AND version=? AND type='card_sent' AND environment='test' AND occurred_at>=?",[project.id,resource.bot_id,run.version,run.created_at]);
    if(!evidence)throw new Failure(409,'请先使用白名单测试账号启动 Bot 并确认卡片投递','TEST_REQUIRED','test_bot');
    if(!await this.one("SELECT id FROM business_events WHERE project_id=? AND bot_id=? AND version=? AND type='link_visit' AND environment='test' AND occurred_at>=?",[project.id,resource.bot_id,run.version,run.created_at]))throw new Failure(409,'请先点击测试卡片链接并确认目标页面','TEST_REQUIRED','test_landing');
    await this.store.transaction(async connection=>{
      await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[user.id]);if(await this.store.businessState(user.id,connection)!==Number(run.business_epoch))throw new Failure(409,'业务授权已变更');
      const locked=await this.one('SELECT * FROM project_info WHERE id=? FOR UPDATE',[project.id],connection);if(locked.active_workflow!==run.id||Number(locked.draft_version)!==Number(run.version)||locked.status!=='active')throw new Failure(409,'测试配置已变化');
      await connection.execute("UPDATE workflow_steps SET status='succeeded',completed_at=? WHERE workflow_id=? AND code='confirm_test'",[Date.now(),run.id]);
      await connection.execute("UPDATE workflow_runs SET status='succeeded',updated_at=? WHERE id=?",[Date.now(),run.id]);
      await connection.execute('UPDATE project_info SET tested_version=?,active_workflow=NULL WHERE id=?',[run.version,project.id]);
      await this.store.event({user_id:user.id,project_id:project.id,environment:'test',type:'test_confirmed',event_key:`confirmed:${run.id}`,data:{version:run.version}},connection);
    });return this.workflowView(user,project.id,run.id);
  }
  async changeRun(user,project,id,action) {
    const view=await this.workflowView(user,project.id,id);
    if(action==='retry'&&!['failed','needs_reconciliation','suspended'].includes(view.status))throw new Failure(409,'当前流程不能重试');
    await this.store.transaction(async connection=>{
      await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[user.id]);const epoch=await this.store.businessState(user.id,connection);
      const locked=await this.one('SELECT * FROM project_info WHERE id=? FOR UPDATE',[project.id],connection);
      if(action==='retry'&&(locked.status!=='active'||(locked.active_workflow&&locked.active_workflow!==id)))throw new Failure(409,'请恢复项目后重试');
      const run=await this.one('SELECT * FROM workflow_runs WHERE id=? FOR UPDATE',[id],connection);
      if(Number(run.lease_until)>Date.now())throw new Failure(409,'流程正在执行，请稍后操作');
      if(action==='cancel'&&['succeeded','cancelled'].includes(run.status))throw new Failure(409,'流程已结束');
      if(action==='retry'&&!['failed','needs_reconciliation','suspended'].includes(run.status))throw new Failure(409,'流程状态已变化');
      await connection.execute('UPDATE workflow_runs SET status=?,business_epoch=?,project_epoch=?,next_at=?,updated_at=? WHERE id=?',[action==='retry'?'queued':'cancelled',epoch,locked.epoch,Date.now(),Date.now(),id]);
      if(action==='retry'){
        await connection.execute('UPDATE project_info SET active_workflow=? WHERE id=?',[id,project.id]);
        await connection.execute("UPDATE workflow_steps SET status='queued',error=NULL WHERE workflow_id=? AND status<>'succeeded'",[id]);
      }
      else await connection.execute('UPDATE project_info SET active_workflow=NULL WHERE id=? AND active_workflow=?',[project.id,id]);
      if(action==='cancel')await connection.execute("UPDATE api_jobs SET status='cancelled',updated_at=? WHERE status='queued' AND id IN (SELECT job_id FROM workflow_steps WHERE workflow_id=?)",[Date.now(),id]);
    });
    return this.workflowView(user,project.id,id);
  }
  async claim() {return this.store.transaction(async connection=>{const now=Date.now();const run=await this.one("SELECT * FROM workflow_runs WHERE status IN ('queued','running') AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED",[now,now],connection);if(!run)return null;const lease=randomUUID();await connection.execute("UPDATE workflow_runs SET status='running',lease=?,lease_until=?,updated_at=? WHERE id=?",[lease,now+120000,now,run.id]);return {...run,lease};});}
  async updateRun(run,status) {await this.store.pool.execute("UPDATE workflow_runs SET status=?,lease=NULL,lease_until=0,next_at=?,updated_at=? WHERE id=? AND lease=? AND status='running' AND lease_until>?",[status,Date.now()+1000,Date.now(),run.id,run.lease,Date.now()]);}
  async runOnce() {
    if(Date.now()-this.lastCleanup>3600000){await this.store.cleanProductData(integer(this.env,'BUSINESS_EVENT_RETENTION_DAYS',90,1,3650),integer(this.env,'RAW_UPDATE_RETENTION_DAYS',7,0,90));this.lastCleanup=Date.now();}
    const run=await this.claim();if(!run)return;
    const heartbeat=setInterval(()=>this.store.pool.execute("UPDATE workflow_runs SET lease_until=? WHERE id=? AND lease=? AND status='running' AND lease_until>?",[Date.now()+120000,run.id,run.lease,Date.now()]).catch(()=>audit('workflow_lease_error',{workflow_id:run.id})),30000);heartbeat.unref();
    try{
      await this.store.assertBusiness(run.user_id,run.business_epoch);
      const project=await this.store.project(run.user_id,run.project_id);if(project.status!=='active'||project.active_workflow!==run.id||Number(project.epoch)!==Number(run.project_epoch))throw new Failure(409,'项目已停止','PROJECT_INACTIVE','review');
      const config=await this.store.projectConfig(project.id,run.version);const user=await this.store.userById(run.user_id);
      const step=await this.one("SELECT * FROM workflow_steps WHERE workflow_id=? AND status<>'succeeded' ORDER BY position LIMIT 1",[run.id]);
      if(!step){await this.complete(run,project);return;}
      if(step.code==='confirm_test'){await this.updateRun(run,'waiting_test');return;}
      const owned=" AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=workflow_steps.workflow_id AND r.lease=? AND r.status='running' AND r.lease_until>?)";
      const [started]=await this.store.pool.execute("UPDATE workflow_steps SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,?),error=NULL WHERE workflow_id=? AND position=?"+owned,[Date.now(),run.id,step.position,run.lease,Date.now()]);
      if(!started.affectedRows)throw new Failure(409,'流程租约已失效','WORKFLOW_LEASE_EXPIRED','retry');
      const result=await workflowContext.run(run,()=>this.executeStep(run,project,config,user,step));
      if(result==='pending'){await this.updateRun(run,'running');return;}
      const [completed]=await this.store.pool.execute("UPDATE workflow_steps SET status='succeeded',completed_at=? WHERE workflow_id=? AND position=?"+owned,[Date.now(),run.id,step.position,run.lease,Date.now()]);
      if(!completed.affectedRows)throw new Failure(409,'流程租约已失效','WORKFLOW_LEASE_EXPIRED','retry');
      await this.updateRun(run,'running');
    }catch(error){
      const status=['USER_DISABLED','BUSINESS_REVOKED','PROJECT_INACTIVE'].includes(error.code)?'suspended':error.code==='REMOTE_RESULT_UNKNOWN'?'needs_reconciliation':'failed';
      const details=errorDetails(error,error.status||502);
      await this.store.pool.execute("UPDATE workflow_steps SET status=?,error=? WHERE workflow_id=? AND status='running' AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=workflow_steps.workflow_id AND r.lease=? AND r.status='running' AND r.lease_until>?)",[status,JSON.stringify({...details,message:error.status?error.message:'操作失败，请根据请求记录排查'}),run.id,run.lease,Date.now()]);
      await this.updateRun(run,status);
    }finally{clearInterval(heartbeat);}
  }
  async executeStep(run,project,config,user,step) {
    const base=`/v1/accounts/${project.account_id}`;const bot=config[`${run.environment}_bot`];
    const task=async(path,body)=>{
      let job=step.job_id?await this.jobs.get(step.job_id,user,project.account_id):null;
      if(!job){const accepted=await this.jobs.enqueue(path,body,user,project.account_id,{project_id:project.id,workflow_id:run.id,position:step.position,lease:run.lease});job=await this.jobs.get(accepted.job_id,user,project.account_id);}
      // Retry only after explicit workflow retry reset this linked step to queued.
      // The API transaction never exposes a runnable workflow before this intent.
      if(step.status==='queued'&&step.job_id&&['failed','cancelled','uncertain'].includes(job.status)){
        try{await this.jobs.retry(job.id,user,project.account_id);}catch(error){if(job.status==='uncertain'&&error.status===409)throw new Failure(409,'远端结果不确定，请先核对任务','REMOTE_RESULT_UNKNOWN','reconcile');throw error;}
        job=await this.jobs.get(job.id,user,project.account_id);
      }
      if(['queued','running'].includes(job.status))return false;
      if(job.status==='uncertain')throw new Failure(409,'远端结果不确定，请先核对任务','REMOTE_RESULT_UNKNOWN','reconcile');
      if(['failed','cancelled'].includes(job.status))throw new Failure(502,'步骤任务失败，请检查任务后重试流程','STEP_FAILED','review_and_retry');
      return true;
    };
    if(step.code==='create_bot'){
      const bound=await this.store.resource(project.id,run.environment,'bot');if(bound)return;
      if(!await task(`${base}/bots`,{...bot,request_key:`${project.id}-${run.environment}`}))return 'pending';
      const saved=await this.store.get(project.account_id,bot.username);await this.store.bindResource(project.id,run.environment,'bot',{bot_id:saved.token.split(':')[0],username:saved.username});return;
    }
    if(step.code==='configure_landing'){
      await this.service.route('PUT',`${base}/bots/${bot.username}/landing`,config.landing,user);
      await this.store.pool.execute("UPDATE project_resources SET version=? WHERE project_id=? AND environment=? AND kind='bot'",[run.version,project.id,run.environment]);
      if(run.environment==='test')await this.store.pool.execute('UPDATE project_info SET tested_version=? WHERE id=?',[null,project.id]);return;
    }
    if(step.code==='register_webhook'){await this.service.route('POST',`${base}/bots/${bot.username}/webhook`,{},user);return;}
    const channelKey=`${project.id}-${run.environment}`;
    if(step.code==='create_channel'){
      if(await this.store.resource(project.id,run.environment,'channel'))return;
      if(!await task(`${base}/channels`,{request_key:channelKey,bot_username:bot.username,title:run.environment==='test'?config.channel.title.slice(0,121)+' [TEST]':config.channel.title,about:config.channel.about}))return 'pending';
      const resource=await this.store.resource(project.id,run.environment,'bot');await this.store.bindResource(project.id,run.environment,'channel',{bot_id:resource.bot_id,username:bot.username,channel_key:channelKey});return;
    }
    if(step.code==='publish_post'){if(!await task(`${base}/channels/${channelKey}/posts`,{request_key:`v${run.version}-u${run.business_epoch}-p${run.project_epoch}`,text:config.channel.post_text}))return 'pending';return;}
    if(step.code==='verify_webhook'){
      const saved=await this.store.get(project.account_id,bot.username);
      const info=await this.store.dispatch(user.id,run.business_epoch,'webhook_check',()=>botApi(saved.token,'getWebhookInfo',{},this.fetcher),project.id,run.project_epoch);
      const expected=(await this.store.getLanding(project.account_id,bot.username)).webhook_url;
      if(info.url!==expected||!info.url||info.last_error_date&&info.last_error_date*1000>=run.created_at)throw new Failure(502,'Webhook 尚未健康','WEBHOOK_UNHEALTHY','check_webhook');return;
    }
  }
  async complete(run,project) {
    await this.store.transaction(async connection=>{
      await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[run.user_id]);if(await this.store.businessState(run.user_id,connection)!==Number(run.business_epoch))throw new Failure(409,'业务授权已变更','BUSINESS_REVOKED');
      const locked=await this.one('SELECT * FROM project_info WHERE id=? FOR UPDATE',[project.id],connection);if(locked.active_workflow!==run.id||locked.status!=='active'||Number(locked.epoch)!==Number(run.project_epoch))throw new Failure(409,'项目已停止','PROJECT_INACTIVE');
      const current=await this.one('SELECT status,lease,lease_until FROM workflow_runs WHERE id=? FOR UPDATE',[run.id],connection);
      if(current?.status!=='running'||current.lease!==run.lease||Number(current.lease_until)<=Date.now())throw new Failure(409,'流程租约已失效','WORKFLOW_LEASE_EXPIRED','retry');
      if(await this.one("SELECT position FROM workflow_steps WHERE workflow_id=? AND status<>'succeeded' LIMIT 1",[run.id],connection))throw new Failure(409,'流程步骤尚未完成');
      if(run.environment==='production')await connection.execute('UPDATE project_info SET published_version=? WHERE id=?',[run.version,project.id]);
      await connection.execute('UPDATE project_info SET active_workflow=NULL WHERE id=?',[project.id]);
      await connection.execute("UPDATE workflow_runs SET status='succeeded',lease=NULL,lease_until=0,updated_at=? WHERE id=? AND lease=?",[Date.now(),run.id,run.lease]);
      await this.store.event({user_id:run.user_id,project_id:project.id,environment:run.environment,type:'published',event_key:`published:${run.id}`,data:{version:run.version}},connection);
    });
  }
}
