import mysql from 'mysql2/promise';
import { tables } from './schema.js';

export async function createStore(env = process.env) {
  if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_PASSWORD || !env.MYSQL_DATABASE) throw new Error('需要 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD、MYSQL_DATABASE');
  const database = env.MYSQL_DATABASE;
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('MYSQL_DATABASE 必须为 1–64 位字母、数字或下划线');
  const port = Number(env.MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT 必须为 1–65535 的整数');
  const options = { host: env.MYSQL_HOST, port, user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, charset: 'utf8mb4' };
  const bootstrap = await mysql.createConnection(options);
  try { await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await bootstrap.end(); }
  const pool = mysql.createPool({ ...options, database, connectionLimit: 5 });
  try { for (const sql of tables) await pool.execute(sql); }
  catch (error) { await pool.end(); throw error; }
  const one = async (sql,args) => {const [rows]=await pool.execute(sql,args);return rows[0] || null;};
  const json = value => typeof value === 'string' ? JSON.parse(value) : value;
  const ownedUser = async accountId => {
    const account = await one('SELECT user_id FROM tg_info WHERE account_id=?',[accountId]);
    if (!account) throw new Error('Unknown Telegram account');
    return account.user_id;
  };
  return {
    userByEmail: email => one('SELECT id,email,password_hash FROM user_info WHERE email=?',[email]),
    userById: id => one('SELECT id,email,password_hash FROM user_info WHERE id=?',[id]),
    createUser: user => pool.execute('INSERT INTO user_info (id,email,password_hash) VALUES (?,?,?)',[user.id,user.email,user.password_hash]),
    ownsAccount: async(userId,id) => Boolean(await one('SELECT account_id FROM tg_info WHERE user_id=? AND account_id=?',[userId,id])),
    async accountsForUser(userId) {
      const [rows]=await pool.execute('SELECT account_id,status,created_at FROM tg_info WHERE user_id=? ORDER BY created_at',[userId]);return rows;
    },
    async getAccount(id) {
      const row=await one('SELECT * FROM tg_info WHERE account_id=?',[id]);
      if (!row)return null;
      return {user_id:row.user_id,api_id:Number(row.api_id),api_hash:row.api_hash,phone:row.phone,session:row.session,status:row.status,expires_at:row.expires_at,pending_bot:json(row.pending_bot),pending_channel:json(row.pending_channel),phone_code_hash:row.phone_code_hash};
    },
    async saveAccount(id,state) {
      // user_id is immutable on update. Callers enforce ownership before use.
      const existing=await one('SELECT user_id FROM tg_info WHERE account_id=?',[id]);
      if(existing && existing.user_id!==state.user_id)throw new Error('Account ownership mismatch');
      await pool.execute(`INSERT INTO tg_info (account_id,user_id,api_id,api_hash,phone,session,status,expires_at,pending_bot,pending_channel,phone_code_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE session=VALUES(session),status=VALUES(status),expires_at=VALUES(expires_at),
        pending_bot=VALUES(pending_bot),pending_channel=VALUES(pending_channel),phone_code_hash=VALUES(phone_code_hash)`,
        [id,state.user_id,state.api_id,state.api_hash,state.phone,state.session||'',state.status,state.expires_at??null,state.pending_bot?JSON.stringify(state.pending_bot):null,state.pending_channel?JSON.stringify(state.pending_channel):null,state.phone_code_hash??null]);
    },
    getLanding: (id,user) => one(`SELECT username AS bot_username,account_id,customer_id,landing_url,card_text,card_image,button_text,webhook_secret,webhook_url
      FROM bot_info WHERE account_id=? AND username=? AND customer_id IS NOT NULL`,[id,user]),
    configureLanding: (id,user,config) => pool.execute(`UPDATE bot_info SET customer_id=?,landing_url=?,card_text=?,card_image=?,button_text=?,
      webhook_secret=COALESCE(webhook_secret,?) WHERE account_id=? AND username=?`,[config.customer_id,config.landing_url,config.card_text,config.card_image,config.button_text,config.webhook_secret,id,user]),
    webhookRegistered: (id,user,url) => pool.execute('UPDATE bot_info SET webhook_url=? WHERE account_id=? AND username=?',[url,id,user]),
    webhookBot: botId => one('SELECT username AS bot_username,token,landing_url,card_text,card_image,button_text,webhook_secret FROM bot_info WHERE telegram_bot_id=? AND customer_id IS NOT NULL',[botId]),
    getChannel: (id,key) => one('SELECT * FROM channel_info WHERE account_id=? AND request_key=?',[id,key]),
    async reserveChannel(id,config) {
      await pool.execute('INSERT INTO channel_info (account_id,user_id,request_key,customer_id,bot_username,title,about) VALUES (?,?,?,?,?,?,?)',
        [id,await ownedUser(id),config.request_key,config.customer_id,config.bot_username,config.title,config.about]);
    },
    saveChannel: (id,key,value) => pool.execute("UPDATE channel_info SET channel_id=?,access_hash=?,status='created' WHERE account_id=? AND request_key=?",[value.channel_id,value.access_hash,id,key]),
    channelReady: (id,key,invite) => pool.execute("UPDATE channel_info SET invite_url=?,status='ready' WHERE account_id=? AND request_key=?",[invite,id,key]),
    async getPost(id,key,requestKey) {
      const row=await one('SELECT posts FROM channel_info WHERE account_id=? AND request_key=?',[id,key]);
      return row && json(row.posts)?.[requestKey] || null;
    },
    async reservePost(id,key,post) {
      const [result]=await pool.execute(`UPDATE channel_info SET posts=JSON_SET(COALESCE(posts,JSON_OBJECT()),?,CAST(? AS JSON))
        WHERE account_id=? AND request_key=? AND JSON_CONTAINS_PATH(COALESCE(posts,JSON_OBJECT()),'one',?)=0`,
        [`$."${post.request_key}"`,JSON.stringify({...post,status:'sending'}),id,key,`$."${post.request_key}"`]);
      if(!result.affectedRows)throw new Error('Post already exists or channel missing');
    },
    postReady: (id,key,requestKey,messageId) => pool.execute('UPDATE channel_info SET posts=JSON_SET(posts,?,\'sent\',?,?) WHERE account_id=? AND request_key=?',
      [`$."${requestKey}".status`,`$."${requestKey}".message_id`,messageId,id,key]),
    async get(id,user) {
      const row=await one('SELECT username,name,token FROM bot_info WHERE account_id=? AND username=?',[id,user]);
      return row && {...row,url:`https://t.me/${row.username}`};
    },
    async save(id,bot) {
      await pool.execute('INSERT INTO bot_info (user_id,account_id,telegram_bot_id,username,name,token) VALUES (?,?,?,?,?,?)',
        [await ownedUser(id),id,bot.token.split(':')[0],bot.username,bot.name,bot.token]);
    },
    close:()=>pool.end(),
  };
}
