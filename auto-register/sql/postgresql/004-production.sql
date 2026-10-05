-- Existing PostgreSQL installations: run on DB_DATABASE after backup.
-- Prefer the locked migration command for coordinated startup upgrades.
ALTER TABLE api_jobs ADD COLUMN IF NOT EXISTS project_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS workflow_id VARCHAR(36);
CREATE INDEX IF NOT EXISTS ix_workflows_release ON workflow_runs (project_id,environment,version,status);
CREATE INDEX IF NOT EXISTS ix_steps_job ON workflow_steps (job_id);
