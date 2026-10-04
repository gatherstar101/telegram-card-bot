# Legacy：Telegram Card Bot

本目录保留原有独立 Cloudflare Worker 的使用方式。`feature-cfworker` 的当前主服务是 [Cloudflare Bot 自动化 API](../README.md#build-and-verify)，已包含客户卡片和 Webhook 投递。本文供已有独立 Worker 部署或单独使用卡片入口时参考；原 Node.js Docker API 见 [auto-register 文档](../auto-register/README.md)。

Cloudflare Workers 使用已有 Bot Token，在私聊收到 `/start` 后发送固定图片、文案和网址按钮。无图片时发送文字和按钮。每个部署使用一组 Worker 环境变量，卡片服务无需 MySQL 或个人账号会话。适合已创建 Bot 的独立卡片接入。

如果已使用 Cloudflare 主服务或原 Docker API 的客户配置和 Webhook，卡片由对应 API 发送，无需部署本目录。同一个 Bot 注册到独立 Worker 后会替换原 API 的 Webhook，反之亦然。

### 准备

以下卡片服务命令均在 `card-bot/` 目录执行：

```bash
cd card-bot
```

- 使用主服务 API 创建 Bot 获取 Token，或在官方 @BotFather 通过 `/newbot` 手动创建。
- 注册 Cloudflare 账号，准备卡片图片直链和文案。
- Token 通常是 `数字ID:密钥`，Bot 用户名和普通账号 ID 不是 Token。
- 不要提交真实 Token 或 Webhook 密钥；`.dev.vars.example` 只是配置模板，不会自动配置线上变量。

### 使用流程

1. 准备 Bot Token、落地页网址，以及可选的图片和文案。
2. 将 `src/index.js` 部署到 Cloudflare Workers。
3. 设置 Worker 运行时变量和 Secrets，保存并部署。
4. 在本地配置 `scripts/env`，运行注册 Webhook 脚本。
5. 打开 `https://t.me/你的机器人用户名`，点击 Start 或发送 `/start`。

只响应私聊中的 `/start`（可带参数），忽略其他消息和群聊。配置了 `CARD_IMAGE` 时发送图片、文案和网址按钮；没有图片时发送文字和按钮。网址按钮只打开配置的网址，不在 API 服务中记录点击。

### 部署到 Cloudflare Workers

Cloudflare 控制台 → Workers & Pages → 创建应用 → 从 Git 仓库导入，选择本仓库。

- 部署命令：`npx wrangler deploy`
- 项目根目录：`card-bot`。
- 本项目无需构建；如果要求构建命令，可填写 `npm run check`。

也可以创建 Hello World Worker，在代码编辑器粘贴 `card-bot/src/index.js` 并部署。使用提供的 `workers.dev` 地址，无需自有域名。

### 配置运行时变量

Worker → Settings → Variables and Secrets，添加并保存部署：

| 名称 | 类型 | 必填 | 默认值/格式 | 用途 |
| --- | --- | --- | --- | --- |
| BOT_TOKEN | Secret | 是 | `数字ID:密钥` | 调用 Telegram Bot API；不是 App api_hash |
| WEBHOOK_SECRET | Secret | 是 | 1–256 位字母、数字、下划线或短横线，建议随机 32 位以上 | 验证 Telegram 请求，需与本地注册配置一致 |
| WEBHOOK_PATH | Text | 否 | `/webhook` | 接收 Webhook 的路径；修改后重新注册 |
| LANDING_URL | Text | 是 | 完整 `http://` 或 `https://` URL，可带查询参数 | 网址按钮目标 |
| CARD_IMAGE | Text | 否 | 空 | 公网图片直链或 Telegram file_id |
| CARD_TEXT | Text | 否 | `欢迎访问平台` | 有图最多 1024、无图最多 4096 个 JavaScript 字符，普通文本 |
| BUTTON_TEXT | Text | 否 | `立即进入平台` | 网址按钮文字 |

配置的是 Worker 运行时变量，不是 Git 构建环境变量。业务值不写入 wrangler 配置，方便在控制台修改。

### 本地开发

本地开发使用 `.dev.vars`，与 API 的 `.env` 独立：

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写上表的 Bot Token、Webhook 密钥、落地页等
npm run dev
```

Wrangler 显示本地地址；Telegram 注册 Webhook 需要可从公网访问的 HTTPS 地址，不能直接使用 localhost。通过 Cloudflare 控制台配置的线上变量不会自动写入本地 `.dev.vars`，本地配置也不会自动同步线上。

### 注册 Webhook

注册脚本将公网 Worker URL 和校验密钥提交给 Telegram，并查询 Webhook 信息。它只配置消息接收入口，不会部署 Worker 或创建 Bot。复制模板：

```bash
cp scripts/env.example scripts/env
chmod 600 scripts/env
```

编辑 `scripts/env`，填写：

```ini
BOT_TOKEN=你的BotFather令牌
WEBHOOK_SECRET=与Cloudflare中完全一致的密钥
WORKER_URL=https://你的worker.你的子域.workers.dev
WEBHOOK_PATH=/webhook
```

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| BOT_TOKEN | 是 | 与 Worker 的 BOT_TOKEN 完全一致 |
| WEBHOOK_SECRET | 是 | 与 Worker 的 WEBHOOK_SECRET 完全一致 |
| WORKER_URL | 是 | 公网 HTTPS 源地址，例如 `https://example.workers.dev`，不包含路径或查询参数 |
| WEBHOOK_PATH | 否 | 默认 `/webhook`；必须与 Worker 使用的路径一致 |

支持空行、整行 `#` 注释和包裹值的单引号/双引号；值按原文读取，不执行命令或展开变量。不要使用 `export` 或行尾注释。`scripts/env` 已被 Git 忽略，不提交密钥。建议执行 `chmod 600 scripts/env`。

在 Bash 终端执行：

```bash
bash scripts/register-webhook.sh
```

脚本自动读取其所在目录的 `env`，不再交互输入。从 `scripts` 目录也可执行 `bash register-webhook.sh`。确认 setWebhook 返回 `ok: true`，getWebhookInfo 的 URL 正确。本地 env 只用于注册 Webhook，不会同步 Cloudflare 变量。

### 测试和维护

| Worker HTTP 状态 | 含义 |
| --- | --- |
| 200 | 已处理，或消息不属于私聊 `/start` 而被忽略 |
| 400 | Webhook 请求不是有效 JSON |
| 403 | Telegram Secret Header 与配置不一致 |
| 404 | 请求路径不匹配 |
| 405 | Webhook 路径收到非 POST 请求 |
| 500 | 缺少密钥、落地页无效或文案超长 |
| 502 | Telegram 发送接口失败或网络请求异常 |

进入 Bot，点击 Start 或发送 `/start`，确认收到卡片，点击按钮检查完整落地页地址。

- 根路径返回 404、浏览器 GET 访问 Webhook 返回 405 是正常行为。
- 无回复：检查 getWebhookInfo 和 Worker 日志。
- 图片失败：检查直链是否能直接下载图片；先移除 CARD_IMAGE 验证文字发送。
- 修改图片、文案、按钮、落地页：保存并部署变量即可。
- 修改密钥、Token、路径或 Worker 地址：重新注册 Webhook。

普通网址按钮无法强制使用 TG 内置浏览器，取决于客户端和用户设置。基础版没有持久化去重，Telegram 重试时可能重复发送。不提供点击统计。

## 当前主服务

邮箱注册、Telegram 登录、Bot 自动创建、客户卡片和 Channel 管理见 [项目主 README](../README.md)。独立卡片 Worker 不读取主服务的 D1、Durable Objects 或原 MySQL/Redis，同一个 Bot 应只选择一个 Webhook 接收入口。
