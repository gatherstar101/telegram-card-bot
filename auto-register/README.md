# Legacy：Node.js Bot 自动化创建与客户转化 API

本目录保留原 Node.js Docker 服务。`feature-cfworker` 的当前主服务见 [Cloudflare 版本](../README.md)，其使用 D1、Durable Objects、加密凭据和持久化任务；本文描述 MySQL/Redis 与同步业务接口的使用方式，配置和接口能力以本目录文档为准。

Node.js Docker 服务通过已登录个人 Telegram 账号创建 Bot 和私有 Channel，并将不同客户的 Landing Page、卡片及帖子配置保存到 MySQL。每个用户先完成邮箱、密码及邮件验证码认证，再管理自己的 Telegram 会话、Bot 和 Channel。不同用户的账号路径检查归属。

- [设计与架构](#设计与架构)
- [部署和配置](#部署和配置)
- [构建、更新和检查](#构建更新和检查)
- [API 接口清单](#api-接口清单)
- [按步骤使用](#按步骤使用)
- [完整 API 请求和响应示例](DEPLOYMENT.md#api-reference)

## 设计与架构

平台邮箱身份与个人 Telegram 账号分别认证。平台 access_token 默认 2 小时有效，由 Redis 管理；Telegram session 长期存入 MySQL，并通过 user_id 和 account_id 关联 Bot、客户卡片和 Channel。接口分步执行，所有账号路径校验用户归属。运行配置使用环境变量，每个用户的 App 凭据和业务内容通过 API 传入。

完整的架构图、身份模型、四表关系及配置原则见 [Docker 架构说明](DEPLOYMENT.md#architecture) 和 [环境变量需求](DEPLOYMENT.md#configuration)。Legacy 独立卡片部署见 [card-bot 文档](../card-bot/README.md)。

## 部署和配置

整套 Node.js Docker API 只构建本目录，包含平台鉴权、Telegram 登录、Bot、Landing Page 卡片、Webhook、Channel 和帖子发布。MySQL、Redis 连接现有服务；`card-bot/` 保留为 Legacy Cloudflare Worker，使用本 API 回复卡片时无需部署它。

以下命令在本目录执行，已有 `.env` 时保留原文件：

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
# 编辑 .env，填写下表配置
docker compose up -d --build
```

| 环境变量 | 用途 |
| --- | --- |
| AUTH_HMAC_SECRET | 必填，至少 32 字符的随机验证码 HMAC 密钥 |
| AUTH_CHALLENGE_TTL_SECONDS / AUTH_SESSION_TTL_SECONDS | 默认 600 / 7200 秒；验证码和平台登录态 TTL |
| REDIS_URL 或 REDIS_HOST | 必填；Redis 连接，URL 优先；可配置 PORT、DB、USER、PASSWORD、KEY_PREFIX |
| SMTP_HOST / SMTP_FROM | 发邮件必填；端口、TLS、用户名、密码均通过 SMTP_* 配置，见 AUTH.md |
| API_PORT | 默认 3100，宿主机端口，仅监听 127.0.0.1 |
| MYSQL_HOST / MYSQL_PORT | 已有 MySQL 地址和端口，默认端口 3306 |
| MYSQL_DATABASE | 自动创建的数据库名，1–64 位字母、数字或下划线 |
| MYSQL_USER / MYSQL_PASSWORD | 必填；用户需有目标库 CREATE、SELECT、INSERT、UPDATE 权限 |
| PUBLIC_BASE_URL | 注册 Webhook 时必填；指向本服务的公网 HTTPS 源地址，不含路径 |
| TG_API_ID / TG_API_HASH / TG_PHONE | 可选登录默认值，也可在请求中提供 |
| TG_BOT_NAME / TG_BOT_USERNAME | 可选 Bot 默认值，也可在请求中提供 |

从 my.telegram.org 的 API development tools 获取 App 凭据。App 凭据不等于 Bot Token，首次还需要验证个人账号。手机号使用 `+` 加国家区号和数字，不含空格。MySQL 在宿主机发布端口时可用 `MYSQL_HOST=host.docker.internal`；容器的 localhost 指向 API 容器自己。

启动先建库及四张业务表并连接 Redis，成功后监听 API。完整 Redis 和 SMTP 变量及注册、后续登录步骤见 [AUTH.md](AUTH.md)。Dockerfile 使用 Node.js 22、非 root 用户和健康检查。完整的变量限制和 Docker run 部署方式见 [Docker 配置说明](DEPLOYMENT.md#build-and-verify)。

SMTP 可以留空，基础服务仍能启动；注册/登录发送邮件时返回 503，真实邮箱鉴权需配置邮件服务后才能使用。PUBLIC_BASE_URL 可暂不填写，注册 Webhook 时再设置。

## 构建、更新和检查

以下命令在本目录执行，使用现有 MySQL 8.0+ 和 Redis 6.0+，Compose 只创建 API 容器。构建读取 package-lock.json 安装依赖，不连接 Telegram、不创建资源。运行时所有配置均从环境变量传入，镜像不包含真实 .env。

```bash
docker compose config --quiet
docker compose build telegram-api
docker compose up -d --no-build telegram-api
docker compose ps
docker compose images
docker compose logs --tail 50 telegram-api
curl -i http://127.0.0.1:3100/health
curl -i http://127.0.0.1:3100/v1/accounts
```

正常情况下容器随后显示 healthy，health 返回 HTTP 200，未登录请求 accounts 返回 HTTP 401。修改 .env 后用 `docker compose up -d telegram-api` 重新创建容器；restart 不加载新环境变量。更新代码时先 build 再 up，并保留原数据库、Redis DB/前缀、鉴权密钥和旧会话迁移卷。

本地 Node.js 22 源码检查和单元测试：

```bash
npm ci
npm run check
npm test
```

API 启动后可运行真实 MySQL/Redis 集成测试，使用与 API 相同的鉴权密钥、数据库和 Redis 配置。下面示例假设数据库与 Redis 均发布到宿主机端口；远程连接、Redis URL 或其他 API 端口需按实际配置调整：

```bash
INTEGRATION_TEST=1 MYSQL_HOST=127.0.0.1 REDIS_HOST=127.0.0.1 \
  TEST_API_URL=http://127.0.0.1:3100 \
  node --env-file=.env --test test/integration.test.js
```

集成测试用进程内 SMTP 接收器捕获邮件，不要求配置外部 SMTP、不创建真实 Telegram 资源，完成后清理临时业务记录。有效期检查使用默认 600/7200 秒。完整镜像构建、更新和验证范围见 [Docker 构建说明](DEPLOYMENT.md#build-and-verify)。

## API 接口清单

Base URL 默认为 `http://127.0.0.1:3100`。POST/PUT 使用 `Content-Type: application/json`，最大请求体 16 KiB；成功响应均为 HTTP 200，失败响应为 `{"error":"错误说明"}`。表中“用户令牌”指 `Authorization: Bearer <access_token>`，不是 App hash 或 Bot Token。

| 方法 | 路径 | 鉴权 | 参数或用途 |
| --- | --- | --- | --- |
| POST | `/auth/register/start` | 无 | email、password → 邮件验证码 challenge_id，默认 10 分钟 |
| POST | `/auth/register/verify` | 无 | challenge_id、code → 用户信息和 access_token，默认 2 小时 |
| POST | `/auth/login/start` | 无 | email、password → 新的邮件验证码 challenge_id |
| POST | `/auth/login/verify` | 无 | challenge_id、code → 新的 access_token |
| GET | `/auth/me` | 用户令牌 | 当前用户 id、email |
| POST | `/auth/logout` | 用户令牌 | 撤销当前平台令牌，返回 ok |
| GET | `/v1/accounts` | 用户令牌 | 列出本人 Telegram 账号及状态 |
| POST | `/v1/login/start` | 用户令牌 | api_id、api_hash、phone → account_id 和验证码发送方式 |
| POST | `/v1/accounts/:account_id/verify` | 用户令牌 | code；必要时 password → Telegram 登录状态 |
| GET | `/v1/accounts/:account_id` | 用户令牌 | 保存的 Telegram 登录状态，不实时验证授权 |
| POST | `/v1/accounts/:account_id/bots` | 用户令牌 | name、username → Bot 信息、Token 和 URL |
| GET | `/v1/accounts/:account_id/bots/:username` | 用户令牌 | 查询保存的 Bot 信息和 Token |
| PUT | `/v1/accounts/:account_id/bots/:username/landing` | 用户令牌 | customer_id、landing_url；可选 card_text、card_image、button_text |
| GET | `/v1/accounts/:account_id/bots/:username/landing` | 用户令牌 | 查询客户卡片和落地页配置 |
| POST | `/v1/accounts/:account_id/bots/:username/webhook` | 用户令牌 | 空 JSON，注册专属 Webhook；需 PUBLIC_BASE_URL |
| POST | `/v1/accounts/:account_id/channels` | 用户令牌 | request_key、bot_username、title；可选 about → Channel 和邀请链接 |
| GET | `/v1/accounts/:account_id/channels/:request_key` | 用户令牌 | 查询 Channel 状态和邀请链接 |
| POST | `/v1/accounts/:account_id/channels/:request_key/posts` | 用户令牌 | request_key、text → 引导帖子发布结果 |
| GET | `/health` | 无 | HTTP 健康检查 |
| POST | `/webhooks/:bot_id` | 专属 Webhook Secret | 接收 Telegram Update，处理私聊 /start |

Webhook Secret 通过 `X-Telegram-Bot-Api-Secret-Token` 请求头提交。所有账号资源都检查所属用户，访问其他人的 account_id 返回 404。平台令牌访问不续期，退出不撤销 Telegram 会话。密码为 12–128 字符，邮件 code 为六位数字；Telegram code 和 password 通过 verify 接口提交。

完整 curl、请求字段限制、成功响应和错误码见 [根 README API 文档](DEPLOYMENT.md#api-reference)，邮件限流及旧会话迁移见 [AUTH.md](AUTH.md)。

## 按步骤使用

| 顺序 | 方法和路径 | 参数及结果 |
| --- | --- | --- |
| 0 | POST `/auth/register/start`、`/auth/register/verify` | email、password，再提交邮件 code → access_token |
| 1 | POST `/v1/login/start` | api_id、api_hash、phone → account_id、code_required |
| 2 | POST `/v1/accounts/:id/verify` | code；必要时 password → authorized |
| 3 | POST `/v1/accounts/:id/bots` | name、username → token、Bot URL |
| 4 | PUT `/v1/accounts/:id/bots/:username/landing` | customer_id、landing_url、卡片字段 → 配置 |
| 5 | POST `/v1/accounts/:id/bots/:username/webhook` | 空 JSON → 已注册 Webhook URL |
| 6 | POST `/v1/accounts/:id/channels` | request_key、bot_username、title、about → 私有频道和邀请链接 |
| 7 | POST `/v1/accounts/:id/channels/:key/posts` | request_key、text → 发布结果及 Bot/落地页链接 |

每次登录生成独立 account_id，API 返回后调用方保存；验证和后续创建使用同一个 ID。已有有效会话时从第 3 步继续。只有客户 Bot 卡片需求时第 5 步即完成；第 6、7 步用于频道投放。

先按 [AUTH.md](AUTH.md) 注册/登录取得平台令牌。业务接口使用 `Authorization: Bearer <access_token>`；邮箱注册/登录接口不需要已有令牌，`/auth/me` 和 `/auth/logout` 需要。`/health` 公开；`/webhooks/:bot_id` 使用专属 Webhook Secret。POST/PUT 使用 JSON，字段和可直接执行的 curl 示例见 [根 README 完整步骤](DEPLOYMENT.md#api-reference)。客户参数、Channel 幂等键和恢复行为也可参阅 [CONVERSION.md](CONVERSION.md)。

用户点击频道中的 Bot 链接并按 Start 后，服务读取对应 Bot 的客户配置发送卡片；卡片按钮打开 Landing Page。帖子也包含落地页直接链接。不会自动私信频道成员，不生成落地页或统计成交。

## 数据和维护

MySQL 四张业务表为 user_info、tg_info、bot_info、channel_info。Telegram session 和登录阶段直接写 tg_info，客户配置合并到 bot_info，帖子合并到 channel_info.posts JSON。Redis 保存 10 分钟邮件验证码和 2 小时平台登录态。旧 `/data/<account_id>.json` 卷保留用于迁移，命令和归属规则见 [AUTH.md](AUTH.md)。重建容器需保留数据库、Redis 数据及 account_id。

```bash
docker compose ps
docker compose logs --tail 50 telegram-api
curl http://127.0.0.1:3100/health
docker compose restart telegram-api
```

GET `/v1/accounts/:id` 返回已保存状态，不实时证明 Telegram 授权有效；创建新资源和发布时会检查实际授权。GET Bot、Landing 和 Channel 路径读取保存结果。Channel 和帖子重试使用原 request_key，先查询状态再决定是否继续。

在 Telegram 设置的设备/活跃会话中终止该会话可以退出；平台提供 `/auth/logout` 撤销当前平台令牌，Telegram 会话没有 HTTP 退出接口，已创建资源和 Token 不会因此删除。`docker compose down` 保留数据，`down -v` 删除旧会话迁移卷。凭据、会话及 Token 应保密，不提交 `.env`。

## 验证范围

Docker、真实 MySQL/Redis 读写、进程内 SMTP 发信、HTTP 邮件验证码验证、登录令牌有效期及用户隔离已验证。此前真实 Telegram 登录和会话授权已验证。客户卡片及 Channel 流程有模拟测试；真实 SMTP 邮箱投递、Bot/Channel 创建、帖子发布、公网 Webhook 收发尚未实测。

本地检查命令：

```bash
npm ci
npm run check
npm test
```

另有独立命令行创建脚本，配置 `scripts/create-bot.env` 后运行 `npm run create:bot`，仅保存本地会话和 Token；其配置明细见 [根 README](DEPLOYMENT.md#可选通过-nodejs-脚本自动创建-bot)。
