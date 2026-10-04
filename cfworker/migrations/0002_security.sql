CREATE TABLE IF NOT EXISTS user_security (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user_info(id),
  disabled INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_posts (
  account_id TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(account_id,channel_key,request_key),
  FOREIGN KEY(account_id,channel_key) REFERENCES channel_info(account_id,request_key)
);
