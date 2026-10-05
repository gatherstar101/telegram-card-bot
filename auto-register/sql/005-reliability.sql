-- Existing MySQL database: run each addition once, or use npm run migrate.
-- Stop application traffic, then run npm run backfill:phones with credential keys.
ALTER TABLE tg_info ADD COLUMN phone_key VARCHAR(64) NULL;
CREATE INDEX ix_tg_phone ON tg_info (phone_key,status,user_id);
ALTER TABLE webhook_deliveries ADD COLUMN remote_message_id VARCHAR(32) NULL;
