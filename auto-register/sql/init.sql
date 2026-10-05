-- Administrator roles and persistent operation audit.
CREATE TABLE IF NOT EXISTS user_admins (
    user_id CHAR(36) NOT NULL PRIMARY KEY
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_id CHAR(36) NOT NULL, started_at BIGINT NOT NULL, completed_at BIGINT NOT NULL,
    actor_type VARCHAR(16) NOT NULL, actor_id CHAR(36) NULL,
    ip VARCHAR(64) NOT NULL, peer_ip VARCHAR(64) NOT NULL, user_agent VARCHAR(512) NOT NULL,
    method VARCHAR(8) NOT NULL, action VARCHAR(64) NOT NULL, target_id CHAR(36) NULL,
    status INT NOT NULL, changes JSON NOT NULL,
    KEY ix_audit_target (target_id,id), KEY ix_audit_time (completed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MySQL 8.0+. Select the DB_DATABASE target before running.
-- Database creation is managed by the service or administrator.

CREATE TABLE IF NOT EXISTS user_info (
    id CHAR(36) NOT NULL PRIMARY KEY,
    email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tg_info (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_info (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_info (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- Product schema additions
CREATE TABLE IF NOT EXISTS telegram_apps (id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,name VARCHAR(64) NOT NULL,api_id BIGINT NOT NULL,api_hash TEXT NOT NULL,version INT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_identities (telegram_user_id VARCHAR(32) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL UNIQUE,profile TEXT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_phone_claims (phone_key VARCHAR(64) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL UNIQUE,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_profiles (account_id VARCHAR(36) PRIMARY KEY,app_config_id VARCHAR(36),app_version INT,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_business (user_id VARCHAR(36) PRIMARY KEY,epoch BIGINT NOT NULL DEFAULT 0,reason VARCHAR(256),updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_limits (user_id VARCHAR(36) PRIMARY KEY,config TEXT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_info (id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL,name VARCHAR(128) NOT NULL,customer_id VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,epoch BIGINT NOT NULL DEFAULT 0,draft_version INT NOT NULL,tested_version INT,published_version INT,active_workflow VARCHAR(36),created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_versions (project_id VARCHAR(36) NOT NULL,version INT NOT NULL,config MEDIUMTEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(project_id,version)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_resources (project_id VARCHAR(36) NOT NULL,environment VARCHAR(16) NOT NULL,kind VARCHAR(16) NOT NULL,version INT NOT NULL,bot_id VARCHAR(32) UNIQUE,username VARCHAR(32),channel_key VARCHAR(64),PRIMARY KEY(project_id,environment,kind)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_runs (id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,user_id VARCHAR(36) NOT NULL,environment VARCHAR(16) NOT NULL,version INT NOT NULL,status VARCHAR(32) NOT NULL,business_epoch BIGINT NOT NULL,project_epoch BIGINT NOT NULL,lease VARCHAR(36),lease_until BIGINT NOT NULL DEFAULT 0,next_at BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_steps (workflow_id VARCHAR(36) NOT NULL,position INT NOT NULL,code VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL,attempts INT NOT NULL DEFAULT 0,job_id VARCHAR(64),started_at BIGINT,completed_at BIGINT,error TEXT,PRIMARY KEY(workflow_id,position)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_visitors (bot_id VARCHAR(32) NOT NULL,telegram_user_id VARCHAR(32) NOT NULL,user_id VARCHAR(36) NOT NULL,profile TEXT NOT NULL,first_seen_at BIGINT NOT NULL,last_seen_at BIGINT NOT NULL,PRIMARY KEY(bot_id,telegram_user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS business_events (id VARCHAR(36) PRIMARY KEY,event_key VARCHAR(64) NOT NULL UNIQUE,user_id VARCHAR(36) NOT NULL,project_id VARCHAR(36),bot_id VARCHAR(32),environment VARCHAR(16),version INT,type VARCHAR(32) NOT NULL,source VARCHAR(64),occurred_at BIGINT NOT NULL,data MEDIUMTEXT NOT NULL,raw_update MEDIUMTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS business_dispatches (id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,kind VARCHAR(32) NOT NULL,status VARCHAR(16) NOT NULL,started_at BIGINT NOT NULL,completed_at BIGINT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX ix_apps_user ON telegram_apps (user_id,id);

CREATE INDEX ix_projects_user ON project_info (user_id,id);

CREATE INDEX ix_workflows_pending ON workflow_runs (status,next_at);

CREATE INDEX ix_events_user ON business_events (user_id,occurred_at);

CREATE INDEX ix_events_project ON business_events (project_id,occurred_at);

CREATE INDEX ix_dispatch_user ON business_dispatches (user_id,status);
