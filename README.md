# Telegram Bot 自动化平台 · Cloudflare Workers

`feature-cfworker` 分支提供完整 Cloudflare API 服务：用户完成邮箱鉴权后，登录个人 Telegram 账号，自动创建 Bot、配置客户 Landing Page 卡片、注册 Webhook，并创建 Channel 和发布引导帖子。Workers 接收 API 和 Telegram 回调，D1 保存四张业务表，Durable Objects 保存验证码、平台登录态和操作锁，并协调同一手机号的 Telegram 操作。

**Cloudflare 版本只需安装和构建 `cfworker/`，部署整个仓库中的共享业务代码。** 无需部署 MySQL、Redis 或 Docker。`auto-register/` 保留原 Node.js Docker 部署方式，`card-bot/` 保留 Legacy 单 Bot 卡片 Worker。

- [设计与架构](#architecture)
- [环境变量](#configuration)
- [本地运行、构建和云端部署](#build-and-verify)
- [API 清单与完整调用示例](#api-reference)
- [持久化、退出和重试](#operations)
- [测试和验证范围](#verification)
- [Docker 与 Legacy 服务](#legacy-card-bot)

<a id="design"></a>
<a id="architecture"></a>

## 设计与架构

平台身份和 Telegram 身份分别认证。用户首先用邮箱、密码和邮件验证码获得本服务的 `access_token`，然后提交 Telegram App `api_id/api_hash`、手机号和 Telegram 验证码。启用 Telegram 两步验证的账号还需要提交密码。App configuration、网页端登录和服务器公钥不能跳过个人账号认证。

运行配置使用环境变量，用户自己的凭据和客户业务配置通过 API 传入。请求中的 App 凭据、手机号、Bot 名称和用户名优先于 `TG_*` 默认值。多用户部署应在请求中提供各自的配置，不设置共享手机号和 App 凭据。

```mermaid
flowchart LR
    Client[调用方] -->|邮箱密码与验证码| Worker[Workers API]
    Worker --> Mail[HTTP 邮件 API]
    Worker --> Auth[AuthState Durable Objects]
    Worker --> D1[(D1 四张业务表)]
    Client -->|Bearer access_token| Worker
    Worker --> Actor[按手机号分配 TelegramAccount]
    Actor --> D1
    Actor -->|Workers TCP / MTProto| Telegram[个人账号 / BotFather / Channel]
    Worker --> BotAPI[Telegram Bot API]
    BotAPI -->|Secret Webhook| Worker
    Worker -->|Start 后发送卡片| EndUser[Telegram 用户]
    EndUser --> Landing[客户 Landing Page]
```

`AuthState` 按认证键分配 Durable Object，使用 SQLite 同步事务消费一次性验证码、计数限流和释放操作锁。验证码默认 10 分钟有效，最多错误 5 次；平台登录态默认保留 2 小时，访问不续期。读取时检查过期时间，Alarm 负责清理，因此不会依赖 Alarm 准时执行来保证认证过期。

同一手机号的登录、确认验证码、Bot 和 Channel 操作进入同一 `TelegramAccount` 对象，并使用操作锁防止并发 BotFather 对话。Telegram TCP 连接只在当前请求内创建，操作结束后销毁；后续请求从 D1 的 StringSession 恢复登录。Durable Objects 不承担永久在线 Telegram 客户端。

认证采用 Durable Objects 而没有使用 KV：验证码只能消费一次，退出后的登录态应立即失效，需要原子操作和一致的读取。此版本不依赖 KV。D1 保留与 Docker 版本相同的四张业务表，SQLite 建表脚本位于 [0001_init.sql](cfworker/migrations/0001_init.sql)。

| 表 | 保存内容 |
| --- | --- |
| `user_info` | UUID 用户 ID、唯一邮箱、scrypt 密码哈希 |
| `tg_info` | account_id、用户归属、App 凭据、手机号、Telegram StringSession、登录与恢复状态 |
| `bot_info` | 用户归属、Bot 名称与 Token、客户 Landing Page、卡片、Webhook 配置 |
| `channel_info` | 用户归属、请求 key、频道 ID/access_hash、邀请链接、帖子及发送状态 |

`user_id` 在首次邮箱验证成功时自动生成，不由调用方自定义。每次发起新的 Telegram 登录生成一个 `account_id`，调用方保存它，或登录后通过 `GET /v1/accounts` 获取自己的列表。资源路径检查用户归属，访问他人的账号返回 404。Telegram 的 64 位频道 ID、access_hash 和 random_id 以字符串保存，避免 JavaScript 数字丢失精度。

客户 Landing Page 是客户已有的完整 URL；服务负责卡片按钮和频道引导链接，不生成或托管页面，也没有转化归因统计。频道成员需主动打开 Bot 并点击 Start 才能收到私聊卡片。Bot 创建通过个人账号与 BotFather 英文对话完成，仍受 Telegram 账号限制和用户名可用性影响。

```text
cfworker/                  Cloudflare 主服务，安装依赖和构建的入口
  src/index.js             HTTP API、鉴权、Webhook、账号操作路由
  src/auth-state.js        验证码、登录态、限流和锁的 Durable Object
  src/telegram-account.js  个人账号操作 Durable Object
  src/telegram-socket.js   Workers 原生 TCP 传输适配
  src/store.js             D1 存储适配
  src/schema.js            首次业务请求初始化四表和迁移记录
  migrations/              D1 四表 SQL 迁移
  scripts/                 可选 Secret 导入和 Telegram 连接探测
  test/                    workerd 运行时测试与可选 Telegram 探测
  wrangler.jsonc           原生部署配置；无账户 ID 或数据库 UUID
  .env.example             运行时变量清单及可选本地 Secret 导入模板
  .dev.vars.example        本地 Worker 环境变量与密钥模板
  README.md                Cloudflare 部署说明
  .wrangler/state/         本地模拟 D1 / Durable Objects 数据，不提交
auto-register/            Node.js Docker 服务及双方共享的业务逻辑
card-bot/                 Legacy 单 Bot 卡片 Worker
```

<a id="configuration"></a>

## Cloudflare 运行时变量与资源绑定

业务配置全部在 Worker 的 **Settings → Variables and Secrets** 中设置，代码从请求的 `env` 读取；密钥选择 **Secret**，其他参数选择 **Text**。这些值在请求处理时使用，不需要提供给构建过程。Cloudflare 的 **Build Variables and Secrets** 是构建环境，不能代替运行时配置。[Cloudflare 配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

[cfworker/.env.example](cfworker/.env.example) 是运行时变量清单，只包含业务参数。Dashboard 部署无需上传 `.env`，无需填写 Account ID、部署 API Token 或数据库 UUID。Wrangler 已启用 `keep_vars: true`，且配置文件不写业务 `vars`，后续部署保留 Dashboard 设置的普通变量和 Secrets。[变量保留说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)。

### 资源绑定

在 Worker 的 **Bindings** 页面配置或查看以下资源；它们是 Cloudflare 注入的对象，不是需要填写的字符串环境变量：

| 绑定名 | 类型 | 关联资源 |
| --- | --- | --- |
| `DB` | D1 database | 业务数据库，保存四张业务表 |
| `AUTH_STATE` | Durable Object | 当前 Worker 导出的 `AuthState` 类 |
| `TELEGRAM_ACCOUNTS` | Durable Object | 当前 Worker 导出的 `TelegramAccount` 类 |

D1 在 Dashboard 中创建后，以变量名 **DB** 关联到 Worker。仓库只声明绑定名，没有固定 database_id 或 database_name：部署到已绑定 DB 的 Worker 时复用该关联，首次没有 DB 时 Wrangler 可自动创建并绑定 D1；无需把 ID 写入环境变量或仓库。[D1 绑定](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database)、[资源自动配置](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。

两个 Durable Object 类和 SQLite 命名空间在首次代码部署时通过仓库的 `migrations` 声明创建，之后可在 Bindings 界面查看。保留仓库中的绑定名和类名。本版本没有 KV 绑定；验证码和登录态使用 Durable Objects 的原子操作。

关联资源后，第一次业务请求自动使用 D1 batch 初始化四张表和索引，并登记 `0001_init.sql` 到 Cloudflare 的 `d1_migrations` 迁移记录。初始化只执行 `IF NOT EXISTS`，不会清空数据；失败时请求失败，后续请求可重试。`/health` 只检查服务可响应，不触发建表。Durable Objects 内部的 SQLite 表在对应对象首次使用时初始化。

### 运行时变量清单

| 变量 | Dashboard 类型 | 要求 / 默认值 |
| --- | --- | --- |
| `AUTH_HMAC_SECRET` | **Secret** | 必填；至少 32 字符随机密钥，用于验证码 HMAC，更新部署时保留 |
| `MAIL_API_KEY` | **Secret** | 真实发邮件时必填；邮件服务 API key |
| `TG_API_HASH` | **Secret** | 可选单账号默认值；多用户建议在 API 请求里传 `api_hash` |
| `AUTH_CHALLENGE_TTL_SECONDS` | Text | 默认 `600`；允许 60–3600 秒 |
| `AUTH_SESSION_TTL_SECONDS` | Text | 默认 `7200`；允许 60–86400 秒 |
| `AUTH_STATE_PREFIX` | Text | 默认 `telegram-bot:`；认证键与账号对象命名空间，更新时保持一致 |
| `MAIL_API_URL` | Text | 默认 `https://api.resend.com/emails`；HTTPS 邮件 API |
| `MAIL_FROM` | Text | 真实发邮件时必填；已验证的发件人地址 |
| `PUBLIC_BASE_URL` | Text | 注册 Webhook 时必填；API 的公网 HTTPS 源地址，不含路径，其余流程可留空 |
| `TG_API_ID` | Text | 可选；请求未传 `api_id` 时使用 |
| `TG_PHONE` | Text | 可选；默认国际区号手机号，不含空格 |
| `TG_BOT_NAME` / `TG_BOT_USERNAME` | Text | 可选；创建请求未传名称 / 用户名时使用 |

在 Variables and Secrets 点击 Add，逐项设置类型、名称和值，再点击 Deploy 使配置生效。修改运行变量不需要重新构建代码。HMAC 可以在本地生成后填入 Secret：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

邮件 API 使用 Resend 兼容请求：Bearer 鉴权，JSON 字段 `from`、`to` 数组、`subject`、`text`。其他邮件厂商需提供兼容网关，或修改 `cfworker/src/auth-runtime.js`。Workers 不使用 `SMTP_*`。邮件配置留空仍可部署、健康检查和运行模拟测试，但真实注册 / 登录发送验证码时返回 503。

单用户可以使用 TG_* 默认值；多用户通过 `/v1/login/start` 提交各自的 App 凭据和手机号。Telegram 验证码和两步验证密码通过 `/verify` 提交，Bot 名称 / 用户名通过创建接口提交，不放在构建变量里。

### 构建和部署参数

业务构建不需要任何自定义环境变量。Worker 名称、兼容日期、`nodejs_compat`、Durable Object 生命周期和 CPU 预算属于 Wrangler 部署配置，写在 `cfworker/wrangler.jsonc`。默认名称 `telegram-cfworker-api`，默认 CPU 预算 30000 ms；CPU 预算不是网络等待时长，需要与账户计划匹配。

Dashboard 的 Workers Builds 管理部署认证，无需用户手工添加 `CLOUDFLARE_ACCOUNT_ID` 或 `CLOUDFLARE_API_TOKEN`。自行运行本地 Wrangler / 外部 CI 时仍需 Wrangler 登录或平台部署凭证，这些凭证供部署工具使用，不会传入 Worker 运行环境。

<a id="build-and-verify"></a>

## Cloudflare 构建、部署和使用

代码保持 Node.js 兼容的 JavaScript。需要 Node.js 22.12+。只安装 `cfworker/` 的依赖即可，但构建要保留完整仓库中的 `auto-register/api/` 共享模块。

### Dashboard 连接 Git 仓库

1. 在 Workers & Pages 创建或选择 Worker。Worker 名称使用 `telegram-cfworker-api`，自定义名称时同步修改 `cfworker/wrangler.jsonc` 的 `name`。
2. 如要使用已有数据库，在 **Bindings** 中以 **DB** 关联目标 D1，再启动代码部署；首次没有 DB 时可由 Wrangler 自动创建。
3. 连接 GitHub 仓库 `gatherstar101/telegram-card-bot`，生产分支选择 **feature-cfworker**。
4. 设置下面的构建参数。Workers Builds 使用所选 Worker / 账户的部署认证，不需要业务构建变量。
5. 部署后检查三个 Bindings，并在 **Settings → Variables and Secrets** 配置运行时变量，点击 Deploy。
6. 调用 `/health` 检查地址，再调用平台注册接口开始业务流程；首次业务请求自动建表。

| 构建设置 | 值 |
| --- | --- |
| Root directory | `cfworker` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| 自定义 Build Variables | 无业务变量需要填写 |
| Worker entry | `src/index.js`，由 Wrangler 配置指定 |
| 静态站点输出目录 | 无；这是 Worker API，不是 Pages 静态站点 |

`build` 使用 Wrangler dry-run，产物输出到 `dist/`，不访问远端账户或数据库，不会把业务密钥固化到构建产物或自动导入云端。`deploy` 是原生 `wrangler deploy`，不再依赖本地 `.env`、配置生成脚本或数据库 UUID 环境变量。

Cloudflare 默认的依赖安装步骤运行 `npm ci`，或在构建流程中显式执行它。Root directory 只决定命令工作目录，仍需保留 Git 仓库完整内容供共享模块打包。Durable Objects 类由 Wrangler 声明创建，不需要在 Build Variables 中添加绑定名或命名空间 ID。

运行配置完成后：

```bash
curl https://telegram-cfworker-api.YOUR_SUBDOMAIN.workers.dev/health
curl https://telegram-cfworker-api.YOUR_SUBDOMAIN.workers.dev/v1/accounts
# health 为 200；未提供 Bearer token 的 accounts 为 401
```

在运行时设置 `PUBLIC_BASE_URL` 为实际 Worker HTTPS 地址或自定义域名。它是本 API 的源地址，不是客户 Landing Page；注册 Webhook 自动拼接 `/webhooks/:bot_id`。仅登录、创建 Bot / Channel 时可留空。

后续向 `feature-cfworker` 推送会触发重新构建和部署。保留 Worker 名称、DB 绑定、DO 类名、`AUTH_STATE_PREFIX` 和 `AUTH_HMAC_SECRET`，即可继续使用已有用户和 Telegram session。

### 本地开发与构建验证

```bash
# 从仓库根目录开始
cd cfworker
npm ci
cp .dev.vars.example .dev.vars  # 已有文件时保留
chmod 600 .dev.vars
# 编辑 .dev.vars，填写 AUTH_HMAC_SECRET；邮件可暂时留空
npm run dev
```

默认地址 `http://127.0.0.1:8787`，D1 和 Durable Objects 本地模拟数据存入 `.wrangler/state/`。`.dev.vars` 仅供本地运行，不随构建上传到 Cloudflare。第一次业务请求自动建表，也可在本地预先执行 `npm run db:local`。

```bash
npm run check
npm test
npm run build
curl http://127.0.0.1:8787/health
```

普通测试在真实 workerd 中验证本地 D1 / Durable Objects，模拟外部邮件和 Telegram，不创建真实资源。可选 `npm run probe:telegram` 从 `.dev.vars` 或进程环境读取 App 凭据，只做真实 TCP / MTProto 握手和服务器配置查询，不发送验证码、不登录个人账号。

### 可选本地部署和批量导入 Secret

本地部署使用已登录的 Wrangler，不需要旧版 configure 步骤：

```bash
cd cfworker
npx wrangler login
npm run deploy
# CLI 的部署凭证属于工具配置，不是 Worker 的运行时变量
```

如果需要批量导入运行时 Secret，可在本地填写 `.env` 或使用进程环境，执行 `npm run secrets`。该脚本只读取 `AUTH_HMAC_SECRET`、`MAIL_API_KEY`、`TG_API_HASH` 三个 Secret 字段，经 stdin 调用原生 `wrangler secret bulk`；普通运行变量仍在 Dashboard 配置。指定 Worker 名称可用 `npm run secrets -- --name YOUR_WORKER_NAME`。此步骤不属于构建流程，Dashboard 已配置 Secret 时无需执行。

不要把整个运行时 `.env` 放进 Build Variables，也无需在云端保存配置文件。本地 `.env`、`.dev.vars`、旧 `wrangler.generated.json` 和 `.wrangler/state/` 均不提交。

### 后续数据库迁移

初始四表自动初始化并登记迁移。后续结构变更应新增迁移文件，不修改已发布的 `0001_init.sql`；对绑定的实际数据库执行：

```bash
# 用 Dashboard 中的实际 D1 名称替换 YOUR_D1_DATABASE_NAME
npm run db:remote -- YOUR_D1_DATABASE_NAME --remote
```

数据库名是管理命令的参数，不是 Worker 环境变量。自动初始化只创建初始表，不会自动 ALTER 已有表；新增迁移需要单独执行。备份和导入由管理员操作，不通过用户 API 访问 Cloudflare 控制面。

<a id="api-reference"></a>

## API 清单与完整调用示例

本地 Base URL 为 `http://127.0.0.1:8787`。API 用 JSON 接收参数并返回 JSON，POST / PUT 请求设置 `Content-Type: application/json`，请求体最大 16 KiB，所有成功请求当前均返回 HTTP 200。下面的步骤 0 给出完整平台鉴权示例，Docker 的 [AUTH.md](auto-register/AUTH.md) 补充旧服务鉴权细节，Cloudflare 的持久化与重试规则见本文后段。

平台注册/登录的 start、verify 接口无需已有令牌；`/auth/me`、`/auth/logout` 和所有 `/v1/*` 接口使用 `Authorization: Bearer <access_token>`。平台令牌默认 2 小时有效，访问不续期。每次新的 Telegram 登录生成一个独立 account_id，调用方保存它并用于验证码确认、创建和查询；account_id 本身不是鉴权凭据。资源路径会检查用户归属，访问他人的账号返回 404。

平台登录令牌、Telegram App api_hash 和 Bot Token 用途不同：access_token 用于调用本服务；api_id/api_hash 用于个人 Telegram 登录；Bot Token 用于 Telegram Bot API。App 配置不能跳过个人账号的验证码认证。

| 方法 | 路径 | 请求字段 | 返回内容 |
| --- | --- | --- | --- |
| POST | `/auth/register/start` | `email`、`password`；无需令牌 | 发注册邮件，返回 `challenge_id`、`status`、`expires_in` |
| POST | `/auth/register/verify` | `challenge_id`、`code`；无需令牌 | 创建用户，返回 `access_token`、`token_type`、`expires_in`、`user` |
| POST | `/auth/login/start` | `email`、`password`；无需令牌 | 校验密码后发登录邮件，返回 `challenge_id`、`status`、`expires_in` |
| POST | `/auth/login/verify` | `challenge_id`、`code`；无需令牌 | 返回新的平台登录令牌和用户信息 |
| GET | `/auth/me` | 无；本人 Bearer 凭据 | 当前用户 `id`、`email` |
| POST | `/auth/logout` | `{}`；本人 Bearer 凭据 | `{"ok":true}`，撤销当前平台令牌 |
| GET | `/v1/accounts` | 无；本人 Bearer 凭据 | 当前用户的 Telegram 账号列表 |
| GET | `/health` | 无；无需鉴权 | `{"ok":true}`；表示 HTTP 服务已启动，不实时探测 D1/Telegram |
| POST | `/v1/login/start` | `api_id`、`api_hash`、`phone`，可由环境变量提供 | `account_id`、`status`、`delivery` |
| POST | `/v1/accounts/:account_id/verify` | `code`；需要两步验证时提交 `password` | `account_id`、`status` |
| GET | `/v1/accounts/:account_id` | 无 | 已保存的账号标识和登录状态 |
| POST | `/v1/accounts/:account_id/bots` | `name`、`username`，可由环境变量提供 | `username`、`name`、`token`、`url` |
| GET | `/v1/accounts/:account_id/bots/:username` | 无 | D1 中已保存的 Bot 信息和 Token |
| PUT | `/v1/accounts/:account_id/bots/:username/landing` | `customer_id`、`landing_url`；可选卡片字段 | 保存并返回客户卡片配置 |
| GET | `/v1/accounts/:account_id/bots/:username/landing` | 无 | 读取客户卡片配置 |
| POST | `/v1/accounts/:account_id/bots/:username/webhook` | `{}` | 已注册的 Webhook URL |
| POST | `/v1/accounts/:account_id/channels` | `request_key`、`bot_username`、`title`；可选 `about` | Channel 信息和邀请链接 |
| GET | `/v1/accounts/:account_id/channels/:request_key` | 无 | Channel 的已保存状态 |
| POST | `/v1/accounts/:account_id/channels/:request_key/posts` | request_key、text | 帖子发送结果 |
| POST | `/webhooks/:bot_id` | Telegram Update；专属 Secret 请求头 | 接收 `/start` 并回复卡片，返回 `{"ok":true}` |

下面示例的 `YOUR_ACCESS_TOKEN` 是邮件验证码验证成功返回的令牌，`ACCOUNT_ID`、App 凭据和用户名也需要替换。

登录状态依次为 `code_required` → `password_required`（如启用两步验证）→ `authorized`。验证码和密码通过 verify 请求提交，API 不读取脚本专用的 `TG_PHONE_CODE`、`TG_PASSWORD` 环境变量。

`/health` 和 `/webhooks/:bot_id` 无需平台登录令牌；Webhook 必须携带 Telegram 的 `X-Telegram-Bot-Api-Secret-Token`，其余业务接口都需鉴权。

### 步骤 0：平台注册、登录和退出

首次注册提交邮箱及 12–128 字符的密码；邮箱会转为小写，密码中的空格会保留。邮件 API 留空时本步骤的发送邮件请求返回 503，需配置邮件服务后再执行真实注册。

```bash
curl -X POST http://127.0.0.1:8787/auth/register/start \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"YOUR_LONG_PASSWORD"}'
```

响应示例中的 UUID 为占位值。邮件验证码为六位数字，默认 10 分钟有效，不通过 API 返回：

```json
{"challenge_id":"00000000-0000-4000-8000-000000000001","status":"email_code_required","expires_in":600}
```

收到邮件后提交上一步返回的 challenge_id 和验证码：

```bash
curl -X POST http://127.0.0.1:8787/auth/register/verify \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"CHALLENGE_ID","code":"123456"}'
```

验证成功后创建 user_info 记录，返回平台登录令牌；响应中的用户 ID 与后续 Telegram account_id 是两个不同标识：

```json
{
  "access_token":"YOUR_ACCESS_TOKEN",
  "token_type":"Bearer",
  "expires_in":7200,
  "user":{"id":"00000000-0000-4000-8000-000000000002","email":"you@example.com"}
}
```

后续平台登录需要密码和新邮件验证码，调用以下两个接口，响应结构与注册流程相同；不能将注册 challenge 用于登录：

```bash
curl -X POST http://127.0.0.1:8787/auth/login/start \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"YOUR_LONG_PASSWORD"}'

curl -X POST http://127.0.0.1:8787/auth/login/verify \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"LOGIN_CHALLENGE_ID","code":"123456"}'

curl http://127.0.0.1:8787/auth/me \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'

curl http://127.0.0.1:8787/v1/accounts \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
```

`/auth/me` 返回 `{"id":"用户UUID","email":"you@example.com"}`。`/v1/accounts` 返回 `{"accounts":[]}` 或当前用户的 account_id、status、created_at 列表；查询不返回 App hash 和 Telegram session。

```bash
curl -X POST http://127.0.0.1:8787/auth/logout \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' -d '{}'
```

退出返回 `{"ok":true}`，当前平台令牌立即失效，其他登录令牌仍按各自 TTL 有效。平台退出不撤销 Telegram session，也不删除 Bot 或 Channel；Telegram 退出通过客户端设备列表操作。

### 步骤 1：发起登录，发送验证码

```bash
curl http://127.0.0.1:8787/v1/login/start \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"api_id":123456,"api_hash":"YOUR_APP_API_HASH","phone":"+8613800000000"}'
```

响应示例（account_id 每次不同）：

```json
{"account_id":"本次生成的UUID","status":"code_required","delivery":"telegram_app"}
```

服务在发送 Telegram 验证码后立即保存会话至 `tg_info`，关联当前平台用户，再返回 `account_id`。调用方也应保存这个值；验证码确认和后续创建使用同一个 account_id。向同一手机号重新发起登录会生成新标识，不会自动复用旧记录。

返回 `account_id`、`status: "code_required"`、`delivery`。`telegram_app` 表示通过 Telegram 客户端接收，`other` 表示其他渠道；本服务不保证短信发送。App 凭据和手机号已设置环境变量时可发送 `{}`。保存 `account_id`，后续调用均使用它，不需要重复发送验证码。

### 步骤 2：提交验证码，完成登录

```bash
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/verify \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345"}'
```

成功响应示例：

```json
{"account_id":"返回的账号标识","status":"authorized"}
```

成功返回 `status: "authorized"`。如返回 `password_required`，向同一接口再次提交 `{"password":"你的两步验证密码"}`；也可首次提交 `code` 和 `password` 两个字段。提交的验证码和两步验证密码不保存到数据库；MTProto session 和验证码流程所需的 phone_code_hash 保存于 tg_info。登录流程在本服务中 10 分钟后过期，Telegram 验证码也可能提前失效；重新调用登录接口获取新的 `account_id`。当前不支持注册个人 Telegram 账号、Telegram 额外邮箱认证或验证码自动读取。

### 步骤 3：创建指定 Bot，回传 Token

```bash
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/bots \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"客户 A 助手","username":"customer_a_unique_bot"}'
```

响应示例：

```json
{"username":"customer_a_unique_bot","name":"客户 A 助手","token":"123456:EXAMPLE_TOKEN","url":"https://t.me/customer_a_unique_bot"}
```

`name`、`username` 可分别由 `TG_BOT_NAME`、`TG_BOT_USERNAME` 提供默认值。BotFather 对话依赖英文提示，用户名占用、账号限制或回复变化会返回错误；超时后先检查 BotFather 对话，避免重复创建。不要同时手动操作该账号的 BotFather。服务只对已成功保存的结果去重，无法保证远程创建与本地写入之间的事务一致性。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| name | 请求或环境变量提供 | Bot 显示名称，1–64 字符；默认读取 TG_BOT_NAME |
| username | 请求或环境变量提供 | 全局唯一，5–32 位，字母开头、bot 结尾，仅含字母、数字、下划线；默认读取 TG_BOT_USERNAME |

### 步骤 4：配置客户 Landing Page 和卡片

```bash
curl -X PUT http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/bots/customer_a_unique_bot/landing \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{
    "customer_id":"customer_a",
    "landing_url":"https://customer-a.example.com/offer?source=telegram",
    "card_text":"欢迎查看客户 A 的活动",
    "card_image":"",
    "button_text":"查看活动"
  }'
```

| 字段 | 必填 | 限制或默认值 |
| --- | --- | --- |
| customer_id | 是 | 1–64 字符，绑定客户业务标识 |
| landing_url | 是 | 完整 HTTP(S) 地址，可带查询参数，不允许 URL 内嵌用户名密码 |
| card_text | 否 | 默认“欢迎访问平台”；有图片最多 1024，无图片最多 4096 字符 |
| card_image | 否 | 默认空；公网图片 URL 或 Telegram file_id，最多 2048 字符 |
| button_text | 否 | 默认“立即了解”，1–64 字符 |

PUT 保存完整配置，省略可选字段将恢复默认值。返回配置不含 Webhook 密钥。GET 同一路径可查询配置。不同 Bot 对应不同客户落地页，配置更新后后续 `/start` 使用新配置；不需要重新部署。Webhook 密钥在第一次配置时生成，后续更新保留。

### 步骤 5：注册 Bot Webhook

```bash
curl -X POST http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/bots/customer_a_unique_bot/webhook \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' -d '{}'
```

返回：

```json
{"username":"customer_a_unique_bot","webhook_url":"https://bots.example.com/webhooks/123456","status":"registered"}
```

用户私聊发送 `/start` 时，API 根据 Bot ID 从 D1 读取客户配置并发送图片或文字、网址按钮。这里由 Docker API 直接处理卡片，无需为每个客户部署 Cloudflare Worker。一个 Bot 只能设置一个 Webhook；注册到 Docker API 会替换该 Bot 之前的 Worker Webhook。独立 `card-bot` 仍可用于其他 Bot。

### 步骤 6：创建客户 Channel（可选）

```bash
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/channels \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{
    "request_key":"customer_a_channel_001",
    "bot_username":"customer_a_unique_bot",
    "title":"客户 A 活动频道",
    "about":"客户 A 的活动信息"
  }'
```

| 字段 | 必填 | 限制 |
| --- | --- | --- |
| request_key | 是 | 1–64 位字母、数字、下划线、短横线；同一账号下稳定且唯一 |
| bot_username | 是 | 当前账号已创建且已配置 landing 的 Bot 用户名 |
| title | 是 | 1–128 字符 |
| about | 否 | 最多 255 字符，默认空 |

创建的是私有广播频道，账号为创建者。响应包含 `request_key`、`channel_id`、`customer_id`、`bot_username`、`title`、`about`、`status: "ready"`、`invite_url`、`bot_url`，不返回 access_hash。当前不设置公开频道用户名，也不邀请用户或将 Bot 提升为管理员。发布通过登录用户账号完成。

GET `/v1/accounts/ACCOUNT_ID/channels/customer_a_channel_001` 查询已保存信息；GET 不会调用 Telegram。相同 request_key 和参数会返回已有频道，改变参数会返回 409。Channel 已创建但邀请链接生成失败时，使用同一 key 重试可继续生成链接。

Telegram 的 Channel 创建调用本身没有远程幂等键。如果发生网络错误，结果可能不确定，记录保留 `creating` 状态，服务返回 409 并禁止自动再次创建；先到 Telegram 检查，不应直接换 key 盲目重试。服务会先把已返回的创建结果保存到 tg_info.pending_channel，后续账号请求可据此补写 channel_info；如果 pending 写入也失败，需先核对 Telegram 中的实际结果。

### 步骤 7：发布转化引导帖子（可选）

```bash
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/channels/customer_a_channel_001/posts \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"request_key":"offer_post_001","text":"本周活动已上线，点击下方链接了解详情。"}'
```

| 字段 | 必填 | 限制 |
| --- | --- | --- |
| request_key | 是 | 1–64 位字母、数字、下划线、短横线；同一频道内唯一 |
| text | 是 | 1–3000 字符，加入链接后总长度不超过 4096 |

频道发布普通文字，并追加两个可点击链接：Bot Start 链接、配置的 Landing Page。响应含 `status: "sent"`、`message_id`（如 Telegram 返回）、`bot_url`、`landing_url` 和文本。已成功发送的同 key 请求直接返回保存结果；改变正文或落地页需使用新 key。待发送记录保存 Telegram random_id，重试使用同一 random_id 来降低重复发送风险。不要无限重复提交。

### 查询登录状态或取回已保存 Token

```bash
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl http://127.0.0.1:8787/v1/accounts/ACCOUNT_ID/bots/customer_a_unique_bot \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
```

状态查询返回本地记录；创建时会检查 Telegram 会话是否仍有效。Token 查询仅支持本服务保存的 Bot，不会从 BotFather 导入已有 Bot，也不会轮换 Token。获得的 Token 可用于独立 Cloudflare 卡片服务；Docker 卡片模式会自动从数据库读取 Token，无需再配置给 Worker。

账号 GET 只返回本地状态，`authorized` 不代表本次请求实时验证了 Telegram。创建新 Bot、创建 Channel、发布帖子会检查实际授权；缓存结果或配置查询不验证用户会话。当前没有单独的实时会话校验 API。

<a id="operations"></a>

## 持久化、退出和重试

Cloudflare 版的 Telegram session、Bot Token 和客户数据保存在 D1；不需要 `*.json`、`tgsession.blob` 或 Docker 挂载目录。验证码和平台登录态保存在各 AuthState 的 SQLite 存储，对象回收后仍可读取未过期的状态。删除本地 `.wrangler/state/` 只会丢失本地测试数据，不会删除云端 D1 或 Durable Objects。

`POST /auth/logout` 立即撤销当前平台 Bearer token，不撤销 Telegram 登录。平台 token 过期后，重新完成邮箱登录，再用原 account_id 操作。要撤销 Telegram 登录，在 Telegram 客户端「设置 → 设备」终止对应会话；D1 中原 session 随后无法通过真实 Telegram 认证。要更新 Telegram 登录，重新调用 `/v1/login/start` 和 verify 获取新的 account_id。目前不提供 Bot Token 轮换、删除账号、导入已有 Bot 或自动迁移旧 account_id 的 HTTP 接口。

邮箱发送间隔 60 秒；默认验证码 TTL 窗口内单邮箱最多 5 次发信、单 IP 最多 20 次 start / 60 次 verify，单邮箱最多 10 次密码校验。Workers 使用 Cloudflare 提供的 `CF-Connecting-IP` 限流。本地直接调用时应使用固定测试 IP。邮件验证码正确消费后即删除，最多错误 5 次；Durable Objects 认证读写失败时不会放行请求。

同一账号已有对应用户名的 Bot 记录时，创建接口直接返回保存的 Token。频道的 `request_key` 在账号内唯一，帖子的 key 在频道内唯一。参数相同的重试可复用已有结果，参数冲突返回 409。帖子重试复用持久化 random_id。频道处于 `creating` 或 BotFather 请求超时、客户端中断时，应先到 Telegram 核对远端结果，直接更换 key/用户名可能重复创建资源。

BotFather 对话最长可能等待多个 60 秒回复。客户端和上游代理应允许较长请求，例如 curl 使用 `--max-time 300`。本服务将结果在请求内返回，没有实现 Queues/Workflows 异步任务或断线后无限后台执行；Telegram 平台限制和 Cloudflare 网络、CPU 配额仍可能中断操作。

| HTTP 状态 | 含义和处理 |
| --- | --- |
| 400 / 413 | 参数、JSON 格式或请求体大小错误；最多 16 KiB |
| 401 | 平台令牌、验证码或 Telegram 登录失效，重新认证 |
| 403 / 405 | Webhook Secret 错误或使用非 POST 方法 |
| 404 | 接口/记录不存在，或账号不属于当前用户 |
| 409 | 操作冲突、资源 key 冲突、频道创建结果不确定 |
| 410 | Telegram 登录步骤超过 10 分钟，重新发送验证码 |
| 422 | Telegram 拒绝请求，或 BotFather 未接受创建；当前不支持额外邮箱认证和注册个人账号 |
| 429 | 邮箱/密码请求限流，或 Telegram FLOOD_WAIT |
| 500 | 内部存储、运行配置等错误，检查 Worker 日志和绑定 |
| 502 / 504 | Telegram API 失败或 BotFather 回复超时 |
| 503 | DB 绑定缺失，或邮件 API 未配置 / 发信失败 |

### 从 Docker 数据迁移

D1 是新的 SQLite 数据库，不会自动连接原 MySQL 或复用 Redis 登录态。现有 MySQL 和 Docker 服务保持可用。可使用 `auto-register/scripts/export-d1.js` 导出四张表并导入空 D1，保留用户 ID、密码哈希、account_id、Telegram StringSession、Bot Token 和频道记录：

```bash
# 仓库根目录；停用旧 API 的写入后导出，保留原 .env
cd auto-register
npm ci
node --env-file=.env scripts/export-d1.js
cd ../cfworker
# 已部署并绑定 DB；导入前初始化目标四表
npm run db:remote -- YOUR_D1_DATABASE_NAME --remote
npx wrangler d1 execute YOUR_D1_DATABASE_NAME --remote --file ../data/d1-export.sql
```

仅导入空表，唯一键冲突会报错，不覆盖已有用户。导出包含可用的账号凭据和 Bot Token，文件存入已忽略的 `data/` 并限制权限，导入后妥善处理。原 Redis 验证码、平台 token 和锁不迁移；用户重新完成邮箱登录，之后可使用原 account_id。导入应在维护窗口进行，避免新旧服务同时写入或同时操作同一 Telegram 手机号。Cloudflare 部署不自动读取或发送历史凭据。

<a id="verification"></a>

## 测试和验证范围

根目录 `npm run check` 检查 Cloudflare、Docker 和 Legacy 源码；`npm test` 验证 Docker 现有测试，`npm run cf:test` 验证 workerd 中的 Cloudflare API。`npm run cf:build` 验证 Cloudflare 打包。

当前已通过：D1 首次请求初始化、四表迁移及读写、密码哈希、邮箱注册和登录、验证码仅消费一次与错误次数限制、验证码/平台登录态过期、Durable Object 回收后的登录态持久化、退出撤销、多用户账号归属、客户卡片和 Webhook Secret、频道 64 位 ID 和帖子幂等。Telegram 登录、BotFather 创建、Channel/帖子流程使用模拟远端客户端验证；默认测试不会创建真实 Telegram 资源。

可选 `npm run probe:telegram` 已在本地 workerd 验证真实 Workers TCP 接口、MTProto 握手、Telegram 服务器配置查询及连接关闭。它使用临时未登录会话，未提交手机号验证码，不能证明真实用户登录或 Bot 创建成功。

尚未部署到真实 Cloudflare 账户，未验证云端 D1 / Durable Objects 配额或真实邮箱投递；用户登录、真实 Bot/Channel 创建及生产 Webhook 需要配置邮件服务和 Cloudflare 资源后再做端到端验证。

<a id="legacy-card-bot"></a>
<a id="docker-部署"></a>

## Docker 与 Legacy 服务

`auto-register/` 保留 Node.js Docker API、MySQL 四表和 Redis 鉴权，启动时仍自动建库建表。仅构建该目录即可运行 Docker 服务，已有环境变量和数据继续使用。完整 Docker 架构、配置、构建命令及 API 示例见 [Docker 部署文档](auto-register/DEPLOYMENT.md)，概要见 [auto-register/README.md](auto-register/README.md)。

`card-bot/` 是 Legacy 单 Bot 卡片 Worker，仅处理已有 Bot 的 `/start` 回复，不含平台注册、Telegram 个人账号登录、Bot 自动创建或 Channel 管理。完整配置和使用方法见 [card-bot/README.md](card-bot/README.md)。使用新 Cloudflare API 自带的卡片回复时，无需再部署 Legacy Worker。

根目录 `npm run dev` / `npm run deploy` 仍指向 Legacy；新服务使用 `npm run cf:dev` / `npm run cf:deploy`，或直接在 `cfworker/` 执行命令。
