-- MySQL 8.0+; repeatable and does not delete existing data.
-- Default database matches .env.example. For a custom MYSQL_DATABASE,
-- replace telegram_bot in CREATE DATABASE and USE before importing.
CREATE DATABASE IF NOT EXISTS telegram_bot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE telegram_bot;

CREATE TABLE IF NOT EXISTS telegram_bots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  telegram_bot_id BIGINT UNSIGNED NOT NULL,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  name VARCHAR(64) NOT NULL,
  token VARCHAR(256) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_telegram_bot_id (telegram_bot_id),
  KEY ix_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
