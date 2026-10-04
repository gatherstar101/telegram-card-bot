import { digest } from '../../auto-register/api/auth.js';
import { Failure } from '../../auto-register/api/errors.js';
import { credentials,integer,audit } from './security.js';

const keyPattern=/^[A-Za-z0-9_-]{1,64}$/;
const canonical=value=>JSON.stringify(value); // all accepted task fields are scalar and validated on submission
export class JobQueue {
  constructor(ctx,env,store,execute) {
    this.ctx=ctx;this.env=env;this.store=store;this.execute=execute;this.crypto=credentials(env);this.active=null;this.running=false;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,user_id TEXT NOT NULL,auth_version INTEGER NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,effect TEXT,result TEXT,error TEXT,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,next_at)');
  }
  row(id){return this.ctx.storage.sql.exec('SELECT * FROM jobs WHERE id=?',id).toArray()[0];}
  async view(row) {
    if(!row)throw new Failure(404,'任务不存在');
    return {job_id:row.id,account_id:row.account_id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,
      ...(row.result?{result:JSON.parse(this.crypto.open(row.result,`job:${row.id}:result`))}:{}),
      ...(row.error?{error:JSON.parse(row.error)}:{}),
    };
  }
  async get(id,user,account) {
    const row=this.row(id);
    if(!row||row.user_id!==user.id||row.account_id!==account)throw new Failure(404,'任务不存在');
    return this.view(row);
  }
  async enqueue(path,body,user,account) {
    const allowed=/\/bots$/.test(path)?['name','username','request_key']:/\/channels$/.test(path)?['title','about','bot_username','request_key']:/\/posts$/.test(path)?['text','request_key']:/\/channels\/[^/]+\/reconcile$/.test(path)?['channel_id','access_hash','request_key']:['request_key'];
    if(Object.keys(body).some(key=>!allowed.includes(key))||Object.values(body).some(value=>typeof value!=='string'))throw new Failure(400,'任务参数必须为受支持的字符串字段');
    body=Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b)));
    if(/\/bots$/.test(path)) {
      body.name=body.name??this.env.TG_BOT_NAME;body.username=body.username??this.env.TG_BOT_USERNAME;
      if(typeof body.name!=='string'||!body.name.trim()||body.name.length>64||! /^[a-z][a-z0-9_]{4,31}$/i.test(body.username||'')||!/bot$/i.test(body.username))throw new Failure(400,'机器人名称或用户名格式错误');
    }
    if(/\/channels$/.test(path)&&(!body.title?.trim()||body.title.length>128||typeof body.bot_username!=='string'||body.bot_username.length>32||(body.about||'').length>255))throw new Failure(400,'Channel 参数无效');
    if(/\/posts$/.test(path)&&(!body.text?.trim()||body.text.length>3000))throw new Failure(400,'帖子 text 必须为 1–3000 字符');
    const requestKey=body.request_key??body.username??this.env.TG_BOT_USERNAME;
    if(typeof requestKey!=='string'||!keyPattern.test(requestKey))throw new Failure(400,'需要 1–64 位 request_key，Bot 默认使用 username');
    if(!await this.store.ownsAccount(user.id,account))throw new Failure(404,'账号不存在');
    const state=await this.store.getAccount(account);
    if(state.status!=='authorized')throw new Failure(401,'请先完成 Telegram 登录');
    const id=digest(`${account}:${path}:${requestKey}`);
    const fingerprint=digest(canonical(Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b)))));
    const result=this.ctx.storage.transactionSync(()=>{
      const existing=this.row(id);
      if(existing) {
        if(existing.fingerprint!==fingerprint)throw new Failure(409,'request_key 已用于不同参数');
        return existing;
      }
      if(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").one().n>=integer(this.env,'JOB_QUEUE_LIMIT',20,1,100))throw new Failure(429,'账号任务队列已满');
      if(/\/bots$|\/channels$/.test(path)&&this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='uncertain'").one().n)throw new Failure(409,'请先核对结果不确定的任务');
      const now=Date.now();
      this.ctx.storage.sql.exec('INSERT INTO jobs(id,account_id,user_id,auth_version,path,body,fingerprint,status,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,account,user.id,user.auth_version||0,path,this.crypto.seal(JSON.stringify(body),`job:${id}:body`),fingerprint,'queued',now+1000,now,now);
      return this.row(id);
    });
    await this.schedule();
    audit('job_enqueued',{job_id:id,user_id:user.id,account_id:account});
    return this.view(result);
  }
  async checkpoint(effect) {
    if(!this.active)return;
    this.ctx.storage.sql.exec('UPDATE jobs SET effect=?,updated_at=? WHERE id=?',effect,Date.now(),this.active);
  }
  async known(row) {
    const body=JSON.parse(this.crypto.open(row.body,`job:${row.id}:body`));
    const state=await this.store.getAccount(row.account_id);
    if(state?.pending_bot) {
      if(!await this.store.get(row.account_id,state.pending_bot.username))await this.store.save(row.account_id,state.pending_bot);
    }
    if(state?.pending_channel)await this.store.saveChannel(row.account_id,state.pending_channel.request_key,state.pending_channel);
    if(/\/bots$/.test(row.path))return this.store.get(row.account_id,body.username??this.env.TG_BOT_USERNAME);
    if(/\/channels$/.test(row.path)) {
      const c=await this.store.getChannel(row.account_id,body.request_key);
      if(c?.status==='ready'){const {access_hash,posts,...result}=c;return {...result,bot_url:`https://t.me/${c.bot_username}?start=channel`};}
    }
    if(/\/posts$/.test(row.path)) {
      const channel=row.path.split('/').at(-2);
      const post=await this.store.getPost(row.account_id,channel,body.request_key);
      if(post?.status==='sent')return post;
    }
    return null;
  }
  finish(id,status,result,error=null) {
    this.ctx.storage.sql.exec('UPDATE jobs SET status=?,result=?,error=?,updated_at=? WHERE id=?',status,result===null?null:this.crypto.seal(JSON.stringify(result),`job:${id}:result`),error?JSON.stringify(error):null,Date.now(),id);
    audit('job_finished',{job_id:id,status});
  }
  async retry(id,user,account) {
    const row=this.row(id);
    if(!row||row.user_id!==user.id||row.account_id!==account)throw new Failure(404,'任务不存在');
    if(!['failed','uncertain','cancelled'].includes(row.status))throw new Failure(409,'任务当前状态不支持重试');
    const known=await this.known(row);
    if(known){this.finish(id,'succeeded',known);return this.get(id,user,account);}
    let safe=!row.effect||row.effect==='post_send';
    if(row.effect==='channel_create') {
      const body=JSON.parse(this.crypto.open(row.body,`job:${id}:body`));
      const channel=await this.store.getChannel(account,body.request_key);
      safe=channel?.status==='created'||!channel;
    }
    if(!safe)throw new Failure(409,'需要先通过 Bot 或 Channel reconcile 接口核对远端结果');
    this.ctx.storage.transactionSync(()=>{
      if(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").one().n>=integer(this.env,'JOB_QUEUE_LIMIT',20,1,100))throw new Failure(429,'账号任务队列已满');
      const current=this.row(id);
      if(!['failed','uncertain','cancelled'].includes(current.status))throw new Failure(409,'任务状态已经改变');
      this.ctx.storage.sql.exec("UPDATE jobs SET status='queued',effect=NULL,error=NULL,auth_version=?,next_at=?,updated_at=? WHERE id=?",user.auth_version||0,Date.now()+1000,Date.now(),id);
    });
    await this.schedule();return this.get(id,user,account);
  }
  async schedule(preserve=true) {
    await this.ctx.storage.transaction(async storage=>{
      const next=this.ctx.storage.sql.exec("SELECT MIN(next_at) AS at FROM jobs WHERE status='queued'").one().at;
      const running=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").one().n;
      const retain=integer(this.env,'JOB_RETENTION_SECONDS',604800,86400,2592000)*1000;
      this.ctx.storage.sql.exec("DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled') AND updated_at<?",Date.now()-retain);
      // Uncertain jobs are retained until explicitly reconciled.
      const count=this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM jobs').one().n;
      const at=next!==null?Math.max(Date.now()+1000,next):running?Date.now()+10000:count?Date.now()+86400000:null;
      const existing=await storage.getAlarm();
      if(at!==null) {if(!preserve||existing===null||at<existing)await storage.setAlarm(at);}
      else await storage.deleteAlarm();
    });
  }

  async alarm() {
    if(this.running)return;
    this.running=true;let failed=false;
    try {
      await this.schedule(); // a future wake-up survives an unexpected process interruption
      for(const row of this.ctx.storage.sql.exec("SELECT * FROM jobs WHERE status='running'").toArray()) {
        const known=await this.known(row);
        if(known)this.finish(row.id,'succeeded',known);
        else if(row.effect)this.finish(row.id,'uncertain',null,{status:409,code:'REMOTE_RESULT_UNKNOWN'});
        else this.ctx.storage.sql.exec("UPDATE jobs SET status='queued',next_at=? WHERE id=?",Date.now(),row.id);
      }
      const row=this.ctx.storage.sql.exec("SELECT * FROM jobs WHERE status='queued' AND next_at<=? ORDER BY created_at LIMIT 1",Date.now()).toArray()[0];
      if(!row)return;
      const user=await this.store.userById(row.user_id);
      if(!user||user.disabled||(user.auth_version||0)!==row.auth_version||!await this.store.ownsAccount(row.user_id,row.account_id)) {
        this.finish(row.id,'cancelled',null,{status:401,code:'AUTH_REVOKED'});return;
      }
      this.ctx.storage.sql.exec("UPDATE jobs SET status='running',updated_at=? WHERE id=?",Date.now(),row.id);
      this.active=row.id;
      await this.ctx.storage.setAlarm(Date.now()+10000);
      try {
        const body=JSON.parse(this.crypto.open(row.body,`job:${row.id}:body`));
        const result=await this.execute('POST',row.path,body,user);
        this.finish(row.id,'succeeded',result);
      } catch(error) {
        const current=this.row(row.id);
        const known=await this.known(current);
        if(known)this.finish(row.id,'succeeded',known);
        else {
          if(error.remote_rejected){this.ctx.storage.sql.exec('UPDATE jobs SET effect=NULL WHERE id=?',row.id);current.effect=null;}
          // Local response parsing and Bot API verification failures after a
          // checkpoint can also mean the resource was already created.
          const uncertain=Boolean(current.effect)&&!error.errorMessage;
          this.finish(row.id,uncertain?'uncertain':'failed',null,{status:error.status|| (error.errorMessage?.startsWith('FLOOD_WAIT')?429:502),code:uncertain?'REMOTE_RESULT_UNKNOWN':'OPERATION_FAILED'});
        }
      } finally {this.active=null;}
    } catch(error) {
      failed=true;
      audit('job_alarm_error',{kind:'storage_or_runtime'});
      await this.ctx.storage.setAlarm(Date.now()+30000);
    } finally {this.running=false;if(!failed)await this.schedule(false);}
  }
}
