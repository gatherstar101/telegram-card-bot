#!/usr/bin/env bash
set -euo pipefail
trap 'unset TG_BOT_TOKEN TG_WEBHOOK_SECRET TG_WORKER_URL TG_WEBHOOK_PATH' EXIT
read -rsp 'Bot Token: ' TG_BOT_TOKEN
printf '\n'
read -rsp 'WEBHOOK_SECRET: ' TG_WEBHOOK_SECRET
printf '\n'
read -rp 'Worker URL (without trailing slash): ' TG_WORKER_URL
read -rp 'WEBHOOK_PATH [/webhook]: ' TG_WEBHOOK_PATH
TG_WEBHOOK_PATH=${TG_WEBHOOK_PATH:-/webhook}
curl --fail-with-body --silent --show-error \
  --request POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${TG_WORKER_URL%/}${TG_WEBHOOK_PATH}" \
  --data-urlencode "secret_token=${TG_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
printf '\n'
curl --fail-with-body --silent --show-error \
  "https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo"
printf '\n'
