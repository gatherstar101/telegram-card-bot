# Cloudflare Bot 自动化 API

本目录是 `feature-cfworker` 的部署入口。用户完成邮箱鉴权后登录个人 Telegram 账号，自动创建 Bot、查询 Token、配置客户 Landing Page 卡片、注册 Webhook，并按需创建 Channel 与发布帖子。服务采用 Workers HTTP API、D1 加密存储和 SQLite Durable Objects，运行时不依赖 MySQL、Redis、Docker 或 KV。

完整设计、全部环境变量、接口清单与 curl 示例见[项目主 README](../README.md)。已有部署升级时先阅读[生产升级与运行手册](PRODUCTION.md)：最新版本必填凭据加密密钥，创建操作返回 **HTTP 202 + job_id**，最终结果通过任务查询取得。

## 部署前准备

准备 Cloudflare Worker、D1、Telegram App api_id/api_hash 和支持 Resend 请求格式的 HTTPS 邮件服务。Telegram 凭据可以逐用户通过 API 提交；用户还需要本人登录码和可能的两步验证密码。App configuration 不能跳过个人账号认证。

| 绑定名 | 资源 |
| --- | --- |
| `DB` | D1 数据库 |
| `AUTH_STATE` | 当前 Worker 的 `AuthState` Durable Object |
| `TELEGRAM_ACCOUNTS` | 当前 Worker 的 `TelegramAccount` Durable Object |
| `WEBHOOK_DELIVERIES` | 当前 Worker 的 `WebhookDelivery` Durable Object |

已有数据库在 Dashboard **Bindings** 中以 `DB` 关联；无关联时 Wrangler 支持自动配置 D1，部署后核对实际资源。三个 DO 由 `wrangler.jsonc` 的 migrations 创建。保留绑定名、类名和已有迁移历史；资源对象无需写成 Text 环境变量。本版本没有 KV 绑定。

## 运行时配置

