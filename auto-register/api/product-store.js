import { randomUUID } from 'node:crypto';
import { conflict } from './database.js';
import { digest } from './auth.js';
import { Failure } from './errors.js';
import { integer } from './security.js';

const duplicate = error => ['ER_DUP_ENTRY','23505'].includes(error.code);
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
export const quotaRanges={MAX_TG_APPS_PER_USER:[5,1,100],MAX_PROJECTS_PER_USER:[10,1,1000],MAX_ACTIVE_WORKFLOWS_PER_USER:[2,1,20],MAX_TG_ACCOUNTS_PER_USER:[5,1,100],MAX_BOTS_PER_USER:[20,1,1000],MAX_CHANNELS_PER_USER:[50,1,1000]};
export function installProductStore(store, crypt,env) {
  const {pool,type,transaction}=store;
  const rows=async(sql,args=[],connection=pool)=>(await connection.execute(sql,args))[0];
  const one=async(sql,args=[],connection=pool)=>(await rows(sql,args,connection))[0]||null;
  const upsert=(table,keys,fields)=>conflict(type,table,keys,fields);
  Object.assign(store, {
    async businessState(userId, connection=pool) {
      const user=await one('SELECT u.id,s.disabled,b.epoch FROM user_info u LEFT JOIN user_security s ON s.user_id=u.id LEFT JOIN user_business b ON b.user_id=u.id WHERE u.id=?',[userId],connection);
      if(!user||Boolean(Number(user.disabled)))throw new Failure(403,'用户已禁用，全部业务停止','USER_DISABLED','contact_administrator');
      return Number(user.epoch||0);
    },
    async userLimit(userId,name,connection=pool) {const range=quotaRanges[name];if(!range)throw new Error('Unknown quota');const row=await one('SELECT config FROM user_limits WHERE user_id=?',[userId],connection);const config=row?decode(row.config):{};return integer({...env,[name]:config[name]??env[name]},name,...range);},
    async userLimits(userId) {const row=await one('SELECT config FROM user_limits WHERE user_id=?',[userId]);const overrides=row?decode(row.config):{};const effective={};for(const name of Object.keys(quotaRanges))effective[name]=await this.userLimit(userId,name);return {overrides,effective};},
    async assertBusiness(userId,epoch) {
      const current=await this.businessState(userId);
      if(epoch!==undefined&&Number(epoch)!==current)throw new Failure(409,'业务授权已变更，请重新提交','BUSINESS_REVOKED','review');
      return current;
    },
    async dispatch(userId,epoch,kind,action,projectId=null,projectEpoch=undefined) {
      // Admission is serialized with administrator updates on the user row.
      const id=randomUUID();
      await transaction(async connection=>{
        await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[userId]);
        const current=await this.businessState(userId,connection);
        if(epoch!==undefined&&current!==Number(epoch))throw new Failure(409,'业务授权已变更','BUSINESS_REVOKED','review');
        if(projectId){const project=await one('SELECT status,epoch FROM project_info WHERE id=? AND user_id=?',[projectId,userId],connection);if(project?.status!=='active'||projectEpoch!==undefined&&Number(project.epoch)!==Number(projectEpoch))throw new Failure(409,'项目已停止或授权已变更','PROJECT_INACTIVE','review');}
        await connection.execute('INSERT INTO business_dispatches(id,user_id,kind,status,started_at) VALUES(?,?,?,?,?)',[id,userId,kind,'admitted',Date.now()]);
      });
      try{const result=await action();await pool.execute("UPDATE business_dispatches SET status='completed',completed_at=? WHERE id=?",[Date.now(),id]);return result;}
      catch(error){await pool.execute("UPDATE business_dispatches SET status='failed',completed_at=? WHERE id=?",[Date.now(),id]);throw error;}
    },
    async stopBusiness(userId,reason,connection=pool) {
      const now=Date.now();
      await connection.execute('INSERT INTO user_business(user_id,epoch,reason,updated_at) VALUES(?,1,?,?)'+conflict(type,'user_business',['user_id'],['reason','updated_at'],['epoch=user_business.epoch+1']),[userId,reason||null,now]);
      await connection.execute("UPDATE api_jobs SET status='cancelled',updated_at=? WHERE user_id=? AND status='queued'",[now,userId]);
      const botColumn=type==='postgresql'?'CAST(telegram_bot_id AS VARCHAR(32))':'CAST(telegram_bot_id AS CHAR)';
      await connection.execute(`UPDATE webhook_deliveries SET status='cancelled',updated_at=? WHERE status='queued' AND bot_id IN (SELECT ${botColumn} FROM bot_info WHERE user_id=?)`,[now,userId]);
      await connection.execute("UPDATE workflow_runs SET status='suspended',updated_at=? WHERE user_id=? AND status IN ('queued','running','waiting_test','needs_reconciliation','failed')",[now,userId]);
      await connection.execute('UPDATE project_info SET active_workflow=NULL WHERE user_id=?',[userId]);
    },
    async putTelegramApp(userId,id,input) {
      return transaction(async connection=>{
        await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[userId]);
        await this.businessState(userId,connection);
        const existing=await one('SELECT * FROM telegram_apps WHERE id=? AND user_id=?',[id,userId],connection);
        if(input.update&&!existing)throw new Failure(404,'App 配置不存在');
        if(!existing&&Number((await one('SELECT COUNT(*) AS n FROM telegram_apps WHERE user_id=?',[userId],connection)).n)>=input.maximum)throw new Failure(429,'App 配置达到配额','RESOURCE_QUOTA','review');
        const now=Date.now();
        await connection.execute('INSERT INTO telegram_apps(id,user_id,name,api_id,api_hash,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'+upsert('telegram_apps',['id'],['name','api_id','api_hash','version','updated_at']),[id,userId,input.name,input.api_id,crypt.seal(input.api_hash,`app:${id}:api_hash`),(existing?.version||0)+1,existing?.created_at||now,now]);
        return {id,name:input.name,api_id:input.api_id,version:(existing?.version||0)+1,status:'configured'};
      });
    },
    async telegramApps(userId,after='') {return rows('SELECT id,name,api_id,version,created_at,updated_at FROM telegram_apps WHERE user_id=? AND id>? ORDER BY id LIMIT 100',[userId,after]);},
    async telegramApp(userId,id) {const row=await one('SELECT * FROM telegram_apps WHERE id=? AND user_id=?',[id,userId]);if(!row)throw new Failure(404,'App 配置不存在');return {...row,api_id:Number(row.api_id),api_hash:crypt.open(row.api_hash,`app:${id}:api_hash`)};},
    async claimPhone(userId,phone,suggestedId) {
      const key=digest(phone);const found=await one('SELECT * FROM telegram_phone_claims WHERE phone_key=?',[key]);
      if(found){if(found.user_id!==userId)throw new Failure(409,'该 Telegram 账号已绑定其他用户','IDENTITY_CONFLICT','contact_administrator');return found.account_id;}
      // Backfill only the requested phone; legacy credentials remain encrypted.
      let account=suggestedId;
      let after='';
      while(true){const legacy=await rows("SELECT account_id,user_id,phone FROM tg_info WHERE (status='authorized' OR user_id=?) AND account_id>? ORDER BY account_id LIMIT 100",[userId,after]);for(const item of legacy)if(crypt.open(item.phone,`tg:${item.account_id}:phone`)===phone){if(item.user_id!==userId)throw new Failure(409,'该 Telegram 账号已绑定其他用户','IDENTITY_CONFLICT','contact_administrator');account=item.account_id;}if(legacy.length<100)break;after=legacy.at(-1).account_id;}
      return account;
    },
    async recordIdentity(userId,accountId,me,phone) {
      const telegramId=String(me.id);
      if(!/^\d{1,20}$/.test(telegramId))throw new Failure(502,'Telegram 身份返回无效');
      const existing=await one('SELECT user_id,account_id FROM telegram_identities WHERE telegram_user_id=?',[telegramId]);
      if(existing&&(existing.user_id!==userId||existing.account_id!==accountId))throw new Failure(409,'Telegram 身份已绑定其他账号','IDENTITY_CONFLICT','contact_administrator');
      const profile={id:telegramId,username:me.username||null,first_name:me.firstName??me.first_name??null,last_name:me.lastName??me.last_name??null};
      try{
        const encrypted=crypt.seal(JSON.stringify(profile),`identity:${telegramId}`);
        if(existing)await pool.execute('UPDATE telegram_identities SET profile=?,updated_at=? WHERE telegram_user_id=? AND user_id=? AND account_id=?',[encrypted,Date.now(),telegramId,userId,accountId]);
        else await pool.execute('INSERT INTO telegram_identities(telegram_user_id,user_id,account_id,profile,updated_at) VALUES(?,?,?,?,?)',[telegramId,userId,accountId,encrypted,Date.now()]);
      }
      catch(error){if(duplicate(error))throw new Failure(409,'Telegram 身份绑定冲突','IDENTITY_CONFLICT','contact_administrator');throw error;}
      if(phone){const claimed=await one('SELECT * FROM telegram_phone_claims WHERE phone_key=?',[digest(phone)]);if(claimed&&(claimed.user_id!==userId||claimed.account_id!==accountId))throw new Failure(409,'手机号已绑定其他账号','IDENTITY_CONFLICT','contact_administrator');if(!claimed)try{await pool.execute('INSERT INTO telegram_phone_claims(phone_key,user_id,account_id,updated_at) VALUES(?,?,?,?)',[digest(phone),userId,accountId,Date.now()]);}catch(error){if(duplicate(error))throw new Failure(409,'手机号绑定冲突','IDENTITY_CONFLICT','contact_administrator');throw error;}}
    },
    async project(userId,id,connection=pool) {const row=await one('SELECT * FROM project_info WHERE id=? AND user_id=?',[id,userId],connection);if(!row)throw new Failure(404,'项目不存在');return row;},
    async projectConfig(id,version) {const row=await one('SELECT config FROM project_versions WHERE project_id=? AND version=?',[id,version]);if(!row)throw new Failure(404,'配置版本不存在');return JSON.parse(crypt.open(row.config,`project:${id}:${version}`));},
    async saveProject(userId,id,input,maximum) {
      return transaction(async connection=>{
        await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[userId]);await this.businessState(userId,connection);
        const current=await one('SELECT * FROM project_info WHERE id=? AND user_id=? FOR UPDATE',[id,userId],connection);
        if(input.update&&!current)throw new Failure(404,'项目不存在');
        if(current?.active_workflow)throw new Failure(409,'流程执行中，不能修改草稿');
        if(current?.status==='archived')throw new Failure(409,'项目已归档');
        if(!await one('SELECT account_id FROM tg_info WHERE account_id=? AND user_id=?',[input.account_id,userId],connection))throw new Failure(404,'Telegram 账号不存在');
        if(current&&current.account_id!==input.account_id)throw new Failure(409,'已有项目不能更换 Telegram 账号');
        if(!current&&Number((await one("SELECT COUNT(*) AS n FROM project_info WHERE user_id=? AND status<>'archived'",[userId],connection)).n)>=maximum)throw new Failure(429,'项目达到配额','RESOURCE_QUOTA','review');
        const version=Number(current?.draft_version||0)+1;const now=Date.now();
        await connection.execute('INSERT INTO project_info(id,user_id,account_id,name,customer_id,status,draft_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'+upsert('project_info',['id'],['name','customer_id','draft_version','updated_at']),[id,userId,input.account_id,input.name,input.customer_id,'active',version,current?.created_at||now,now]);
        await connection.execute('INSERT INTO project_versions(project_id,version,config,created_at) VALUES(?,?,?,?)',[id,version,crypt.seal(JSON.stringify(input.config),`project:${id}:${version}`),now]);
        return {id,draft_version:version,status:current?.status||'active'};
      });
    },
    projects:(userId,after='')=>rows('SELECT * FROM project_info WHERE user_id=? AND id>? ORDER BY id LIMIT 100',[userId,after]),
    resources:projectId=>rows('SELECT * FROM project_resources WHERE project_id=?',[projectId]),
    async resource(projectId,environment,kind) {return one('SELECT * FROM project_resources WHERE project_id=? AND environment=? AND kind=?',[projectId,environment,kind]);},
    async bindResource(projectId,environment,kind,value) {
      const current=await this.resource(projectId,environment,kind);
      if(current&&((kind==='bot'&&String(current.bot_id)!==String(value.bot_id))||current.channel_key!==(value.channel_key||null)))throw new Failure(409,'资源绑定不可替换');
      const project=await one('SELECT user_id,account_id,draft_version FROM project_info WHERE id=?',[projectId]);
      const bot=await one('SELECT user_id,account_id FROM bot_info WHERE telegram_bot_id=?',[value.bot_id]);
      if(!project||!bot||bot.user_id!==project.user_id||bot.account_id!==project.account_id)throw new Failure(404,'资源不属于项目');
      if(!current)await pool.execute('INSERT INTO project_resources(project_id,environment,kind,version,bot_id,username,channel_key) VALUES(?,?,?,?,?,?,?)',[projectId,environment,kind,value.version||project.draft_version,kind==='bot'?value.bot_id:null,value.username,value.channel_key||null]);
    },
    async botPolicy(botId) {
      const row=await one('SELECT p.id,p.user_id,p.status,p.epoch,p.draft_version,p.tested_version,p.published_version,r.environment,r.version FROM project_resources r JOIN project_info p ON p.id=r.project_id WHERE r.bot_id=?',[botId]);
      if(!row)return null;
      const version=row.environment==='production'?row.published_version:row.version;
      return {...row,version,config:await this.projectConfig(row.id,version||row.draft_version)};
    },
    async event({user_id,project_id=null,bot_id=null,environment=null,type:eventType,event_key=randomUUID(),source=null,data={},raw_update=null},connection=pool) {
      const id=randomUUID();
      try{const [result]=await connection.execute('INSERT INTO business_events(id,event_key,user_id,project_id,bot_id,environment,version,type,source,occurred_at,data,raw_update) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'+(type==='postgresql'?' ON CONFLICT(event_key) DO NOTHING':''),[id,digest(event_key),user_id,project_id,bot_id,environment,data.version??null,eventType,source,Date.now(),crypt.seal(JSON.stringify(data),`event:${id}:data`),raw_update?crypt.seal(JSON.stringify(raw_update),`event:${id}:raw`):null]);if(type==='postgresql'&&!result.affectedRows)return false;}
      catch(error){if(duplicate(error))return false;throw error;}return true;
    },
    async visitor(userId,botId,from) {
      if(!from||!Number.isSafeInteger(from.id))return;
      const id=String(from.id);const profile={id,username:from.username||null,first_name:from.first_name||null,last_name:from.last_name||null,language_code:from.language_code||null,is_premium:from.is_premium??null};
      const now=Date.now();await pool.execute('INSERT INTO telegram_visitors(bot_id,telegram_user_id,user_id,profile,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)'+upsert('telegram_visitors',['bot_id','telegram_user_id'],['profile','last_seen_at']),[botId,id,userId,crypt.seal(JSON.stringify(profile),`visitor:${botId}:${id}`),now,now]);
    },
    async events(userId,projectId,after='') {
      await this.project(userId,projectId);
      const result=await rows('SELECT * FROM business_events WHERE user_id=? AND project_id=? AND id>? ORDER BY id LIMIT 100',[userId,projectId,after]);
      return result.map(row=>{const {raw_update,...view}=row;return {...view,data:JSON.parse(crypt.open(row.data,`event:${row.id}:data`))};});
    },
    async statistics(userId,projectId) {await this.project(userId,projectId);return rows('SELECT environment,type,source,COUNT(*) AS count FROM business_events WHERE user_id=? AND project_id=? GROUP BY environment,type,source',[userId,projectId]);},
    async cleanProductData(eventDays,rawDays) {
      const now=Date.now();await pool.execute('UPDATE business_events SET raw_update=NULL WHERE raw_update IS NOT NULL AND occurred_at<?',[now-rawDays*86400000]);
      await pool.execute('DELETE FROM business_events WHERE occurred_at<?',[now-eventDays*86400000]);
      await pool.execute("DELETE FROM business_dispatches WHERE status<>'admitted' AND completed_at<?",[now-eventDays*86400000]);
      await pool.execute("UPDATE business_dispatches SET status='unknown',completed_at=? WHERE status='admitted' AND started_at<?",[now,now-600000]);
    },
    async rewrapProduct(table,cursor,limit,connection=pool) {
      const specs={
        telegram_apps:{keys:['id'],fields:['api_hash'],context:(row,field)=>`app:${row.id}:${field}`},
        telegram_identities:{keys:['telegram_user_id'],fields:['profile'],context:row=>`identity:${row.telegram_user_id}`},
        project_versions:{keys:['project_id','version'],fields:['config'],context:row=>`project:${row.project_id}:${row.version}`},
        telegram_visitors:{keys:['bot_id','telegram_user_id'],fields:['profile'],context:row=>`visitor:${row.bot_id}:${row.telegram_user_id}`},
        business_events:{keys:['id'],fields:['data','raw_update'],context:(row,field)=>`event:${row.id}:${field==='data'?'data':'raw'}`},
        api_jobs:{keys:['id'],fields:['body','result'],context:(row,field)=>`job:${row.id}:${field}`},
        webhook_deliveries:{keys:['bot_id','update_id'],fields:['payload'],context:row=>`delivery:${row.bot_id}:${row.update_id}`},
      };
      const spec=specs[table];if(!spec)throw new Failure(400,'迁移表无效');
      const parts=cursor?cursor.split(':'):[];if(parts.length&&parts.length!==spec.keys.length)throw new Failure(400,'迁移游标无效');
      if(parts.length)for(let i=0;i<parts.length;i++){if(spec.keys[i]==='version'&&!/^\d{1,9}$/.test(parts[i])||['bot_id','update_id','telegram_user_id'].includes(spec.keys[i])&&!/^\d{1,20}$/.test(parts[i]))throw new Failure(400,'迁移游标无效');}
      let condition='',args=[];
      if(parts.length){if(spec.keys.length===1){condition=` WHERE ${spec.keys[0]}>?`;args=parts;}else{condition=` WHERE (${spec.keys[0]}>? OR (${spec.keys[0]}=? AND ${spec.keys[1]}>?))`;args=[parts[0],parts[0],parts[1]];}}
      const result=await rows(`SELECT * FROM ${table}${condition} ORDER BY ${spec.keys.join(',')} LIMIT ?`,[...args,limit],connection);let changed=0;
      for(const row of result){const fields=spec.fields.filter(field=>row[field]!==null&&!crypt.current(row[field]));if(!fields.length)continue;const values=fields.map(field=>crypt.seal(crypt.open(row[field],spec.context(row,field)),spec.context(row,field)));
        const [updated]=await connection.execute(`UPDATE ${table} SET ${fields.map(field=>`${field}=?`).join(',')} WHERE ${spec.keys.map(key=>`${key}=?`).join(' AND ')} AND ${fields.map(field=>`${field}${type==='postgresql'?' IS NOT DISTINCT FROM ':'<=>'}?`).join(' AND ')}`,[...values,...spec.keys.map(key=>row[key]),...fields.map(field=>row[field])]);changed+=updated.affectedRows;
      }
      return {changed,next_cursor:result.length?spec.keys.map(key=>String(result.at(-1)[key])).join(':'):cursor,done:result.length<limit};
    },
    async operationStatus(userId) {const [active]=await pool.execute("SELECT kind,COUNT(*) AS count FROM business_dispatches WHERE user_id=? AND status='admitted' GROUP BY kind",[userId]);return {in_flight:active,remote_cleanup:'not_requested'};},
    async phoneAccount(userId,phone) {const row=await one('SELECT account_id FROM telegram_phone_claims WHERE phone_key=? AND user_id=?',[digest(phone),userId]);return row?.account_id||null;},
    async assertTask(id,userId) {
      await this.assertBusiness(userId);
      const linked=await one('SELECT p.id AS project_id,p.status,p.epoch,r.version AS config_version,r.environment,r.project_epoch,r.status AS workflow_status,p.active_workflow,r.id,r.business_epoch FROM workflow_steps s JOIN workflow_runs r ON r.id=s.workflow_id JOIN project_info p ON p.id=r.project_id WHERE s.job_id=?',[id]);
      if(linked&&(linked.status!=='active'||Number(linked.epoch)!==Number(linked.project_epoch)||linked.active_workflow!==linked.id||!['queued','running'].includes(linked.workflow_status)))throw new Failure(409,'项目流程已停止','PROJECT_INACTIVE','review');
      if(linked)await this.assertBusiness(userId,linked.business_epoch);
      return linked;
    },
  });
  return store;
}
