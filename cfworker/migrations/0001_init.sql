CREATE TABLE user_info (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT COLLATE NOCASE NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tg_info (
  account_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user_info(id),
  api_id INTEGER NOT NULL,
  api_hash TEXT NOT NULL,
  phone TEXT NOT NULL,
  session TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  phone_code_hash TEXT,
  pending_bot TEXT,
  pending_channel TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_tg_user ON tg_info(user_id);
CREATE TABLE bot_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user_info(id),
  account_id TEXT NOT NULL REFERENCES tg_info(account_id),
  telegram_bot_id TEXT NOT NULL UNIQUE,
  username TEXT COLLATE NOCASE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  customer_id TEXT,
  landing_url TEXT,
  card_text TEXT,
  card_image TEXT,
  button_text TEXT,
  webhook_secret TEXT,
  webhook_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_bot_user ON bot_info(user_id);
CREATE INDEX ix_bot_account ON bot_info(account_id);
CREATE INDEX ix_bot_customer ON bot_info(customer_id);
CREATE TABLE channel_info (
  account_id TEXT NOT NULL REFERENCES tg_info(account_id),
  user_id TEXT NOT NULL REFERENCES user_info(id),
  request_key TEXT COLLATE BINARY NOT NULL,
  customer_id TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  title TEXT NOT NULL,
  about TEXT NOT NULL,
  channel_id TEXT,
  access_hash TEXT,
  invite_url TEXT,
  status TEXT NOT NULL DEFAULT 'creating',
  posts TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, request_key)
);
CREATE INDEX ix_channel_user ON channel_info(user_id);
