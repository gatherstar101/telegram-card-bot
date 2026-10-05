import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from './auth.js';
import { Failure } from './errors.js';
import { credentials,integer,audit } from './security.js';
import { queueStore,withLease } from './queue-store.js';

export const jobContext=new AsyncLocalStorage();
const parse=value=>typeof value==='string'?JSON.parse(value):value;
export const isTask=path=>/^\/v1\/accounts\/[a-f0-9-]{36}\/(bots|channels|channels\/[A-Za-z0-9_-]+\/posts|bots\/[A-Za-z0-9_]+\/reconcile|channels\/[A-Za-z0-9_-]+\/reconcile)$/.test(path);
export class Jobs {
  constructor(store,auth,env,execute) {this.store=store;this.auth=auth;this.env=env;this.execute=execute;this.crypt=credentials(env);this.queue=queueStore(store,'api_jobs','running');this.lastCleanup=0;}
  view(row){if(!row)throw new Failure(404,'任务不存在');return {job_id:row.id,account_id:row.account_id,status:row.status,created_at:Number(row.created_at),updated_at:Number(row.updated_at),...(row.result?{result:JSON.parse(this.crypt.open(row.result,`job:${row.id}:result`))}:{}),...(row.error?{error:parse(row.error)}:{})};}
  async get(id,user,account){const row=await this.queue.one('SELECT * FROM api_jobs WHERE id=? AND user_id=? AND account_id=?',[id,user.id,account]);if(!row)throw new Failure(404,'任务不存在');return row;}
  async enqueue(path,body,user,account,binding=null) {
    const allowed=/\/bots$/.test(path)?['name','username','request_key']:/\/channels$/.test(path)?['title','about','bot_username','request_key']:/\/posts$/.test(path)?['text','request_key']:/\/channels\/[^/]+\/reconcile$/.test(path)?['channel_id','access_hash','request_key']:['request_key'];
    if(Object.keys(body).some(k=>!allowed.includes(k))||Object.values(body).some(v=>typeof v!=='string'))throw new Failure(400,'任务参数必须为受支持的字符串字段');
    body={...body};
    if(/\/bots$/.test(path)){body.name??=this.env.TG_BOT_NAME;body.username??=this.env.TG_BOT_USERNAME;if(typeof body.name!=='string'||!body.name.trim()||body.name.length>64||! /^[a-z][a-z0-9_]{4,31}$/i.test(body.username||'')||!/bot$/i.test(body.username))throw new Failure(400,'机器人名称或用户名格式错误');}
    if(/\/channels$/.test(path)&&(!body.title?.trim()||body.title.length>128||!body.bot_username?.trim()||body.bot_username.length>32||(body.about||'').length>255))throw new Failure(400,'Channel 参数无效');
    if(/\/posts$/.test(path)&&(!body.text?.trim()||body.text.length>3000))throw new Failure(400,'帖子 text 必须为 1–3000 字符');
    const key=body.request_key??(/\/bots$/.test(path)?body.username:null);
    if(typeof key!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(key))throw new Failure(400,'需要 1–64 位 request_key');
    const state=await this.store.getAccount(account);if(!state||state.user_id!==user.id)throw new Failure(404,'账号不存在');if(state.status!=='authorized')throw new Failure(401,'请先完成 Telegram 登录');
    const phoneKey=digest(state.phone);const id=digest(`${account}:${path}:${key}`);const canonical=JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b))));const fingerprint=digest(canonical);
    const result=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}enqueue:${phoneKey}`,()=>this.store.transaction(async connection=>{
      const one=async(sql,args=[])=>(await connection.execute(sql,args))[0][0]||null;
      await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[user.id]);
      const epoch=await this.store.businessState(user.id,connection);
      const security=await one('SELECT auth_version FROM user_security WHERE user_id=?',[user.id]);
      if(Number(security?.auth_version||0)!==Number(user.auth_version||0))throw new Failure(401,'登录状态已撤销','AUTH_REVOKED');
      if(binding){
        const project=await one('SELECT * FROM project_info WHERE id=? AND user_id=? FOR UPDATE',[binding.project_id,user.id]);
        const run=await one('SELECT * FROM workflow_runs WHERE id=? AND project_id=? AND user_id=? FOR UPDATE',[binding.workflow_id,binding.project_id,user.id]);
        if(!project||project.account_id!==account||project.status!=='active'||project.active_workflow!==run?.id||run?.status!=='running'||Number(run.business_epoch)!==epoch||Number(project.epoch)!==Number(run.project_epoch))throw new Failure(409,'项目流程已停止','PROJECT_INACTIVE','review');
        if(run.lease!==binding.lease||Number(run.lease_until)<=Date.now())throw new Failure(409,'流程租约已失效','WORKFLOW_LEASE_EXPIRED','retry');
        const step=await one('SELECT job_id,status FROM workflow_steps WHERE workflow_id=? AND position=? FOR UPDATE',[run.id,binding.position]);
        if(!step||step.status!=='running'||step.job_id&&step.job_id!==id)throw new Failure(409,'流程步骤状态已改变');
      }
      let row=await one('SELECT * FROM api_jobs WHERE id=? FOR UPDATE',[id]);
      if(row){
        if(row.user_id!==user.id||row.fingerprint!==fingerprint)throw new Failure(409,'request_key 已用于不同参数');
        if(binding&&row.project_id&&row.project_id!==binding.project_id)throw new Failure(409,'任务属于其他项目');
        if(binding&&row.workflow_id!==binding.workflow_id&&row.status==='running')throw new Failure(409,'任务已由其他流程执行');
      }else{
        const count=await one("SELECT COUNT(*) AS n FROM api_jobs WHERE phone_key=? AND status IN ('queued','running')",[phoneKey]);if(Number(count.n)>=integer(this.env,'JOB_QUEUE_LIMIT',20,1,100))throw new Failure(429,'账号任务队列已满');
        if(/\/bots$|\/channels$/.test(path)&&Number((await one("SELECT COUNT(*) AS n FROM api_jobs WHERE phone_key=? AND status='uncertain'",[phoneKey])).n))throw new Failure(409,'请先核对结果不确定的任务');
        const now=Date.now();await connection.execute('INSERT INTO api_jobs(id,account_id,user_id,project_id,workflow_id,phone_key,auth_version,path,body,fingerprint,status,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,account,user.id,binding?.project_id||null,binding?.workflow_id||null,phoneKey,user.auth_version||0,path,this.crypt.seal(canonical,`job:${id}:body`),fingerprint,'queued',now,now,now]);
        row=await one('SELECT * FROM api_jobs WHERE id=?',[id]);
      }
      if(binding){
        await connection.execute('UPDATE api_jobs SET project_id=?,workflow_id=? WHERE id=?',[binding.project_id,binding.workflow_id,id]);
        await connection.execute('UPDATE workflow_steps SET job_id=? WHERE workflow_id=? AND position=?',[id,binding.workflow_id,binding.position]);
      }
      return this.view(row);
    }),30);
    if(result.busy)throw new Failure(409,'任务提交正在处理，请稍后重试');audit('job_enqueued',{job_id:id,user_id:user.id});return result.value;
  }
  async checkpoint(effect){const row=jobContext.getStore();if(row){if(this.store.assertTask)await this.store.assertTask(row.id,row.user_id);if(!await this.queue.update(row,{effect,updated_at:Date.now()},true))throw new Failure(409,'任务租约已失效');row.effect=effect;}}
  async known(row){
    const body=JSON.parse(this.crypt.open(row.body,`job:${row.id}:body`));const state=await this.store.getAccount(row.account_id);
    if(state?.pending_bot&&!await this.store.get(row.account_id,state.pending_bot.username))await this.store.save(row.account_id,state.pending_bot);
    if(state?.pending_channel)await this.store.saveChannel(row.account_id,state.pending_channel.request_key,state.pending_channel);
    if(/\/bots$/.test(row.path))return this.store.get(row.account_id,body.username);
    if(/\/channels$/.test(row.path)){const c=await this.store.getChannel(row.account_id,body.request_key);if(c?.status==='ready'){const {access_hash,posts,...result}=c;const source=/^[a-f0-9-]{36}-(test|production)$/.test(c.request_key||'')?c.request_key:'channel';return {...result,bot_url:`https://t.me/${c.bot_username}?start=${source}`};}}
    if(/\/posts$/.test(row.path)){const p=await this.store.getPost(row.account_id,row.path.split('/').at(-2),body.request_key);if(p?.status==='sent')return p;}
    return null;
  }
  async finish(row,status,result,error=null,leased=true){await this.queue.update(row,{status,result:result===null?null:this.crypt.seal(JSON.stringify(result),`job:${row.id}:result`),error:error?JSON.stringify(error):null,lease:null,lease_until:0,updated_at:Date.now()},leased);audit('job_finished',{job_id:row.id,status});}
  async retry(id,user,account){
    const row=await this.get(id,user,account);if(!['failed','uncertain','cancelled'].includes(row.status))throw new Failure(409,'当前状态不可重试');
    const lock=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}enqueue:${row.phone_key}`,async()=>{
      const current=await this.get(id,user,account);if(!['failed','uncertain','cancelled'].includes(current.status))throw new Failure(409,'任务状态已改变');
      const known=await this.known(current);if(known){await this.finish(current,'succeeded',known,null,false);return this.view(await this.get(id,user,account));}
      let safe=!current.effect||current.effect==='post_send';
      if(current.effect==='channel_create'){const body=JSON.parse(this.crypt.open(current.body,`job:${id}:body`));const c=await this.store.getChannel(account,body.request_key);safe=!c||c.status==='created';}
      if(!safe)throw new Failure(409,'需要先通过 reconcile 核对远端结果');
      if(Number((await this.queue.one("SELECT COUNT(*) AS n FROM api_jobs WHERE phone_key=? AND status IN ('queued','running')",[row.phone_key])).n)>=integer(this.env,'JOB_QUEUE_LIMIT',20,1,100))throw new Failure(429,'账号任务队列已满');
      await this.queue.update(current,{status:'queued',effect:null,error:null,auth_version:user.auth_version||0,next_at:Date.now(),updated_at:Date.now()});return this.view(await this.get(id,user,account));
    },30);if(lock.busy)throw new Failure(409,'任务正在处理');return lock.value;
  }
  async runOnce(){
    if(Date.now()-this.lastCleanup>3600000){await this.queue.cleanup(integer(this.env,'JOB_RETENTION_SECONDS',604800,86400,2592000));this.lastCleanup=Date.now();}
    const seconds=integer(this.env,'JOB_TIMEOUT_SECONDS',240,30,240)+60;const row=await this.queue.claim(seconds);if(!row)return;
    const heartbeat=setInterval(()=>this.queue.heartbeat(row,seconds).catch(()=>audit('job_lease_error')),30000);heartbeat.unref();
    try{
      const user=await this.store.userById(row.user_id);if(!user||user.disabled||Number(user.auth_version||0)!==Number(row.auth_version)||!await this.store.ownsAccount(row.user_id,row.account_id)){await this.finish(row,'cancelled',null,{status:401,code:'AUTH_REVOKED'});return;}
      if(this.store.assertTask)try{await this.store.assertTask(row.id,row.user_id);}catch(error){await this.finish(row,'cancelled',null,{status:error.status,code:error.code});return;}
      const lock=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}job-phone:${row.phone_key}`,async()=>{
        if(row.previous_status==='running'){const known=await this.known(row);if(known){await this.finish(row,'succeeded',known);return;}if(row.effect){await this.finish(row,'uncertain',null,{status:409,code:'REMOTE_RESULT_UNKNOWN'});return;}}
        const body=JSON.parse(this.crypt.open(row.body,`job:${row.id}:body`));
        const action=()=>jobContext.run(row,()=>this.execute('POST',row.path,body,user));
        const kind=/\/bots$/.test(row.path)?'bot':/\/channels$/.test(row.path)?'channel':null;
        try{
          let result;
          if(kind){const quota=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}create-user:${user.id}`,async()=>{
            const existing=kind==='bot'?await this.store.get(row.account_id,body.username):await this.store.getChannel(row.account_id,body.request_key);
            const count=kind==='bot'?await this.store.botCount(user.id):await this.store.channelCount(user.id);
            const name=kind==='bot'?'MAX_BOTS_PER_USER':'MAX_CHANNELS_PER_USER';const maximum=this.store.userLimit?await this.store.userLimit(user.id,name):integer(this.env,name,kind==='bot'?20:50,1,1000);
            if(!existing&&count>=maximum)throw new Failure(429,'资源数量达到配额','RESOURCE_QUOTA','review');return action();
          });if(quota.busy)throw new Failure(409,'用户已有创建操作');result=quota.value;}else result=await action();
          await this.finish(row,'succeeded',result);
        }catch(error){const known=await this.known(row);if(known){await this.finish(row,'succeeded',known);return;}if(error.remote_rejected){row.effect=null;await this.queue.update(row,{effect:null},true);}const uncertain=Boolean(row.effect)&&!error.errorMessage;const stopped=['USER_DISABLED','BUSINESS_REVOKED','PROJECT_INACTIVE'].includes(error.code);await this.finish(row,uncertain?'uncertain':stopped?'cancelled':'failed',null,{status:error.status||502,code:uncertain?'REMOTE_RESULT_UNKNOWN':error.code||'OPERATION_FAILED'});}
      });
      if(lock.busy)await this.queue.update(row,{status:row.previous_status==='running'?'running':'queued',lease:null,lease_until:Date.now()+1000,next_at:Date.now()+1000},true);
    }finally{clearInterval(heartbeat);}
  }
}
