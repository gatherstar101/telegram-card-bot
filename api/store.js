import mysql from 'mysql2/promise';

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
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
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
