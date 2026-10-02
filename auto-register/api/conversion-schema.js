export const conversionTables = [
  `CREATE TABLE IF NOT EXISTS bot_landings (
    bot_username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci PRIMARY KEY,
    account_id CHAR(36) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    landing_url TEXT NOT NULL,
    card_text TEXT NOT NULL,
    card_image TEXT NOT NULL,
    button_text VARCHAR(64) NOT NULL,
    webhook_secret VARCHAR(64) NOT NULL,
    webhook_url TEXT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_customer (customer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS telegram_channels (
    account_id CHAR(36) NOT NULL,
    request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    bot_username VARCHAR(32) NOT NULL,
    title VARCHAR(128) NOT NULL,
    about TEXT NOT NULL,
    channel_id VARCHAR(32) NULL,
    access_hash VARCHAR(32) NULL,
    invite_url TEXT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'creating',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, request_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS channel_posts (
    account_id CHAR(36) NOT NULL,
    channel_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    random_id VARCHAR(32) NOT NULL,
    message_text TEXT NOT NULL,
    bot_url TEXT NOT NULL,
    landing_url TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'sending',
    message_id BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, channel_key, request_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
