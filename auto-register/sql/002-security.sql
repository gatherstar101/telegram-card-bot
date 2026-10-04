-- Existing MySQL schema: backup and stop writes before executing.
-- Startup performs the same widening only if legacy column types are found.
ALTER TABLE tg_info MODIFY api_hash TEXT NOT NULL, MODIFY phone TEXT NOT NULL, MODIFY phone_code_hash TEXT NULL, MODIFY pending_bot MEDIUMTEXT NULL, MODIFY pending_channel MEDIUMTEXT NULL;
ALTER TABLE bot_info MODIFY token TEXT NOT NULL, MODIFY webhook_secret TEXT NULL;

CREATE TABLE IF NOT EXISTS user_security (
    user_id CHAR(36) PRIMARY KEY, disabled BOOLEAN NOT NULL DEFAULT FALSE,
    auth_version BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_posts (
    account_id CHAR(36) NOT NULL, channel_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, data JSON NOT NULL,
    PRIMARY KEY(account_id,channel_key,request_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_jobs (
    id CHAR(64) PRIMARY KEY, account_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
    phone_key CHAR(64) NOT NULL, auth_version BIGINT NOT NULL, path VARCHAR(512) NOT NULL,
    body MEDIUMTEXT NOT NULL, fingerprint CHAR(64) NOT NULL, status VARCHAR(16) NOT NULL,
    effect VARCHAR(32) NULL, result MEDIUMTEXT NULL, error JSON NULL,
    lease CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    KEY ix_jobs_pending(status,next_at), KEY ix_jobs_phone(phone_key,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    bot_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, update_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload TEXT NOT NULL, status VARCHAR(16) NOT NULL, attempts INT NOT NULL DEFAULT 0,
    lease CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY(bot_id,update_id), KEY ix_deliveries_pending(status,next_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
