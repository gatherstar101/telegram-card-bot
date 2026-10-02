# Telegram Card Bot

Cloudflare Worker：在机器人私聊收到 `/start` 后返回图片、文案和网址按钮，无图片时返回文字和按钮。

Cloudflare Git 部署的项目根目录设为 `card-bot`，部署命令为 `npx wrangler deploy`。配置 Worker 的 BOT_TOKEN、WEBHOOK_SECRET、LANDING_URL，以及可选 CARD_IMAGE、CARD_TEXT、BUTTON_TEXT、WEBHOOK_PATH。

在本目录复制 `scripts/env.example` 为 `scripts/env`，填写对应 Token、Webhook 密钥、Worker URL 和路径，执行：

```bash
bash scripts/register-webhook.sh
```

打开机器人发送 `/start` 验证。完整的配置明细、本地开发和故障处理见 [项目 README](../README.md#2-telegram-card-bot)。
