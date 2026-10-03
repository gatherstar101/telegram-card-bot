# Cloudflare Bot 自动化 API

Workers HTTP API + D1 四表 + Durable Objects 鉴权和 Telegram 账号协调。用户先通过邮箱、密码和验证码登录平台，再操作自己拥有的 Telegram 账号、Bot、客户卡片、Webhook 和频道。验证码默认 10 分钟、平台登录态 2 小时，均由 Durable Objects 管理。Telegram StringSession 持久化到 D1，不保存本地会话文件。

完整架构、接口清单、请求与响应示例、持久化和迁移说明见 [主 README](../README.md)。安装只需本目录，但构建需要保留仓库中的共享 `auto-register/api/` 源码。API 路径与 Docker 版兼容；存储和邮件配置改用 Cloudflare 资源与 HTTP 邮件 API。

## 环境变量

本地 `cfworker/.dev.vars` 配置 Worker 运行环境；云端普通变量从 `cfworker/.env` 生成 Wrangler 配置，敏感变量通过 Worker Secrets 配置。Cloudflare 资源绑定 `DB`、`AUTH_STATE`、`TELEGRAM_ACCOUNTS` 由 Wrangler 创建/绑定，不能由 HTTP 请求指定。所有真实配置文件和本地持久化数据都已加入忽略规则。

| Worker 变量 | 要求 | 默认值 / 用途 |
| --- | --- | --- |
| `AUTH_HMAC_SECRET` | 必填 Secret | 至少 32 字符随机密钥；用于验证码 HMAC |
| `AUTH_CHALLENGE_TTL_SECONDS` | 可选 | `600`；允许 60–3600 秒 |
| `AUTH_SESSION_TTL_SECONDS` | 可选 | `7200`；允许 60–86400 秒 |
| `AUTH_STATE_PREFIX` | 可选 | `telegram-bot:`；认证键与账号对象命名空间，部署更新时保持一致 |
| `MAIL_API_URL` | 可选 | `https://api.resend.com/emails`；HTTPS 邮件 API |
| `MAIL_API_KEY` | 发邮件时必填 Secret | 邮件服务 Bearer API key |
| `MAIL_FROM` | 发邮件时必填 | 已验证的发件人地址 |
| `PUBLIC_BASE_URL` | 注册 Webhook 时必填 | API 的公网 HTTPS 源地址，不含路径；其余流程可留空 |
| `TG_API_ID` | 可选 | 请求未传 `api_id` 时的默认值 |
| `TG_API_HASH` | 可选 Secret | 请求未传 `api_hash` 时的默认值 |
| `TG_PHONE` | 可选 | 默认国际区号手机号，如 `+447000000001`，不含空格 |
| `TG_BOT_NAME` / `TG_BOT_USERNAME` | 可选 | 创建请求未传名称/用户名时使用 |

邮件 API 使用 Resend 兼容请求：`Authorization: Bearer ...`，JSON 字段 `from`、`to` 数组、`subject`、`text`。其他邮件厂商需提供兼容网关，或修改 `cfworker/src/auth-runtime.js`。Workers 版不使用原来的 `SMTP_*` 配置。邮件配置留空可验证健康接口、构建和本地模拟流程，真实发送验证码会返回 503，不能完成真实用户注册。

| 部署变量（`cfworker/.env` 或进程环境） | 要求 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 云端必填 | Cloudflare 账户 ID |
| `CLOUDFLARE_API_TOKEN` | CI 按需 | Wrangler 云端认证；本机也可使用 `wrangler login`，不写入 Worker |
| `CF_WORKER_NAME` | 可选 | 默认 `telegram-cfworker-api` |
| `CF_D1_DATABASE_NAME` | 可选 | 默认 `telegram_cfworker`；用于创建和绑定 D1 |
| `CF_D1_DATABASE_ID` | 云端必填 | 已创建 D1 数据库的 UUID；禁止使用占位 UUID 部署 |
| `CF_CPU_MS` | 可选 | 默认 `30000`，Worker CPU 时间预算，需匹配 Cloudflare 账户计划；不是网络等待时长 |

生产部署建议使用 Workers 付费计划，并核对 CPU 和 Durable Objects 额度。密码哈希和首次 MTProto 密钥协商会消耗 CPU；本地验证不能替代云端配额和网络验证。生成配置只复制普通 Worker 变量，绝不会把 HMAC、邮件密钥、App hash 或 Cloudflare API token 写入 JSON。

<a id="build-and-verify"></a>

## 本地运行、构建和云端部署

以下命令从仓库根目录开始。需要 Node.js 22.12+，推荐 Node.js 22 LTS。仅安装 `cfworker/` 的依赖即可，Wrangler 会打包仓库中的共享模块，不能只上传这个目录而丢弃 `auto-register/api/`。

### 本地开发

```bash
cd cfworker
npm ci
# 已有文件时保留原配置
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
# 编辑 .dev.vars，替换 AUTH_HMAC_SECRET；邮件配置可暂留空
npm run db:local
npm run dev
```

