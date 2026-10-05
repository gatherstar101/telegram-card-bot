export const tables = [
  `CREATE TABLE IF NOT EXISTS user_admins (
    user_id CHAR(36) NOT NULL PRIMARY KEY
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_id CHAR(36) NOT NULL, started_at BIGINT NOT NULL, completed_at BIGINT NOT NULL,
    actor_type VARCHAR(16) NOT NULL, actor_id CHAR(36) NULL,
    ip VARCHAR(64) NOT NULL, peer_ip VARCHAR(64) NOT NULL, user_agent VARCHAR(512) NOT NULL,
    method VARCHAR(8) NOT NULL, action VARCHAR(64) NOT NULL, target_id CHAR(36) NULL,
    status INT NOT NULL, changes JSON NOT NULL,
    KEY ix_audit_target (target_id,id), KEY ix_audit_time (completed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_info (
    id CHAR(36) NOT NULL PRIMARY KEY,
    email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tg_info (
    account_id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    api_id BIGINT UNSIGNED NOT NULL,
    api_hash TEXT NOT NULL,
    phone TEXT NOT NULL,
    session MEDIUMTEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    expires_at BIGINT NULL,
    phone_code_hash TEXT NULL,
    pending_bot MEDIUMTEXT NULL,
    pending_channel MEDIUMTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_tg_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS bot_info (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    account_id CHAR(36) NOT NULL,
    telegram_bot_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    name VARCHAR(64) NOT NULL,
    token TEXT NOT NULL,
    customer_id VARCHAR(64) NULL,
    landing_url TEXT NULL,
    card_text TEXT NULL,
    card_image TEXT NULL,
    button_text VARCHAR(64) NULL,
    webhook_secret TEXT NULL,
    webhook_url TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bot_username (username),
    UNIQUE KEY uq_bot_telegram_id (telegram_bot_id),
    KEY ix_bot_user (user_id),
    KEY ix_bot_account (account_id),
    KEY ix_bot_customer (customer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS channel_info (
    account_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    bot_username VARCHAR(32) NOT NULL,
    title VARCHAR(128) NOT NULL,
    about TEXT NOT NULL,
    channel_id VARCHAR(32) NULL,
    access_hash VARCHAR(32) NULL,
    invite_url TEXT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'creating',
    posts JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, request_key),
    KEY ix_channel_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_security (
    user_id CHAR(36) PRIMARY KEY, disabled BOOLEAN NOT NULL DEFAULT FALSE,
    auth_version BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS channel_posts (
    account_id CHAR(36) NOT NULL, channel_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, data JSON NOT NULL,
    PRIMARY KEY(account_id,channel_key,request_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS api_jobs (
    id CHAR(64) PRIMARY KEY, account_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
    phone_key CHAR(64) NOT NULL, auth_version BIGINT NOT NULL, path VARCHAR(512) NOT NULL,
    body MEDIUMTEXT NOT NULL, fingerprint CHAR(64) NOT NULL, status VARCHAR(16) NOT NULL,
    effect VARCHAR(32) NULL, result MEDIUMTEXT NULL, error JSON NULL,
    lease CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    KEY ix_jobs_pending(status,next_at), KEY ix_jobs_phone(phone_key,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    bot_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, update_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload TEXT NOT NULL, status VARCHAR(16) NOT NULL, attempts INT NOT NULL DEFAULT 0,
    lease CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY(bot_id,update_id), KEY ix_deliveries_pending(status,next_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
