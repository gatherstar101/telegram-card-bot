import mysql from 'mysql2/promise';
import { conversionTables } from './conversion-schema.js';

export async function createStore(env = process.env) {
  if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_PASSWORD || !env.MYSQL_DATABASE) {
    throw new Error('需要 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD、MYSQL_DATABASE');
  }
  // Identifiers cannot use SQL value placeholders. Restrict the name before
  // quoting it so configuration can never inject another SQL statement.
  const database = env.MYSQL_DATABASE;
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error('MYSQL_DATABASE 必须为 1–64 位字母、数字或下划线');
  }
  const port = Number(env.MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MYSQL_PORT 必须为 1–65535 的整数');
  }
  const options = {
    host: env.MYSQL_HOST, port,
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    charset: 'utf8mb4',
  };
  // Connect without selecting a database: it may not exist on first startup.
  const bootstrap = await mysql.createConnection(options);
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await bootstrap.end();
  }
  const pool = mysql.createPool({ ...options, database, connectionLimit: 5 });
  try {
  await pool.execute(`CREATE TABLE IF NOT EXISTS telegram_bots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id CHAR(36) NOT NULL,
    telegram_bot_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    name VARCHAR(64) NOT NULL,
    token VARCHAR(256) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_username (username),
    UNIQUE KEY uq_telegram_bot_id (telegram_bot_id),
    KEY ix_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const sql of conversionTables) await pool.execute(sql);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async getLanding(accountId, username) {
      const [rows] = await pool.execute('SELECT * FROM bot_landings WHERE account_id = ? AND bot_username = ?', [accountId, username]);
      return rows[0] || null;
    },
    async configureLanding(accountId, username, config) {
      await pool.execute(`INSERT INTO bot_landings
        (account_id, bot_username, customer_id, landing_url, card_text, card_image, button_text, webhook_secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id), landing_url=VALUES(landing_url),
        card_text=VALUES(card_text), card_image=VALUES(card_image), button_text=VALUES(button_text)`,
        [accountId, username, config.customer_id, config.landing_url, config.card_text, config.card_image, config.button_text, config.webhook_secret]);
    },
    async webhookRegistered(accountId, username, url) {
      await pool.execute('UPDATE bot_landings SET webhook_url = ? WHERE account_id = ? AND bot_username = ?', [url, accountId, username]);
    },
    async webhookBot(botId) {
      const [rows] = await pool.execute(`SELECT l.*, b.token FROM bot_landings l JOIN telegram_bots b
        ON b.account_id=l.account_id AND b.username=l.bot_username WHERE b.telegram_bot_id = ?`, [botId]);
      return rows[0] || null;
    },
    async getChannel(accountId, requestKey) {
      const [rows] = await pool.execute('SELECT * FROM telegram_channels WHERE account_id=? AND request_key=?', [accountId, requestKey]);
      return rows[0] || null;
    },
    async reserveChannel(accountId, config) {
      await pool.execute(`INSERT INTO telegram_channels (account_id, request_key, customer_id, bot_username, title, about)
        VALUES (?, ?, ?, ?, ?, ?)`, [accountId, config.request_key, config.customer_id, config.bot_username, config.title, config.about]);
    },
    async saveChannel(accountId, requestKey, channel) {
      await pool.execute(`UPDATE telegram_channels SET channel_id=?, access_hash=?, status='created'
        WHERE account_id=? AND request_key=?`, [channel.channel_id, channel.access_hash, accountId, requestKey]);
    },
    async channelReady(accountId, requestKey, invite) {
      await pool.execute("UPDATE telegram_channels SET invite_url=?, status='ready' WHERE account_id=? AND request_key=?", [invite, accountId, requestKey]);
    },
    async getPost(accountId, channelKey, requestKey) {
      const [rows] = await pool.execute('SELECT * FROM channel_posts WHERE account_id=? AND channel_key=? AND request_key=?', [accountId, channelKey, requestKey]);
      return rows[0] || null;
    },
    async reservePost(accountId, channelKey, post) {
      await pool.execute(`INSERT INTO channel_posts (account_id, channel_key, request_key, random_id, message_text, bot_url, landing_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [accountId, channelKey, post.request_key, post.random_id, post.message_text, post.bot_url, post.landing_url]);
    },
    async postReady(accountId, channelKey, requestKey, messageId) {
      await pool.execute("UPDATE channel_posts SET status='sent', message_id=? WHERE account_id=? AND channel_key=? AND request_key=?", [messageId, accountId, channelKey, requestKey]);
    },
    async get(accountId, username) {
      const [rows] = await pool.execute('SELECT username, name, token FROM telegram_bots WHERE account_id = ? AND username = ?', [accountId, username]);
      if (!rows[0]) return null;
      return { ...rows[0], url: `https://t.me/${rows[0].username}` };
    },
    async save(accountId, bot) {
      await pool.execute(`INSERT INTO telegram_bots (account_id, telegram_bot_id, username, name, token)
        VALUES (?, ?, ?, ?, ?)`, [accountId, bot.token.split(':')[0], bot.username, bot.name, bot.token]);
    },
    close: () => pool.end(),
  };
}
