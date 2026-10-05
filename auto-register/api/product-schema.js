// Additive schema: existing installations need no destructive column changes.
export function productTables(type) {
  const text = type === 'mysql' ? 'MEDIUMTEXT' : 'TEXT';
  const definitions = {
    telegram_apps: `id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,name VARCHAR(64) NOT NULL,api_id BIGINT NOT NULL,api_hash TEXT NOT NULL,version INT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL`,
    telegram_identities: `telegram_user_id VARCHAR(32) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL UNIQUE,profile TEXT NOT NULL,updated_at BIGINT NOT NULL`,
    telegram_phone_claims: `phone_key VARCHAR(64) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL UNIQUE,updated_at BIGINT NOT NULL`,
    account_profiles: `account_id VARCHAR(36) PRIMARY KEY,app_config_id VARCHAR(36),app_version INT,updated_at BIGINT NOT NULL`,
    user_business: `user_id VARCHAR(36) PRIMARY KEY,epoch BIGINT NOT NULL DEFAULT 0,reason VARCHAR(256),updated_at BIGINT NOT NULL`,
    user_limits: `user_id VARCHAR(36) PRIMARY KEY,config TEXT NOT NULL,updated_at BIGINT NOT NULL`,
    project_info: `id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,account_id VARCHAR(36) NOT NULL,name VARCHAR(128) NOT NULL,customer_id VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,epoch BIGINT NOT NULL DEFAULT 0,draft_version INT NOT NULL,tested_version INT,published_version INT,active_workflow VARCHAR(36),created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL`,
    project_versions: `project_id VARCHAR(36) NOT NULL,version INT NOT NULL,config ${text} NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(project_id,version)`,
    project_resources: `project_id VARCHAR(36) NOT NULL,environment VARCHAR(16) NOT NULL,kind VARCHAR(16) NOT NULL,version INT NOT NULL,bot_id VARCHAR(32) UNIQUE,username VARCHAR(32),channel_key VARCHAR(64),PRIMARY KEY(project_id,environment,kind)`,
    workflow_runs: `id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,user_id VARCHAR(36) NOT NULL,environment VARCHAR(16) NOT NULL,version INT NOT NULL,status VARCHAR(32) NOT NULL,business_epoch BIGINT NOT NULL,project_epoch BIGINT NOT NULL,lease VARCHAR(36),lease_until BIGINT NOT NULL DEFAULT 0,next_at BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL`,
    workflow_steps: `workflow_id VARCHAR(36) NOT NULL,position INT NOT NULL,code VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL,attempts INT NOT NULL DEFAULT 0,job_id VARCHAR(64),started_at BIGINT,completed_at BIGINT,error TEXT,PRIMARY KEY(workflow_id,position)`,
    telegram_visitors: `bot_id VARCHAR(32) NOT NULL,telegram_user_id VARCHAR(32) NOT NULL,user_id VARCHAR(36) NOT NULL,profile TEXT NOT NULL,first_seen_at BIGINT NOT NULL,last_seen_at BIGINT NOT NULL,PRIMARY KEY(bot_id,telegram_user_id)`,
    business_events: `id VARCHAR(36) PRIMARY KEY,event_key VARCHAR(64) NOT NULL UNIQUE,user_id VARCHAR(36) NOT NULL,project_id VARCHAR(36),bot_id VARCHAR(32),environment VARCHAR(16),version INT,type VARCHAR(32) NOT NULL,source VARCHAR(64),occurred_at BIGINT NOT NULL,data ${text} NOT NULL,raw_update ${text}`,
    business_dispatches: `id VARCHAR(36) PRIMARY KEY,user_id VARCHAR(36) NOT NULL,kind VARCHAR(32) NOT NULL,status VARCHAR(16) NOT NULL,started_at BIGINT NOT NULL,completed_at BIGINT`,
  };
  const result = Object.entries(definitions).map(([name, columns]) => `CREATE TABLE IF NOT EXISTS ${name} (${columns})${type === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : ''}`);
  for (const [name, table, columns] of [
    ['ix_apps_user','telegram_apps','user_id,id'],['ix_projects_user','project_info','user_id,id'],
    ['ix_workflows_pending','workflow_runs','status,next_at'],['ix_events_user','business_events','user_id,occurred_at'],
    ['ix_workflows_release','workflow_runs','project_id,environment,version,status'],['ix_steps_job','workflow_steps','job_id'],
    ['ix_events_project','business_events','project_id,occurred_at'],['ix_dispatch_user','business_dispatches','user_id,status'],
  ]) result.push(type === 'mysql' ? {name, table, sql:`CREATE INDEX ${name} ON ${table} (${columns})`} : `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})`);
  return result;
}
