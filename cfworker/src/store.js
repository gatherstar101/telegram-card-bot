// Same business interface as the MySQL store. Telegram 64-bit identifiers stay
// strings; binding them as JavaScript numbers would silently lose precision.
export function createStore(db) {
  const statement = (sql, args = []) => db.prepare(sql).bind(...args);
  const one = (sql, args) => statement(sql, args).first();
  const run = async (sql, args) => {
    try { return await statement(sql, args).run(); }
    catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) error.code = 'ER_DUP_ENTRY';
      throw error;
    }
  };
  const json = value => value ? JSON.parse(value) : null;
  const ownedUser = async id => {
    const row = await one('SELECT user_id FROM tg_info WHERE account_id=?', [id]);
    if (!row) throw new Error('Unknown Telegram account');
    return row.user_id;
  };
  return {
    userByEmail: email => one('SELECT id,email,password_hash FROM user_info WHERE email=?', [email]),
    userById: id => one('SELECT id,email,password_hash FROM user_info WHERE id=?', [id]),
    createUser: user => run('INSERT INTO user_info(id,email,password_hash) VALUES(?,?,?)', [user.id,user.email,user.password_hash]),
    ownsAccount: async (user,id) => Boolean(await one('SELECT account_id FROM tg_info WHERE user_id=? AND account_id=?', [user,id])),
    accountsForUser: async user => (await statement('SELECT account_id,status,created_at FROM tg_info WHERE user_id=? ORDER BY created_at', [user]).all()).results,
    async getAccount(id) {
      const row = await one('SELECT * FROM tg_info WHERE account_id=?', [id]);
      return row && { user_id:row.user_id,api_id:row.api_id,api_hash:row.api_hash,phone:row.phone,session:row.session,status:row.status,expires_at:row.expires_at,phone_code_hash:row.phone_code_hash,pending_bot:json(row.pending_bot),pending_channel:json(row.pending_channel) };
    },
    async saveAccount(id,state) {
      const existing = await one('SELECT user_id FROM tg_info WHERE account_id=?', [id]);
      if (existing && existing.user_id !== state.user_id) throw new Error('Account ownership mismatch');
      const result = await run(`INSERT INTO tg_info(account_id,user_id,api_id,api_hash,phone,session,status,expires_at,phone_code_hash,pending_bot,pending_channel)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
        session=excluded.session,status=excluded.status,expires_at=excluded.expires_at,phone_code_hash=excluded.phone_code_hash,
        pending_bot=excluded.pending_bot,pending_channel=excluded.pending_channel,updated_at=CURRENT_TIMESTAMP
        WHERE tg_info.user_id=excluded.user_id`,
        [id,state.user_id,state.api_id,state.api_hash,state.phone,state.session||'',state.status,state.expires_at??null,state.phone_code_hash??null,state.pending_bot?JSON.stringify(state.pending_bot):null,state.pending_channel?JSON.stringify(state.pending_channel):null]);
      if (!result.meta.changes) throw new Error('Account ownership mismatch');
    },
    get: async (id,user) => {
      const bot = await one('SELECT username,name,token FROM bot_info WHERE account_id=? AND username=?', [id,user]);
      return bot && { ...bot,url:`https://t.me/${bot.username}` };
    },
    save: async (id,bot) => run('INSERT INTO bot_info(user_id,account_id,telegram_bot_id,username,name,token) VALUES(?,?,?,?,?,?)', [await ownedUser(id),id,bot.token.split(':')[0],bot.username,bot.name,bot.token]),
    getLanding: (id,user) => one(`SELECT username AS bot_username,account_id,customer_id,landing_url,card_text,card_image,button_text,webhook_secret,webhook_url
      FROM bot_info WHERE account_id=? AND username=? AND customer_id IS NOT NULL`, [id,user]),
    configureLanding: (id,user,c) => run(`UPDATE bot_info SET customer_id=?,landing_url=?,card_text=?,card_image=?,button_text=?,webhook_secret=COALESCE(webhook_secret,?),updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND username=?`, [c.customer_id,c.landing_url,c.card_text,c.card_image,c.button_text,c.webhook_secret,id,user]),
    webhookRegistered: (id,user,url) => run('UPDATE bot_info SET webhook_url=?,updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND username=?', [url,id,user]),
    webhookBot: botId => one('SELECT username AS bot_username,token,landing_url,card_text,card_image,button_text,webhook_secret FROM bot_info WHERE telegram_bot_id=? AND customer_id IS NOT NULL', [botId]),
    getChannel: (id,key) => one('SELECT * FROM channel_info WHERE account_id=? AND request_key=?', [id,key]),
    reserveChannel: async (id,c) => run('INSERT INTO channel_info(account_id,user_id,request_key,customer_id,bot_username,title,about) VALUES(?,?,?,?,?,?,?)', [id,await ownedUser(id),c.request_key,c.customer_id,c.bot_username,c.title,c.about]),
    saveChannel: (id,key,c) => run("UPDATE channel_info SET channel_id=?,access_hash=?,status='created' WHERE account_id=? AND request_key=?", [String(c.channel_id),String(c.access_hash),id,key]),
    channelReady: (id,key,invite) => run("UPDATE channel_info SET invite_url=?,status='ready' WHERE account_id=? AND request_key=?", [invite,id,key]),
    getPost: async (id,key,requestKey) => {
      const row = await one('SELECT posts FROM channel_info WHERE account_id=? AND request_key=?', [id,key]);
      return json(row?.posts)?.[requestKey] || null;
    },
    async reservePost(id,key,post) {
      const path = `$."${post.request_key}"`;
      const result = await run(`UPDATE channel_info SET posts=json_set(COALESCE(posts,'{}'),?,json(?))
        WHERE account_id=? AND request_key=? AND json_type(COALESCE(posts,'{}'),?) IS NULL`, [path,JSON.stringify({...post,status:'sending'}),id,key,path]);
      if (!result.meta.changes) throw new Error('Post already exists or channel missing');
    },
    postReady: (id,key,requestKey,messageId) => run("UPDATE channel_info SET posts=json_set(posts,?,'sent',?,?) WHERE account_id=? AND request_key=?", [`$."${requestKey}".status`,`$."${requestKey}".message_id`,messageId,id,key]),
  };
}
