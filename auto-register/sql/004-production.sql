-- Existing MySQL installations: run once after backup, on DB_DATABASE.
-- Prefer the locked migration command, which checks existing columns/indexes.
ALTER TABLE api_jobs ADD COLUMN project_id VARCHAR(36) NULL,
  ADD COLUMN workflow_id VARCHAR(36) NULL;
CREATE INDEX ix_workflows_release ON workflow_runs (project_id,environment,version,status);
CREATE INDEX ix_steps_job ON workflow_steps (job_id);
