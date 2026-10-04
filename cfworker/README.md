# Cloudflare Bot 自动化 API

Workers HTTP API + D1 四表 + Durable Objects 鉴权和 Telegram 账号协调。通过 Dashboard 关联资源，在 Settings → Variables and Secrets 配置运行时业务变量；构建无需业务环境变量、Account ID 或 D1 UUID。原生 Workers Builds 部署会保留界面设置的普通变量和 Secrets。

平台验证码默认 10 分钟、登录态 2 小时，Telegram StringSession 长期保存在 D1。首次业务请求自动初始化四张表，不需要本地 `.env` 或预先执行云端 SQL 才能启动业务。完整架构、API 请求 / 响应、持久化和 Docker 数据迁移见 [主 README](../README.md)。

<a id="configuration"></a>

## Cloudflare 运行时变量与资源绑定

业务配置全部在 Worker 的 **Settings → Variables and Secrets** 中设置，代码从请求的 `env` 读取；密钥选择 **Secret**，其他参数选择 **Text**。这些值在请求处理时使用，不需要提供给构建过程。Cloudflare 的 **Build Variables and Secrets** 是构建环境，不能代替运行时配置。[Cloudflare 配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

[.env.example](.env.example) 是运行时变量清单，只包含业务参数。Dashboard 部署无需上传 `.env`，无需填写 Account ID、部署 API Token 或数据库 UUID。Wrangler 已启用 `keep_vars: true`，且配置文件不写业务 `vars`，后续部署保留 Dashboard 设置的普通变量和 Secrets。[变量保留说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)。

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

## 使用流程

1. `POST /auth/register/start` → 邮件 code → `/auth/register/verify`，保存 access_token。
2. 携带 Bearer token 调用 `/v1/login/start`，传 App api_id/api_hash/phone，保存 account_id。
3. `/v1/accounts/:id/verify` 提交 Telegram code，必要时再提交两步验证 password。
4. `/v1/accounts/:id/bots` 传 name/username，返回并保存 Bot Token。
5. PUT `/v1/accounts/:id/bots/:username/landing` 传客户 ID 和落地页卡片配置。
6. 配置 PUBLIC_BASE_URL 后 POST 对应 `/webhook` 注册回调。
7. 按需创建 `/channels` 并调用 `/channels/:key/posts` 发布引导内容。

实际手机号验证码由用户从 Telegram 接收并通过 API 提交，本服务不会读取验证码。所有业务资源校验用户归属；账号路径标识本身不是登录凭据。
