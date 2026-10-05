-- Existing PostgreSQL database: stop application traffic before upgrading.
-- Then run npm run backfill:phones with credential keys before accepting logins.
ALTER TABLE tg_info ADD COLUMN IF NOT EXISTS phone_key VARCHAR(64);
CREATE INDEX IF NOT EXISTS ix_tg_phone ON tg_info (phone_key,status,user_id);
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS remote_message_id VARCHAR(32);
