#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE="$SCRIPT_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Missing configuration: %s. Copy env.example to env and fill in values.\n' "$ENV_FILE" >&2
  exit 1
fi

# Parse literal KEY=VALUE lines; never execute configuration as shell code.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  REPLY="$value"
}
BOT_TOKEN=''
WEBHOOK_SECRET=''
WORKER_URL=''
WEBHOOK_PATH='/webhook'
while IFS= read -r line || [[ -n "$line" ]]; do
  trim "$line"
  line="$REPLY"
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ "$line" != *=* ]]; then
    printf 'Invalid env line: expected KEY=VALUE.\n' >&2
    exit 1
  fi
  trim "${line%%=*}"; key="$REPLY"
  trim "${line#*=}"; value="$REPLY"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  case "$key" in
    BOT_TOKEN|WEBHOOK_SECRET|WORKER_URL|WEBHOOK_PATH)
      printf -v "$key" '%s' "$value" ;;
    *) printf 'Unsupported env key: %s\n' "$key" >&2; exit 1 ;;
  esac
done < "$ENV_FILE"

for key in BOT_TOKEN WEBHOOK_SECRET WORKER_URL WEBHOOK_PATH; do
  if [[ -z "${!key}" ]]; then
    printf 'Missing configuration: %s\n' "$key" >&2
    exit 1
  fi
done
if [[ ! "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  printf 'Invalid BOT_TOKEN format.\n' >&2; exit 1
fi
if [[ ! "$WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]{1,256}$ ]]; then
  printf 'Invalid WEBHOOK_SECRET format.\n' >&2; exit 1
fi
if [[ ! "$WORKER_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ||
      ! "$WEBHOOK_PATH" =~ ^/[A-Za-z0-9/_-]*$ ]]; then
  printf 'Invalid WORKER_URL or WEBHOOK_PATH.\n' >&2; exit 1
fi
curl --fail-with-body --silent --show-error \
  --request POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL%/}${WEBHOOK_PATH}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
printf '\n'
curl --fail-with-body --silent --show-error \
  "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
printf '\n'