默认本地地址 `http://127.0.0.1:8787`。Wrangler 本地运行使用模拟 D1 和 Durable Objects，不需要 Cloudflare 账号或真实数据库 ID；数据持久化至 `cfworker/.wrangler/state/`。第一次启动前运行迁移初始化四表；以后新增迁移后再执行，无需每次重建数据库。

```bash
curl http://127.0.0.1:8787/health
npm run check
npm test
npm run build
```

`build` 是 `wrangler deploy --dry-run`，只验证打包，不上传服务。普通测试使用真实 workerd、本地 D1 和 Durable Objects，模拟外部邮件及 Telegram API，不发送真实邮件、验证码或创建 Telegram 资源。

可选的真实 Telegram TCP / MTProto 探测只查询服务器配置，不登录个人账号、不发送验证码，不保存会话或创建资源：

```bash
# 在 .dev.vars 内填写 TG_API_ID/TG_API_HASH，或在进程环境传入
npm run probe:telegram
```

### 云端部署

```bash
# 仍在 cfworker/，已有文件时保留
cp .env.example .env
chmod 600 .env
# 编辑 .env：CLOUDFLARE_ACCOUNT_ID、Worker 名称、D1 库名及普通运行变量
npx wrangler login
# 创建数据库；已有数据库跳过此步
npm run db:create
# 将创建命令返回的 database_id 填入 .env 的 CF_D1_DATABASE_ID
npm run configure
npm run deploy
```

`configure` 生成 `wrangler.generated.json`，校验账户 ID、D1 UUID、库名和 TTL。`deploy` 先执行远端 D1 迁移，迁移成功后部署 Worker，部署失败时不清空已有数据。D1 数据库由 Cloudflare 控制面创建，不能在 Worker HTTP 启动时创建；SQL 表在部署前通过迁移初始化。Durable Objects 的 SQLite 存储在各对象首次使用时初始化。

初次部署后配置敏感变量（也可在 Cloudflare Dashboard 的 Worker Secrets 添加）。若要全部通过环境变量提供，在 `.env` 填写 `AUTH_HMAC_SECRET`、`MAIL_API_KEY` 和可选 `TG_API_HASH`，执行 `npm run secrets`，脚本通过 stdin 上传，不写入生成的 JSON 或临时文件。只有变量名称进入命令行，密钥在 Wrangler 提示中输入：

```bash
npx wrangler secret put AUTH_HMAC_SECRET --config wrangler.generated.json
# 接入真实邮件时再配置
npx wrangler secret put MAIL_API_KEY --config wrangler.generated.json
# 只有使用全局 Telegram App 默认值时才需要
npx wrangler secret put TG_API_HASH --config wrangler.generated.json
```

更新 `.env` 的 `PUBLIC_BASE_URL` 为实际 Worker `https://名称.账户子域.workers.dev` 或自定义域名，配置 `MAIL_FROM`，重新执行 `npm run configure && npm run deploy`。`PUBLIC_BASE_URL` 是调用本 API 的地址，不是客户 Landing Page；注册 Webhook 时自动拼接 `/webhooks/:bot_id`。无需卡片 Webhook 时可一直留空。

CI 通过环境变量提供 Cloudflare token，也可以不创建 `.env`，直接运行 `node scripts/configure.js` 和 `node scripts/wrangler.js deploy`。token 需要针对目标账户的 Worker、Durable Objects 和 D1 管理权限；不要提交到代码库。运行端的 HMAC 和邮件 key 使用 Worker Secrets。

后续更新保持 Worker 名称、D1 ID、`AUTH_STATE_PREFIX` 和 `AUTH_HMAC_SECRET` 不变：

```bash
npm ci
npm test
npm run build
npm run configure
npm run deploy
```

手工执行远端 SQL 迁移可用 `npm run db:remote`。新增表结构用新的迁移文件，不修改已执行迁移。备份、数据导入和数据库迁移由管理员执行，不通过用户 API 访问 D1 控制面。


## 使用流程

1. `POST /auth/register/start` → 邮件 code → `/auth/register/verify`，保存 access_token。
2. 携带 Bearer token 调用 `/v1/login/start`，传 App api_id/api_hash/phone，保存 account_id。
3. `/v1/accounts/:id/verify` 提交 Telegram code，必要时再提交两步验证 password。
4. `/v1/accounts/:id/bots` 传 name/username，返回并保存 Bot Token。
5. PUT `/v1/accounts/:id/bots/:username/landing` 传客户 ID 和落地页卡片配置。
6. 配置 PUBLIC_BASE_URL 后 POST 对应 `/webhook` 注册回调。
7. 按需创建 `/channels` 并调用 `/channels/:key/posts` 发布引导内容。

实际手机号验证码由用户从 Telegram 接收并通过 API 提交，本服务不会读取验证码。所有业务资源校验用户归属；账号路径标识本身不是登录凭据。