业务变量全部设置在 **Settings → Variables and Secrets**，请求时从 `env` 读取；**不要放在 Build Variables and Secrets**。Dashboard 部署无需业务构建变量、Account ID、D1 UUID 或手动上传 .env。本地 CLI 的部署认证另由 Wrangler 登录提供。[Cloudflare Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

| 变量 | 类型 | 要求 |
| --- | --- | --- |
| `AUTH_HMAC_SECRET` | Secret | 必填；至少 32 字符随机值 |
| `CREDENTIAL_KEYS` | Secret | 必填；JSON 密钥环，值为 32 字节随机密钥的 base64 |
| `CREDENTIAL_KEY_ID` | Text | 必填；例如 v1，必须存在于密钥环 |
| `MAIL_API_KEY` | Secret | 真实邮箱注册/登录必填 |
| `MAIL_FROM` | Text | 真实邮箱注册/登录必填，已验证的发件人 |
| `MAIL_API_URL` | Text | 默认 https://api.resend.com/emails，要求 HTTPS |
| `PUBLIC_BASE_URL` | Text | 注册 Webhook 时必填，本 API 的公网 HTTPS 源地址，不含路径 |
| `ADMIN_API_KEY` | Secret | 管理员迁移/禁用接口使用，至少 32 字符；不使用可省略 |

生成密钥后把输出分别填入 Dashboard：

```bash
# CREDENTIAL_KEYS；CREDENTIAL_KEY_ID 填 v1
node -e "console.log(JSON.stringify({v1:require('node:crypto').randomBytes(32).toString('base64')}))"
# AUTH_HMAC_SECRET；需要管理员 Token 时另外生成一个独立值
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

完整参数模板见 [.env.example](.env.example)，包含 TG 默认值、TTL、限流、配额、超时和保留时间；[主 README 配置表](../README.md#configuration)列出类型、默认值与范围。业务默认值包括：

- 邮件验证码 TTL 600 秒、平台会话 TTL 7200 秒，访问不续期。
- 获取验证码三个 start 接口共享每 IP 默认 1 QPS，可用 OTP_IP_QPS 调整。
- 同一邮箱注册/登录发码共享 60 秒冷却；同一 Telegram 手机号跨用户/IP 共享 60 秒冷却，失败也保留。
- 冷却或频率超限返回 429、Retry-After 和 retry_after；提高 QPS 不取消 60 秒间隔。
- 创建任务、Webhook 投递默认保留 7 天，结果未知的创建任务保留至核对。

邮件暂不配置时可部署、访问 `/health` 和运行模拟测试；真实发码及 `/ready` 返回 503。Workers 使用 HTTPS 邮件 API，不使用 SMTP。PUBLIC_BASE_URL 可以在仅登录/创建资源阶段省略，客户落地页地址另通过 landing API 传入。

## Dashboard 构建与部署

连接完整 Git 仓库，分支选择 `feature-cfworker`。自定义 Worker 名称时同步修改 `wrangler.jsonc`；仓库默认名称为 `telegram-cfworker-api`。

| 设置 | 值 |
| --- | --- |
| Root directory | `cfworker` |
| 依赖安装 | `npm ci` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| 业务 Build Variables | 无 |
| 静态网站输出目录 | 无，服务入口为 src/index.js |

构建要求 Node.js 22.12+。只安装本目录依赖，但保留 `../auto-register/api/` 共享业务代码。无需分别构建或部署其他服务。

build 依次执行语法检查、workerd 测试和 Wrangler dry-run 打包，失败中止默认部署流程；deploy 使用原生 wrangler deploy，不读取旧 dist/server/wrangler.json。配置启用 keep_vars，后续部署保留 Dashboard 普通变量；正常部署不会删除 Secret。[Wrangler 配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)。

部署后核对四个资源绑定，配置运行时变量并发布配置，然后检查：

```bash
curl https://YOUR_API_HOST/health
curl https://YOUR_API_HOST/ready
```

首次业务请求或 ready 自动初始化六张 D1 表与迁移记录，不清空数据；health 不触发建表。旧明文凭据另需管理员迁移。

## 本地开发与 CLI 发布

在本目录执行：

```bash
npm ci
if [ ! -f .dev.vars ]; then cp .dev.vars.example .dev.vars; fi
chmod 600 .dev.vars
# 编辑 .dev.vars，替换模板中的 HMAC 和凭据密钥
npm run dev
```

默认地址 `http://127.0.0.1:8787`。本地 D1/DO 保存于 `.wrangler/state/`，与线上资源独立；.dev.vars 不上传云端。需要完整邮箱流程时配置本地邮件变量。

```bash
npm run build
# 以下步骤会实际发布到 Cloudflare，先确认目标 Worker 和绑定
npx wrangler login
npm run deploy
```

直接 deploy 不运行测试，本地发布先 build。可选 `npm run secrets` 从 .env/进程环境上传五个 Secret 字段，Text 仍在 Dashboard 设置；它不属于构建步骤，详情见[主 README](../README.md#build-and-verify)。

手动初始化或应用后续 SQL 迁移：

```bash
npm run db:local
npm run db:remote -- YOUR_D1_DATABASE_NAME --remote
```

当前自动初始化只处理 0001/0002 的幂等 CREATE；未来 ALTER 和数据迁移需单独执行。数据库名是管理员命令参数，不是运行时变量。

## 使用顺序与任务接口

1. `/auth/register/start` → 邮件 code → `/auth/register/verify`，保存 access_token；后续登录改用 login/start、login/verify。
2. 携带平台 Bearer Token 调用 `/v1/login/start`，传 api_id/api_hash/phone，保存 account_id。
3. `/v1/accounts/:id/verify` 提交 Telegram code，必要时再提交 password。
4. `/v1/accounts/:id/bots` 传 name/username 和稳定 request_key，收到 202 与 job_id。
5. GET `/v1/accounts/:id/jobs/:job_id`，成功后读取 result.token；GET Bot 接口也可取回已保存 Token。
6. PUT `/v1/accounts/:id/bots/:username/landing` 保存客户与卡片配置，POST 对应 `/webhook` 注册回调。
7. 按需 POST `/channels`、`/channels/:key/posts`，分别查询任务结果取得频道邀请链接和帖子发送结果。

Bot request_key 可省略，默认用 username；其他任务显式传稳定 key。同路径、key 和参数复用原任务，不同参数返回 409。任务状态包括 queued/running/succeeded/failed/uncertain/cancelled；HTTP 202 只代表已受理。

结果未知时先通过 Bot/Channel reconcile 核对，再重试原任务。Webhook 投递按 update_id 去重，发送结果 uncertain 不自动重发，人工重试需 allow_duplicate=true。完整请求、状态与恢复边界见[API 清单](../README.md#api-reference)、[调用示例](../README.md#usage)和[任务与投递管理](../README.md#operations)。

## 持久化与升级

平台验证码/Token 保存在 AuthState；Telegram StringSession 加密存入 D1，不需要 *.json、tgsession.blob 或 Docker 目录。平台 logout/logout-all 与 Telegram logout 是独立操作。改密、用户禁用和会话版本更新使旧平台认证失效；Bot Token 可以核对后更新。退出不删除 Bot 或 Channel。

旧 Cloudflare 数据先备份，配置密钥和管理员 Token，再分页调用 `/admin/credentials/rewrap` 加密 tg_info/bot_info。创建接口调用方改为 202 后查询任务。密钥轮换保留仍被 DO 历史记录、未决任务与备份使用的旧版本，不要回滚到无法读取密文的旧代码。[完整升级与 MySQL 导入流程](../README.md#upgrade)。

## 验证与生产运行

`npm run build` 覆盖本地 workerd 回归和 dry-run。远端邮件/TG 操作默认模拟，不创建真实资源。可选 `npm run probe:telegram` 只验证 TCP/MTProto 握手和服务器配置，不发码、不登录、不创建 Bot。

生产上线前需在实际 Cloudflare 资源验证邮箱、Telegram、Bot/Channel、帖子与 Webhook 闭环，并配置边缘防护、监控、告警和备份恢复。ready 不在线验证实际邮件投递或 Telegram 会话，且默认 workers.dev 入口仍开启。限额、未知结果恢复、密钥轮换和运维步骤见 [PRODUCTION.md](PRODUCTION.md)。
