import { credentials } from './security.js';
import { Failure } from '../../auto-register/api/errors.js';

export function createStore(db,env) {
  const crypto=credentials(env);
  const statement=(sql,args=[])=>db.prepare(sql).bind(...args);
  const one=(sql,args)=>statement(sql,args).first();
  const run=async(sql,args)=>{
    try{return await statement(sql,args).run();}
    catch(error){if(/UNIQUE constraint failed/.test(error.message))error.code='ER_DUP_ENTRY';throw error;}
  };
  const parse=value=>value?JSON.parse(value):null;
  const seal=(value,id,field)=>crypto.seal(value,`tg:${id}:${field}`);
  const open=(value,id,field)=>crypto.open(value,`tg:${id}:${field}`);
  const botSecret=(value,id,field)=>crypto.open(value,`bot:${id}:${field}`);
  const userSql='SELECT u.id,u.email,u.password_hash,COALESCE(s.disabled,0) AS disabled,COALESCE(s.auth_version,0) AS auth_version FROM user_info u LEFT JOIN user_security s ON s.user_id=u.id';
  const ownedUser=async id=>{const row=await one('SELECT user_id FROM tg_info WHERE account_id=?',[id]);if(!row)throw new Error('Unknown Telegram account');return row.user_id;};
  const securityUpdate=(id,disabled)=>statement(`INSERT INTO user_security(user_id,disabled,auth_version) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET disabled=excluded.disabled,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP`,[id,disabled]);
  const store={
    userByEmail:email=>one(`${userSql} WHERE u.email=?`,[email]),
    userById:id=>one(`${userSql} WHERE u.id=?`,[id]),
    createUser:user=>run('INSERT INTO user_info(id,email,password_hash) VALUES(?,?,?)',[user.id,user.email,user.password_hash]),
    revokeSessions:async id=>{
      const user=await store.userById(id);
      if(!user)throw new Failure(404,'用户不存在');
      return securityUpdate(id,user.disabled).run();
    },
    disableUser:async(id,disabled)=>{
      if(!await store.userById(id))throw new Failure(404,'用户不存在');
      return securityUpdate(id,disabled?1:0).run();
    },
    changePassword:async(id,hash)=>db.batch([
      statement('UPDATE user_info SET password_hash=? WHERE id=?',[hash,id]),
      statement('INSERT INTO user_security(user_id,auth_version) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP',[id]),
    ]),
    ownsAccount:async(user,id)=>Boolean(await one('SELECT account_id FROM tg_info WHERE user_id=? AND account_id=?',[user,id])),
    accountsForUser:async(user,after='')=>(await statement('SELECT account_id,status,created_at FROM tg_info WHERE user_id=? AND account_id>? ORDER BY account_id LIMIT 100',[user,after]).all()).results,
    accountCount:async user=>{
      await run("DELETE FROM tg_info WHERE user_id=? AND status IN ('code_required','password_required') AND expires_at<?",[user,Date.now()]);
      return (await one('SELECT COUNT(*) AS n FROM tg_info WHERE user_id=?',[user])).n;
    },
    botCount:async user=>(await one('SELECT COUNT(*) AS n FROM bot_info WHERE user_id=?',[user])).n,
    channelCount:async user=>(await one('SELECT COUNT(*) AS n FROM channel_info WHERE user_id=?',[user])).n,
    async getAccount(id) {
      const row=await one('SELECT * FROM tg_info WHERE account_id=?',[id]);
      return row&&{user_id:row.user_id,api_id:row.api_id,api_hash:open(row.api_hash,id,'api_hash'),phone:open(row.phone,id,'phone'),session:open(row.session,id,'session'),status:row.status,expires_at:row.expires_at,phone_code_hash:open(row.phone_code_hash,id,'phone_code_hash'),pending_bot:parse(open(row.pending_bot,id,'pending_bot')),pending_channel:parse(open(row.pending_channel,id,'pending_channel'))};
    },
    async saveAccount(id,state) {
      const existing=await one('SELECT user_id FROM tg_info WHERE account_id=?',[id]);
      if(existing&&existing.user_id!==state.user_id)throw new Error('Account ownership mismatch');
      const result=await run(`INSERT INTO tg_info(account_id,user_id,api_id,api_hash,phone,session,status,expires_at,phone_code_hash,pending_bot,pending_channel) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET api_hash=excluded.api_hash,phone=excluded.phone,session=excluded.session,status=excluded.status,expires_at=excluded.expires_at,phone_code_hash=excluded.phone_code_hash,pending_bot=excluded.pending_bot,pending_channel=excluded.pending_channel,updated_at=CURRENT_TIMESTAMP WHERE tg_info.user_id=excluded.user_id`,
        [id,state.user_id,state.api_id,seal(state.api_hash,id,'api_hash'),seal(state.phone,id,'phone'),seal(state.session||'',id,'session'),state.status,state.expires_at??null,seal(state.phone_code_hash??null,id,'phone_code_hash'),seal(state.pending_bot?JSON.stringify(state.pending_bot):null,id,'pending_bot'),seal(state.pending_channel?JSON.stringify(state.pending_channel):null,id,'pending_channel')]);
      if(!result.meta.changes)throw new Error('Account ownership mismatch');
    },
    get:async(id,user)=>{
      const bot=await one('SELECT telegram_bot_id,username,name,token FROM bot_info WHERE account_id=? AND username=?',[id,user]);
      return bot&&{username:bot.username,name:bot.name,token:botSecret(bot.token,bot.telegram_bot_id,'token'),url:`https://t.me/${bot.username}`};
    },
    save:async(id,bot)=>{
      const botId=bot.token.split(':')[0];
      return run('INSERT INTO bot_info(user_id,account_id,telegram_bot_id,username,name,token) VALUES(?,?,?,?,?,?)',[await ownedUser(id),id,botId,bot.username,bot.name,crypto.seal(bot.token,`bot:${botId}:token`)]);
    },
    updateToken:(id,user,token)=>run('UPDATE bot_info SET token=?,updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND username=? AND telegram_bot_id=?',[crypto.seal(token,`bot:${token.split(':')[0]}:token`),id,user,token.split(':')[0]]),
    getLanding:async(id,user)=>{
      const row=await one('SELECT telegram_bot_id,username AS bot_username,account_id,customer_id,landing_url,card_text,card_image,button_text,webhook_secret,webhook_url FROM bot_info WHERE account_id=? AND username=? AND customer_id IS NOT NULL',[id,user]);
      if(row)row.webhook_secret=botSecret(row.webhook_secret,row.telegram_bot_id,'webhook_secret');
      return row;
    },
    configureLanding:async(id,user,c)=>{
      const row=await one('SELECT telegram_bot_id FROM bot_info WHERE account_id=? AND username=?',[id,user]);
      return run('UPDATE bot_info SET customer_id=?,landing_url=?,card_text=?,card_image=?,button_text=?,webhook_secret=COALESCE(webhook_secret,?),updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND username=?',[c.customer_id,c.landing_url,c.card_text,c.card_image,c.button_text,crypto.seal(c.webhook_secret,`bot:${row.telegram_bot_id}:webhook_secret`),id,user]);
    },
    webhookRegistered:(id,user,url)=>run('UPDATE bot_info SET webhook_url=?,updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND username=?',[url,id,user]),
    webhookBot:async botId=>{
      const row=await one('SELECT username AS bot_username,token,landing_url,card_text,card_image,button_text,webhook_secret FROM bot_info WHERE telegram_bot_id=? AND customer_id IS NOT NULL',[botId]);
      if(row){row.token=botSecret(row.token,botId,'token');row.webhook_secret=botSecret(row.webhook_secret,botId,'webhook_secret');}
      return row;
    },
    getChannel:(id,key)=>one('SELECT * FROM channel_info WHERE account_id=? AND request_key=?',[id,key]),
    reserveChannel:async(id,c)=>run('INSERT INTO channel_info(account_id,user_id,request_key,customer_id,bot_username,title,about) VALUES(?,?,?,?,?,?,?)',[id,await ownedUser(id),c.request_key,c.customer_id,c.bot_username,c.title,c.about]),
    channelFailed:(id,key)=>run("DELETE FROM channel_info WHERE account_id=? AND request_key=? AND status='creating'",[id,key]),
    saveChannel:(id,key,c)=>run("UPDATE channel_info SET channel_id=?,access_hash=?,status='created' WHERE account_id=? AND request_key=?",[String(c.channel_id),String(c.access_hash),id,key]),
    channelReady:(id,key,invite)=>run("UPDATE channel_info SET invite_url=?,status='ready' WHERE account_id=? AND request_key=?",[invite,id,key]),
    getPost:async(id,key,requestKey)=>{
      const row=await one('SELECT data FROM channel_posts WHERE account_id=? AND channel_key=? AND request_key=?',[id,key,requestKey]);
      if(row)return parse(row.data);
      const legacy=await one('SELECT posts FROM channel_info WHERE account_id=? AND request_key=?',[id,key]);
      const posts=parse(legacy?.posts);
      return posts&&Object.hasOwn(posts,requestKey)?posts[requestKey]:null;
    },
    reservePost:async(id,key,post)=>{
      if(await store.getPost(id,key,post.request_key))throw new Failure(409,'帖子已存在');
      return run('INSERT INTO channel_posts(account_id,channel_key,request_key,data) VALUES(?,?,?,?)',[id,key,post.request_key,JSON.stringify({...post,status:'sending'})]);
    },
    postReady:async(id,key,requestKey,messageId)=>{
      const post=await store.getPost(id,key,requestKey);
      if(!post)throw new Error('Post missing');
      return run('INSERT INTO channel_posts(account_id,channel_key,request_key,data) VALUES(?,?,?,?) ON CONFLICT(account_id,channel_key,request_key) DO UPDATE SET data=excluded.data',[id,key,requestKey,JSON.stringify({...post,status:'sent',message_id:messageId})]);
    },
    async rewrap(table,after='',limit=50) {
      if(!['tg_info','bot_info'].includes(table)||!Number.isInteger(limit)||limit<1||limit>100)throw new Failure(400,'迁移 table 或 limit 无效');
      const primary=table==='tg_info'?'account_id':'id';
      if(table==='bot_info'&&!/^\d*$/.test(String(after)))throw new Failure(400,'迁移 cursor 无效');
      const rows=(await statement(`SELECT * FROM ${table} WHERE ${primary}>? ORDER BY ${primary} LIMIT ?`,[table==='bot_info'?Number(after||0):String(after),limit]).all()).results;
      let changed=0;
      const migrationCrypto=credentials(env,{allowPlaintext:true});
      for(const row of rows) {
        const fields=table==='tg_info'?['api_hash','phone','session','phone_code_hash','pending_bot','pending_channel']:['token','webhook_secret'];
        const values=fields.map(field=>row[field]===null?null:crypto.seal(migrationCrypto.open(row[field],`${table==='tg_info'?'tg':'bot'}:${table==='tg_info'?row.account_id:row.telegram_bot_id}:${field}`),`${table==='tg_info'?'tg':'bot'}:${table==='tg_info'?row.account_id:row.telegram_bot_id}:${field}`));
        if(fields.every(field=>crypto.current(row[field])))continue;
        const result=await run(`UPDATE ${table} SET ${fields.map(f=>`${f}=?`).join(',')} WHERE ${primary}=? AND ${fields.map(f=>`${f} IS ?`).join(' AND ')}`,[...values,row[primary],...fields.map(f=>row[f])]);
        changed+=result.meta.changes;
      }
      return {changed,next_cursor:rows.at(-1)?.[primary]??after,done:rows.length<limit};
    },
  };
  return store;
}
