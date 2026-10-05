import { createDatabase,conflict } from './database.js';
import { credentials } from './security.js';
import { Failure } from './errors.js';
import { randomUUID } from 'node:crypto';
import { publicUser } from './admin.js';
import { installProductStore } from './product-store.js';
import { initializeSchema } from './migrations.js';
import { digest } from './auth.js';

export async function createStore(env = process.env) {
  const crypt=credentials(env);
  const fields=['api_hash','phone','session','phone_code_hash','pending_bot','pending_channel'];
  const {pool,type,database}=await createDatabase(env);
  try {
    await initializeSchema({pool,type,database},env);
  } catch(error) {await pool.end();throw error;}
  const one = async (sql,args) => {const [rows]=await pool.execute(sql,args);return rows[0] || null;};
  const json = value => typeof value === 'string' ? JSON.parse(value) : value;
  const ownedUser = async accountId => {
    const account = await one('SELECT user_id FROM tg_info WHERE account_id=?',[accountId]);
    if (!account) throw new Error('Unknown Telegram account');
    return account.user_id;
  };
  const userQuery=`SELECT u.id,u.email,u.password_hash,u.created_at,CASE WHEN a.user_id IS NULL THEN 'user' ELSE 'admin' END AS role,COALESCE(s.disabled,${type==='postgresql'?'FALSE':'0'}) AS disabled,COALESCE(s.auth_version,0) AS auth_version FROM user_info u LEFT JOIN user_security s ON ${type==='postgresql'?'s.user_id=u.id':'s.user_id COLLATE utf8mb4_unicode_ci=u.id'} LEFT JOIN user_admins a ON ${type==='postgresql'?'a.user_id=u.id':'a.user_id COLLATE utf8mb4_unicode_ci=u.id'}`;
  const insensitive=column=>type==='postgresql'?`LOWER(${column})=LOWER(?)`:`${column}=?`;
  const versionConflict=conflict(type,'user_security',['user_id'],[],['auth_version=user_security.auth_version+1']);
  const transaction=async action=>{const connection=await pool.getConnection();try{await connection.beginTransaction();const value=await action(connection);await connection.commit();return value;}catch(error){await connection.rollback();throw error;}finally{connection.release();}};
  const decryptBot=row=>row&&{...row,token:crypt.open(row.token,`bot:${row.telegram_bot_id}:token`),...(row.webhook_secret?{webhook_secret:crypt.open(row.webhook_secret,`bot:${row.telegram_bot_id}:webhook_secret`)}:{})};
  const appendAudit = (context, connection=pool) => connection.execute(`INSERT INTO audit_logs
    (request_id,started_at,completed_at,actor_type,actor_id,ip,peer_ip,user_agent,method,action,target_id,status,changes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [context.request_id,context.started_at,Date.now(),context.actor_type,context.actor_id??null,
      context.ip,context.peer_ip,context.user_agent,context.method,context.action,context.target_id??null,context.status,JSON.stringify(context.changes||{})]);
  const checkActor = async(connection, context) => {
    if(context.actor_type==='api_key')return;
    const [users]=await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[context.actor_id]);
    const [admins]=await connection.execute('SELECT user_id FROM user_admins WHERE user_id=?',[context.actor_id]);
    const [security]=await connection.execute('SELECT disabled,auth_version FROM user_security WHERE user_id=?',[context.actor_id]);
    if(!users.length||!admins.length||Boolean(Number(security[0]?.disabled))||Number(security[0]?.auth_version||0)!==context.actor_auth_version)throw new Failure(401,'管理员登录状态已撤销');
  };
  const store = {
    pool, transaction, type, ready:async()=>{await pool.execute('SELECT 1');if(await one('SELECT account_id FROM tg_info WHERE phone_key IS NULL LIMIT 1',[]))throw new Failure(503,'历史账号手机号索引未补齐，请运行 npm run backfill:phones','PHONE_INDEX_NOT_READY');},
    appendAudit,
    async initializeAdmin(user) {
      const initialize=()=>transaction(async connection=>{
        const [existing]=await connection.execute(`SELECT id FROM user_info WHERE ${insensitive('email')} FOR UPDATE`,[user.email]);
        if(existing.length){
          const [admins]=await connection.execute('SELECT user_id FROM user_admins WHERE user_id=?',[existing[0].id]);
          if(!admins.length)throw new Error('ADMIN_EMAIL 已属于普通用户，不能自动提升为管理员');
          return {created:false,id:existing[0].id};
        }
        await connection.execute('INSERT INTO user_info(id,email,password_hash) VALUES(?,?,?)',[user.id,user.email,user.password_hash]);
        await connection.execute('INSERT INTO user_admins(user_id) VALUES(?)',[user.id]);
        await appendAudit({request_id:randomUUID(),started_at:Date.now(),actor_type:'bootstrap',actor_id:user.id,ip:'',peer_ip:'',user_agent:'',method:'STARTUP',action:'admin.bootstrap',target_id:user.id,status:200,changes:{role:{after:'admin'}}},connection);
        return {created:true,id:user.id};
      });
      let result;
      for(let attempt=0;attempt<3;attempt++){
        try{result=await initialize();break;}catch(error){if(attempt===2||!['ER_DUP_ENTRY','23505','ER_LOCK_DEADLOCK','40P01'].includes(error.code))throw error;}
      }
      return {created:result.created,user:publicUser(await this.userById(result.id))};
    },
    async adminUsers(after,limit,search=''){const pattern='%'+search.toLowerCase().replace(/[!%_]/g,match=>'!'+match)+'%';const [rows]=await pool.execute(userQuery+" WHERE u.id>? AND (LOWER(u.email) LIKE ? ESCAPE '!' OR u.id=? OR EXISTS (SELECT 1 FROM bot_info b WHERE b.user_id=u.id AND LOWER(b.username) LIKE ? ESCAPE '!')) ORDER BY u.id LIMIT ?",[after,pattern,search,pattern,limit]);return rows;},
    async adminUpdateUser(id,patch,context){
      try{return await transaction(async connection=>{
        await checkActor(connection,context);
        const [rows]=await connection.execute('SELECT id,email,password_hash,created_at FROM user_info WHERE id=? FOR UPDATE',[id]);
        if(!rows.length)throw new Failure(404,'用户不存在');
        const [admins]=await connection.execute('SELECT user_id FROM user_admins WHERE user_id=?',[id]);
        if(admins.length)throw new Failure(403,'此接口仅修改普通用户，管理员改密请使用 /auth/password');
        const [states]=await connection.execute('SELECT disabled FROM user_security WHERE user_id=?',[id]);
        const before={...rows[0],role:'user',disabled:Boolean(Number(states[0]?.disabled))};
        const assignments=[];const args=[];const changes={};
        if(Object.hasOwn(patch,'email')){assignments.push('email=?');args.push(patch.email);changes.email={before:before.email,after:patch.email};}
        if(Object.hasOwn(patch,'password_hash')){assignments.push('password_hash=?');args.push(patch.password_hash);changes.password={changed:true};}
        if(assignments.length)await connection.execute(`UPDATE user_info SET ${assignments.join(',')} WHERE id=?`,[...args,id]);
        const disabled=patch.disabled??before.disabled;
        if(Object.hasOwn(patch,'disabled'))changes.disabled={before:before.disabled,after:disabled};
        if(patch.reason)changes.reason=patch.reason;
        await connection.execute('INSERT INTO user_security(user_id,disabled,auth_version) VALUES(?,?,1)'+conflict(type,'user_security',['user_id'],['disabled'],['auth_version=user_security.auth_version+1']),[id,disabled]);
        if(Object.hasOwn(patch,'disabled'))await store.stopBusiness(id,patch.reason,connection);
        await appendAudit({...context,status:200,changes},connection);
        return publicUser({...before,email:patch.email??before.email,disabled});
      });}catch(error){if(['ER_DUP_ENTRY','23505'].includes(error.code))throw new Failure(409,'该邮箱已被其他用户使用');throw error;}
    },
    async auditLogs(before,target,limit){
      const filters=[];const args=[];
      if(before){filters.push('id<?');args.push(before);}
      if(target){filters.push('target_id=?');args.push(target);}
      const [rows]=await pool.execute(`SELECT * FROM audit_logs${filters.length?' WHERE '+filters.join(' AND '):''} ORDER BY id DESC LIMIT ?`,[...args,limit]);
      return rows.map(row=>({...row,id:String(row.id),started_at:new Date(Number(row.started_at)).toISOString(),completed_at:new Date(Number(row.completed_at)).toISOString(),changes:json(row.changes)}));
    },
    async revokeSessions(id){await pool.execute('INSERT INTO user_security(user_id,auth_version) VALUES(?,1)'+versionConflict,[id]);},
    async disableUser(id,disabled){return transaction(async connection=>{const [users]=await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[id]);if(!users.length)throw new Failure(404,'用户不存在');await connection.execute('INSERT INTO user_security(user_id,disabled,auth_version) VALUES(?,?,1)'+conflict(type,'user_security',['user_id'],['disabled'],['auth_version=user_security.auth_version+1']),[id,disabled]);await store.stopBusiness(id,null,connection);});},
    changePassword:(id,hash)=>transaction(async connection=>{await connection.execute('UPDATE user_info SET password_hash=? WHERE id=?',[hash,id]);await connection.execute('INSERT INTO user_security(user_id,auth_version) VALUES(?,1)'+versionConflict,[id]);}),
    resetPassword:(id,hash,version)=>transaction(async connection=>{
      const [users]=await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[id]);
      const [admins]=await connection.execute('SELECT user_id FROM user_admins WHERE user_id=?',[id]);
      const [security]=await connection.execute('SELECT disabled,auth_version FROM user_security WHERE user_id=?',[id]);
      if(!users.length||admins.length||Boolean(Number(security[0]?.disabled))||Number(security[0]?.auth_version||0)!==Number(version))throw new Failure(401,'重置验证已撤销');
      await connection.execute('UPDATE user_info SET password_hash=? WHERE id=?',[hash,id]);await connection.execute('INSERT INTO user_security(user_id,auth_version) VALUES(?,1)'+versionConflict,[id]);
    }),
    async adminSetLimits(id,config,context){return transaction(async connection=>{
      await checkActor(connection,context);const [users]=await connection.execute('SELECT id FROM user_info WHERE id=? FOR UPDATE',[id]);if(!users.length)throw new Failure(404,'用户不存在');
      const [admins]=await connection.execute('SELECT user_id FROM user_admins WHERE user_id=?',[id]);if(admins.length)throw new Failure(403,'仅支持普通用户配额');
      const [old]=await connection.execute('SELECT config FROM user_limits WHERE user_id=?',[id]);
      await connection.execute('INSERT INTO user_limits(user_id,config,updated_at) VALUES(?,?,?)'+conflict(type,'user_limits',['user_id'],['config','updated_at']),[id,JSON.stringify(config),Date.now()]);
      await appendAudit({...context,status:200,changes:{limits:{before:old.length?json(old[0].config):{},after:config}}},connection);return {ok:true,overrides:config};
    });},
    async accountCount(id){return Number((await one("SELECT COUNT(*) AS n FROM tg_info WHERE user_id=? AND (status NOT IN ('code_required','password_required') OR expires_at>=?)",[id,Date.now()])).n);},
    botCount:async(id,connection=pool)=>Number((await connection.execute('SELECT COUNT(*) AS n FROM bot_info WHERE user_id=?',[id]))[0][0].n),
    channelCount:async(id,connection=pool)=>Number((await connection.execute('SELECT COUNT(*) AS n FROM channel_info WHERE user_id=?',[id]))[0][0].n),
    channelFailed:(id,key)=>pool.execute("DELETE FROM channel_info WHERE account_id=? AND request_key=? AND status='creating'",[id,key]),
    updateToken:async(id,username,token)=>pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,token=? WHERE account_id=? AND ${insensitive('username')}`,[crypt.seal(token,`bot:${token.split(':')[0]}:token`),id,username]),
    userByEmail: async email => {const row=await one(userQuery+` WHERE ${insensitive('u.email')}`,[email]);return row&&{...row,disabled:Boolean(Number(row.disabled)),auth_version:Number(row.auth_version)};},
    userById: async id => {const row=await one(userQuery+' WHERE u.id=?',[id]);return row&&{...row,disabled:Boolean(Number(row.disabled)),auth_version:Number(row.auth_version)};},
    createUser: user => pool.execute('INSERT INTO user_info (id,email,password_hash) VALUES (?,?,?)',[user.id,user.email,user.password_hash]),
    ownsAccount: async(userId,id) => Boolean(await one('SELECT account_id FROM tg_info WHERE user_id=? AND account_id=?',[userId,id])),
    async accountsForUser(userId,after='') {
      const [rows]=await pool.execute('SELECT t.account_id,t.status,t.created_at,i.telegram_user_id,i.profile,a.app_config_id,a.app_version FROM tg_info t LEFT JOIN telegram_identities i ON i.account_id=t.account_id LEFT JOIN account_profiles a ON a.account_id=t.account_id WHERE t.user_id=? AND t.account_id>? ORDER BY t.account_id LIMIT 100',[userId,after]);return rows.map(row=>({...row,profile:row.profile?JSON.parse(crypt.open(row.profile,`identity:${row.telegram_user_id}`)):null}));
    },
    async getAccount(id) {
      const row=await one('SELECT * FROM tg_info WHERE account_id=?',[id]);
      if (!row)return null;
      for(const field of fields)row[field]=crypt.open(row[field],`tg:${id}:${field}`);
      return {user_id:row.user_id,api_id:Number(row.api_id),api_hash:row.api_hash,phone:row.phone,session:row.session,status:row.status,expires_at:row.expires_at,pending_bot:json(row.pending_bot),pending_channel:json(row.pending_channel),phone_code_hash:row.phone_code_hash};
    },
    async saveAccount(id,state) {
      // user_id is immutable on update. Callers enforce ownership before use.
      const existing=await one('SELECT user_id FROM tg_info WHERE account_id=?',[id]);
      if(existing && existing.user_id!==state.user_id)throw new Error('Account ownership mismatch');
      await pool.execute(`INSERT INTO tg_info (account_id,user_id,api_id,api_hash,phone,phone_key,session,status,expires_at,pending_bot,pending_channel,phone_code_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ${conflict(type,'tg_info',['account_id'],['api_id','api_hash','phone','phone_key','session','status','expires_at','pending_bot','pending_channel','phone_code_hash'],['updated_at=CURRENT_TIMESTAMP'])}`,
        [id,state.user_id,state.api_id,crypt.seal(state.api_hash,`tg:${id}:api_hash`),crypt.seal(state.phone,`tg:${id}:phone`),digest(state.phone),crypt.seal(state.session||'',`tg:${id}:session`),state.status,state.expires_at??null,crypt.seal(state.pending_bot?JSON.stringify(state.pending_bot):null,`tg:${id}:pending_bot`),crypt.seal(state.pending_channel?JSON.stringify(state.pending_channel):null,`tg:${id}:pending_channel`),crypt.seal(state.phone_code_hash??null,`tg:${id}:phone_code_hash`)]);
    },
    getLanding: async (id,user) => {const row=await one(`SELECT telegram_bot_id,username AS bot_username,account_id,customer_id,landing_url,card_text,card_image,button_text,webhook_secret,webhook_url
      FROM bot_info WHERE account_id=? AND ${insensitive('username')} AND customer_id IS NOT NULL`,[id,user]);if(row)row.webhook_secret=crypt.open(row.webhook_secret,`bot:${row.telegram_bot_id}:webhook_secret`);return row;},
    configureLanding: async (id,user,config) => {const bot=await one(`SELECT telegram_bot_id FROM bot_info WHERE account_id=? AND ${insensitive('username')}`,[id,user]);return pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,customer_id=?,landing_url=?,card_text=?,card_image=?,button_text=?,
      webhook_secret=COALESCE(webhook_secret,?) WHERE account_id=? AND ${insensitive('username')}`,[config.customer_id,config.landing_url,config.card_text,config.card_image,config.button_text,crypt.seal(config.webhook_secret,`bot:${bot.telegram_bot_id}:webhook_secret`),id,user]);},
    webhookRegistered: (id,user,url) => pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,webhook_url=? WHERE account_id=? AND ${insensitive('username')}`,[url,id,user]),
    webhookBot: async botId => decryptBot(await one('SELECT user_id,account_id,telegram_bot_id,username AS bot_username,token,landing_url,card_text,card_image,button_text,webhook_secret FROM bot_info WHERE telegram_bot_id=? AND customer_id IS NOT NULL',[botId])),
    getChannel: (id,key) => one('SELECT * FROM channel_info WHERE account_id=? AND request_key=?',[id,key]),
    async reserveChannel(id,config) {
      await pool.execute('INSERT INTO channel_info (account_id,user_id,request_key,customer_id,bot_username,title,about) VALUES (?,?,?,?,?,?,?)',
        [id,await ownedUser(id),config.request_key,config.customer_id,config.bot_username,config.title,config.about]);
    },
    saveChannel: (id,key,value) => pool.execute("UPDATE channel_info SET channel_id=?,access_hash=?,status='created' WHERE account_id=? AND request_key=?",[value.channel_id,value.access_hash,id,key]),
    channelReady: (id,key,invite) => pool.execute("UPDATE channel_info SET invite_url=?,status='ready' WHERE account_id=? AND request_key=?",[invite,id,key]),
    async getPost(id,key,requestKey) {
      const row=await one('SELECT data FROM channel_posts WHERE account_id=? AND channel_key=? AND request_key=?',[id,key,requestKey]);
      if(row)return json(row.data);
      const channel=await one('SELECT posts FROM channel_info WHERE account_id=? AND request_key=?',[id,key]);const old=json(channel?.posts);
      return old&&Object.hasOwn(old,requestKey)?old[requestKey]:null;
    },
    reservePost:(id,key,post)=>pool.execute('INSERT INTO channel_posts(account_id,channel_key,request_key,data) VALUES(?,?,?,?)',[id,key,post.request_key,JSON.stringify({...post,status:'sending'})]),
    async postReady(id,key,requestKey,messageId) {
      const record=await this.getPost(id,key,requestKey);
      await pool.execute('INSERT INTO channel_posts(account_id,channel_key,request_key,data) VALUES(?,?,?,?)'+conflict(type,'channel_posts',['account_id','channel_key','request_key'],['data']),[id,key,requestKey,JSON.stringify({...record,status:'sent',message_id:messageId})]);
    },
    async get(id,user) {
      const row=await one(`SELECT telegram_bot_id,username,name,token FROM bot_info WHERE account_id=? AND ${insensitive('username')}`,[id,user]);
      if(row)row.token=crypt.open(row.token,`bot:${row.telegram_bot_id}:token`);
      if(row)delete row.telegram_bot_id;
      return row && {...row,url:`https://t.me/${row.username}`};
    },
    async save(id,bot) {
      await pool.execute('INSERT INTO bot_info (user_id,account_id,telegram_bot_id,username,name,token) VALUES (?,?,?,?,?,?)',
        [await ownedUser(id),id,bot.token.split(':')[0],bot.username,bot.name,crypt.seal(bot.token,`bot:${bot.token.split(':')[0]}:token`)]);
    },
    async rewrap(table,cursor='',limit=50,context=null) {
      if(!['tg_info','bot_info','telegram_apps','telegram_identities','project_versions','telegram_visitors','business_events','api_jobs','webhook_deliveries'].includes(table)||typeof cursor!=='string'||cursor.length>128||!Number.isInteger(limit)||limit<1||limit>100)throw new Failure(400,'迁移参数无效');
      if(!['tg_info','bot_info'].includes(table))return transaction(async connection=>{if(context)await checkActor(connection,context);const result=await store.rewrapProduct(table,cursor,limit,connection);if(context)await appendAudit({...context,status:200,changes:{table,changed:result.changed}},connection);return result;});
      const key=table==='tg_info'?'account_id':'telegram_bot_id';
      const selected=table==='tg_info'?fields:['token','webhook_secret'];
      const run=async connection=>{
      if(context)await checkActor(connection,context);
      const [rows]=await connection.query(`SELECT * FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT ?`,[cursor|| (table==='bot_info'?'0':''),limit]);
      const legacy=credentials(env,{allowPlaintext:true});let changed=0;
      for(const row of rows){const updates=[];const values=[];const before=[];
        for(const field of selected){if(row[field]===null)continue;const context=`${table==='tg_info'?'tg':'bot'}:${row[key]}:${field}`;const raw=typeof row[field]==='object'?JSON.stringify(row[field]):row[field];if(crypt.current(raw))continue;updates.push(`${field}=?`);values.push(crypt.seal(legacy.open(raw,context),context));before.push(row[field]);}
        if(updates.length){const columns=updates.map(v=>v.split('=')[0]);const [result]=await connection.execute(`UPDATE ${table} SET updated_at=CURRENT_TIMESTAMP,${updates.join(',')} WHERE ${key}=? AND ${columns.map(c=>`${c}${type==='postgresql'?' IS NOT DISTINCT FROM ':'<=>'}?`).join(' AND ')}`,[...values,row[key],...before]);changed+=result.affectedRows;}
      }
      if(context)await appendAudit({...context,status:200,changes:{table,changed}},connection);
      return {changed,next_cursor:rows.length?String(rows.at(-1)[key]):cursor,done:rows.length<limit};
      };
      return context?transaction(run):run(pool);
    },
    close:()=>pool.end(),
  };
  return installProductStore(store,crypt,env);
}
