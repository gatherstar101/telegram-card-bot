import { createDatabase,conflict } from './database.js';
import { postgresTables } from './postgres-schema.js';
import { tables } from './schema.js';
import { credentials } from './security.js';
import { Failure } from './errors.js';

export async function createStore(env = process.env) {
  const crypt=credentials(env);
  const fields=['api_hash','phone','session','phone_code_hash','pending_bot','pending_channel'];
  const {pool,type,database}=await createDatabase(env);
  try {
    for (const sql of type==='postgresql'?postgresTables:tables) await pool.execute(sql);
    if(type==='mysql')for(const [table,column,definition] of [['tg_info','api_hash','TEXT NOT NULL'],['tg_info','phone','TEXT NOT NULL'],['tg_info','phone_code_hash','TEXT NULL'],['tg_info','pending_bot','MEDIUMTEXT NULL'],['tg_info','pending_channel','MEDIUMTEXT NULL'],['bot_info','token','TEXT NOT NULL'],['bot_info','webhook_secret','TEXT NULL']]) {
      const [rows]=await pool.execute('SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',[database,table,column]);
      if(!['text','mediumtext','longtext'].includes(rows[0]?.DATA_TYPE))await pool.query(`ALTER TABLE ${table} MODIFY ${column} ${definition}`);
    }
  } catch(error) {await pool.end();throw error;}
  const one = async (sql,args) => {const [rows]=await pool.execute(sql,args);return rows[0] || null;};
  const json = value => typeof value === 'string' ? JSON.parse(value) : value;
  const ownedUser = async accountId => {
    const account = await one('SELECT user_id FROM tg_info WHERE account_id=?',[accountId]);
    if (!account) throw new Error('Unknown Telegram account');
    return account.user_id;
  };
  const userQuery=`SELECT u.id,u.email,u.password_hash,COALESCE(s.disabled,${type==='postgresql'?'FALSE':'0'}) AS disabled,COALESCE(s.auth_version,0) AS auth_version FROM user_info u LEFT JOIN user_security s ON ${type==='postgresql'?'s.user_id=u.id':'s.user_id COLLATE utf8mb4_unicode_ci=u.id'}`;
  const insensitive=column=>type==='postgresql'?`LOWER(${column})=LOWER(?)`:`${column}=?`;
  const versionConflict=conflict(type,'user_security',['user_id'],[],['auth_version=user_security.auth_version+1']);
  const transaction=async action=>{const connection=await pool.getConnection();try{await connection.beginTransaction();const value=await action(connection);await connection.commit();return value;}catch(error){await connection.rollback();throw error;}finally{connection.release();}};
  const decryptBot=row=>row&&{...row,token:crypt.open(row.token,`bot:${row.telegram_bot_id}:token`),...(row.webhook_secret?{webhook_secret:crypt.open(row.webhook_secret,`bot:${row.telegram_bot_id}:webhook_secret`)}:{})};
  return {
    pool, transaction, type, ready:()=>pool.execute('SELECT 1'),
    async revokeSessions(id){await pool.execute('INSERT INTO user_security(user_id,auth_version) VALUES(?,1)'+versionConflict,[id]);},
    async disableUser(id,disabled){if(!await one('SELECT id FROM user_info WHERE id=?',[id]))throw new Failure(404,'用户不存在');await pool.execute('INSERT INTO user_security(user_id,disabled,auth_version) VALUES(?,?,1)'+conflict(type,'user_security',['user_id'],['disabled'],['auth_version=user_security.auth_version+1']),[id,disabled]);},
    changePassword:(id,hash)=>transaction(async connection=>{await connection.execute('UPDATE user_info SET password_hash=? WHERE id=?',[hash,id]);await connection.execute('INSERT INTO user_security(user_id,auth_version) VALUES(?,1)'+versionConflict,[id]);}),
    async accountCount(id){await pool.execute("DELETE FROM tg_info WHERE user_id=? AND status IN ('code_required','password_required') AND expires_at<?",[id,Date.now()]);return Number((await one('SELECT COUNT(*) AS n FROM tg_info WHERE user_id=?',[id])).n);},
    botCount:async id=>Number((await one('SELECT COUNT(*) AS n FROM bot_info WHERE user_id=?',[id])).n),
    channelCount:async id=>Number((await one('SELECT COUNT(*) AS n FROM channel_info WHERE user_id=?',[id])).n),
    channelFailed:(id,key)=>pool.execute("DELETE FROM channel_info WHERE account_id=? AND request_key=? AND status='creating'",[id,key]),
    updateToken:async(id,username,token)=>pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,token=? WHERE account_id=? AND ${insensitive('username')}`,[crypt.seal(token,`bot:${token.split(':')[0]}:token`),id,username]),
    userByEmail: async email => {const row=await one(userQuery+` WHERE ${insensitive('u.email')}`,[email]);return row&&{...row,disabled:Boolean(Number(row.disabled)),auth_version:Number(row.auth_version)};},
    userById: async id => {const row=await one(userQuery+' WHERE u.id=?',[id]);return row&&{...row,disabled:Boolean(Number(row.disabled)),auth_version:Number(row.auth_version)};},
    createUser: user => pool.execute('INSERT INTO user_info (id,email,password_hash) VALUES (?,?,?)',[user.id,user.email,user.password_hash]),
    ownsAccount: async(userId,id) => Boolean(await one('SELECT account_id FROM tg_info WHERE user_id=? AND account_id=?',[userId,id])),
    async accountsForUser(userId,after='') {
      const [rows]=await pool.execute('SELECT account_id,status,created_at FROM tg_info WHERE user_id=? AND account_id>? ORDER BY account_id LIMIT 100',[userId,after]);return rows;
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
      await pool.execute(`INSERT INTO tg_info (account_id,user_id,api_id,api_hash,phone,session,status,expires_at,pending_bot,pending_channel,phone_code_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ${conflict(type,'tg_info',['account_id'],['session','status','expires_at','pending_bot','pending_channel','phone_code_hash'],['updated_at=CURRENT_TIMESTAMP'])}`,
        [id,state.user_id,state.api_id,crypt.seal(state.api_hash,`tg:${id}:api_hash`),crypt.seal(state.phone,`tg:${id}:phone`),crypt.seal(state.session||'',`tg:${id}:session`),state.status,state.expires_at??null,crypt.seal(state.pending_bot?JSON.stringify(state.pending_bot):null,`tg:${id}:pending_bot`),crypt.seal(state.pending_channel?JSON.stringify(state.pending_channel):null,`tg:${id}:pending_channel`),crypt.seal(state.phone_code_hash??null,`tg:${id}:phone_code_hash`)]);
    },
    getLanding: async (id,user) => {const row=await one(`SELECT telegram_bot_id,username AS bot_username,account_id,customer_id,landing_url,card_text,card_image,button_text,webhook_secret,webhook_url
      FROM bot_info WHERE account_id=? AND ${insensitive('username')} AND customer_id IS NOT NULL`,[id,user]);if(row)row.webhook_secret=crypt.open(row.webhook_secret,`bot:${row.telegram_bot_id}:webhook_secret`);return row;},
    configureLanding: async (id,user,config) => {const bot=await one(`SELECT telegram_bot_id FROM bot_info WHERE account_id=? AND ${insensitive('username')}`,[id,user]);return pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,customer_id=?,landing_url=?,card_text=?,card_image=?,button_text=?,
      webhook_secret=COALESCE(webhook_secret,?) WHERE account_id=? AND ${insensitive('username')}`,[config.customer_id,config.landing_url,config.card_text,config.card_image,config.button_text,crypt.seal(config.webhook_secret,`bot:${bot.telegram_bot_id}:webhook_secret`),id,user]);},
    webhookRegistered: (id,user,url) => pool.execute(`UPDATE bot_info SET updated_at=CURRENT_TIMESTAMP,webhook_url=? WHERE account_id=? AND ${insensitive('username')}`,[url,id,user]),
    webhookBot: async botId => decryptBot(await one('SELECT telegram_bot_id,username AS bot_username,token,landing_url,card_text,card_image,button_text,webhook_secret FROM bot_info WHERE telegram_bot_id=? AND customer_id IS NOT NULL',[botId])),
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
    async rewrap(table,cursor='',limit=50) {
      if(!['tg_info','bot_info'].includes(table)||typeof cursor!=='string'||cursor.length>64||!Number.isInteger(limit)||limit<1||limit>100)throw new Failure(400,'迁移参数无效');
      const key=table==='tg_info'?'account_id':'telegram_bot_id';
      const selected=table==='tg_info'?fields:['token','webhook_secret'];
      const [rows]=await pool.query(`SELECT * FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT ?`,[cursor|| (table==='bot_info'?'0':''),limit]);
      const legacy=credentials(env,{allowPlaintext:true});let changed=0;
      for(const row of rows){const updates=[];const values=[];const before=[];
        for(const field of selected){if(row[field]===null)continue;const context=`${table==='tg_info'?'tg':'bot'}:${row[key]}:${field}`;const raw=typeof row[field]==='object'?JSON.stringify(row[field]):row[field];if(crypt.current(raw))continue;updates.push(`${field}=?`);values.push(crypt.seal(legacy.open(raw,context),context));before.push(row[field]);}
        if(updates.length){const columns=updates.map(v=>v.split('=')[0]);const [result]=await pool.execute(`UPDATE ${table} SET updated_at=CURRENT_TIMESTAMP,${updates.join(',')} WHERE ${key}=? AND ${columns.map(c=>`${c}${type==='postgresql'?' IS NOT DISTINCT FROM ':'<=>'}?`).join(' AND ')}`,[...values,row[key],...before]);changed+=result.affectedRows;}
      }
      return {changed,next_cursor:rows.length?String(rows.at(-1)[key]):cursor,done:rows.length<limit};
    },
    close:()=>pool.end(),
  };
}
