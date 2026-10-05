-- Product schema: run on the configured DB. Index creation in MySQL is for first installation.
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

CREATE INDEX ix_workflows_release ON workflow_runs (project_id,environment,version,status);

CREATE INDEX ix_steps_job ON workflow_steps (job_id);

CREATE INDEX ix_events_project ON business_events (project_id,occurred_at);

CREATE INDEX ix_dispatch_user ON business_dispatches (user_id,status);
