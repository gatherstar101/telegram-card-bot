# Telegram Card Bot

Cloudflare Workers 接收 Telegram Webhook，在私聊收到 `/start` 后发送图片、文案和网址按钮。无图片时发送文字和按钮，无需数据库。

## 1. 准备

- 在官方 @BotFather 通过 `/newbot` 创建 Bot，保存 Token。
- 注册 Cloudflare 账号，准备卡片图片直链和文案。
- Token 通常是 `数字ID:密钥`，Bot 用户名和普通账号 ID 不是 Token。
- 不要提交真实 Token 或 Webhook 密钥；`.dev.vars.example` 只是配置模板，不会自动配置线上变量。

## 2. 部署

Cloudflare 控制台 → Workers & Pages → 创建应用 → 从 Git 仓库导入，选择本仓库。

- 部署命令：`npx wrangler deploy`
- 项目根目录：仓库根目录。
- 本项目无需构建；如果要求构建命令，可填写 `npm run check`。

也可以创建 Hello World Worker，在代码编辑器粘贴 `src/index.js` 并部署。使用提供的 `workers.dev` 地址，无需自有域名。

## 3. 配置运行时变量

Worker → Settings → Variables and Secrets，添加并保存部署：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| BOT_TOKEN | Secret | BotFather 返回的 Token |
| WEBHOOK_SECRET | Secret | 随机字符串，建议至少 32 位，只用字母、数字、下划线、短横线 |
| WEBHOOK_PATH | Text | `/webhook` |
| LANDING_URL | Text | 完整落地页地址，包含查询参数 |
| CARD_IMAGE | Text | 公网图片直链或 Telegram file_id，可省略 |
| CARD_TEXT | Text | 卡片文案；有图最多 1024 字符，无图最多 4096 字符 |
| BUTTON_TEXT | Text | 按钮文字 |

配置的是 Worker 运行时变量，不是 Git 构建环境变量。业务值不写入 wrangler 配置，方便在控制台修改。

## 4. 注册 Webhook

在 `scripts` 文件夹创建 `env` 文件（可复制 `env.example`），填写：

```ini
BOT_TOKEN=你的BotFather令牌
WEBHOOK_SECRET=与Cloudflare中完全一致的密钥
WORKER_URL=https://你的worker.你的子域.workers.dev
WEBHOOK_PATH=/webhook
```

支持空行、整行 `#` 注释和包裹值的单引号/双引号；值按原文读取，不执行命令或展开变量。不要使用 `export` 或行尾注释。`scripts/env` 已被 Git 忽略，不提交密钥。建议执行 `chmod 600 scripts/env`。

在 Bash 终端执行：

```bash
bash scripts/register-webhook.sh
```

脚本自动读取其所在目录的 `env`，不再交互输入。从 `scripts` 目录也可执行 `bash register-webhook.sh`。确认 setWebhook 返回 `ok: true`，getWebhookInfo 的 URL 正确。本地 env 只用于注册 Webhook，不会同步 Cloudflare 变量。

## 5. 测试

进入 Bot，点击 Start 或发送 `/start`，确认收到卡片，点击按钮检查完整落地页地址。

- 根路径返回 404、浏览器 GET 访问 Webhook 返回 405 是正常行为。
- 无回复：检查 getWebhookInfo 和 Worker 日志。
- 图片失败：检查直链是否能直接下载图片；先移除 CARD_IMAGE 验证文字发送。
- 修改图片、文案、按钮、落地页：保存并部署变量即可。
- 修改密钥、Token、路径或 Worker 地址：重新注册 Webhook。

普通网址按钮无法强制使用 TG 内置浏览器，取决于客户端和用户设置。基础版没有持久化去重，Telegram 重试时可能重复发送。不提供点击统计。

## 官方参考

- https://core.telegram.org/bots/api
- https://developers.cloudflare.com/workers/
