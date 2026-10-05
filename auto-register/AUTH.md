# 用户注册、登录与数据归属

平台账号和个人 Telegram 账号分别认证。先用邮箱、密码和邮件验证码注册平台用户，取得 `access_token`，然后调用 Telegram 登录接口。后续平台登录仍需密码和新的邮件验证码。所有配置从环境变量读取，模板见 [.env.example](.env.example)。

管理员由必填 `ADMIN_EMAIL/ADMIN_PASSWORD` 在启动时直接创建，无需邮箱验证。管理员使用 `POST /admin/login` 提交 email/password 直接获取会话，不发送邮件；普通用户仍按以下邮件验证流程操作。用户管理和审计接口见[主 README](../README.md#api-reference)。

普通 `/auth/login/start`、`/auth/login/verify` 不提供管理员登录。全部 `/admin/*` 接口共享 Redis IP 防爆破：默认同 IP 一小时内累计两次认证失败后封禁 3600 秒，第二次及封禁期间返回 429 和剩余秒数；正确凭据也不能绕过封禁。业务参数错误不计入，成功认证不清零计数，封禁请求不延长 TTL。

## 环境配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| AUTH_HMAC_SECRET | 无，必填 | 至少 32 字符的随机密钥，给邮箱验证码生成 HMAC；可用 `openssl rand -hex 32` 生成 |
| ADMIN_EMAIL | 无，必填 | 管理员账号邮箱，首次启动直接创建，无需验证邮件 |
| ADMIN_PASSWORD | 无，必填 | 12–128 字符，仅首次创建时写入密码哈希；重启不覆盖 |
| ADMIN_AUTH_MAX_FAILURES | 2 | 同一 IP 在计数窗口内管理员认证失败达到此次数时封禁 |
| ADMIN_IP_BAN_SECONDS | 3600 | 管理员 IP 封禁时长及失败计数窗口，秒 |
| AUTH_CHALLENGE_TTL_SECONDS | 600 | 注册/登录邮件验证码有效期，范围 60–3600 秒 |
| AUTH_SESSION_TTL_SECONDS | 7200 | 平台 Bearer 登录态有效期，范围 60–86400 秒 |
| REDIS_URL | 空 | 如 `redis://:password@redis:6379/0`，优先于分项配置 |
| REDIS_HOST / REDIS_PORT | host.docker.internal / 6379 | 现有 Redis 的连接地址 |
| REDIS_DB | 0 | Redis 数据库编号 |
| REDIS_USER / REDIS_PASSWORD | 空 | Redis ACL 用户和密码，可按实际情况配置 |
| REDIS_KEY_PREFIX | telegram-bot: | Redis 键前缀，多套部署应使用不同前缀 |
| SMTP_HOST / SMTP_FROM | 空，发邮件必填 | SMTP 主机及发件人邮箱 |
| SMTP_PORT | 587 | SMTP 端口，隐式 TLS 通常使用 465 |
| SMTP_SECURE | false | 465 通常设为 true，587 使用 false 和 STARTTLS |
| SMTP_REQUIRE_TLS | true | 要求 STARTTLS；仅本地测试邮件服务器可设 false |
| SMTP_USER / SMTP_PASSWORD | 空 | 服务器要求鉴权时同时填写；可使用邮箱服务的应用密码 |

服务启动时必须连接关系数据库和 Redis。未配置 SMTP 时可以启动，管理员可直接登录，但普通用户发送验证码会返回 503，无法完成邮件注册或登录。生产环境应通过 HTTPS 访问 API。默认按 TCP 来源 IP 限流；可信反向代理后可按实际层数设置 TRUST_PROXY_HOPS，且必须禁止绕过代理。完整新增运行配置见主 README。

## 注册与登录接口

| 方法 | 路径 | JSON 字段 | 结果 |
| --- | --- | --- | --- |
| POST | /auth/register/start | email、password | 发注册邮件，返回 challenge_id、expires_in |
| POST | /auth/register/verify | challenge_id、code | 创建 user_info，返回 access_token、user、expires_in |
| POST | /auth/login/start | email、password | 校验密码，发登录邮件，返回 challenge_id |
| POST | /auth/login/verify | challenge_id、code | 返回新的 access_token |
| POST | /auth/logout-all | 无 | Bearer 鉴权后撤销全部平台会话与旧登录验证 |
| POST | /auth/password | current_password、new_password | 改密并撤销全部平台会话 |
| GET | /auth/me | 无 | Bearer 鉴权后返回用户 id、email、role |
| POST | /auth/logout | 无 | Bearer 鉴权后撤销当前登录令牌 |
| GET | /v1/accounts | 无 | Bearer 鉴权后列出本人保存的 Telegram account_id 和状态 |

邮箱会转换为小写。密码为 12–128 字符，使用随机盐和 scrypt 哈希写入关系数据库，保留密码中的空格。六位邮件验证码不通过 API 返回，也不写入日志；同一 challenge 最多错误 5 次、成功后立即销毁，并且不能将注册验证码用于登录。

```bash
curl -X POST http://127.0.0.1:3100/auth/register/start \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"YOUR_LONG_PASSWORD"}'

# 从邮箱取验证码，将上一步返回的 challenge_id 填入。
curl -X POST http://127.0.0.1:3100/auth/register/verify \
  -H 'Content-Type: application/json' \
  -d '{"challenge_id":"CHALLENGE_ID","code":"123456"}'

curl http://127.0.0.1:3100/auth/me \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl http://127.0.0.1:3100/v1/accounts \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
```

后续登录将 start/verify 路径替换为 `/auth/login/start` 和 `/auth/login/verify`。每次验证成功生成独立的 2 小时令牌；访问不会续期，无刷新令牌接口。Redis 仅保存令牌 SHA-256 摘要对应的用户 ID 和到期时间。退出仅撤销本次平台令牌，不终止 Telegram 会话，不删除 Bot。

邮件同一邮箱最多每 60 秒发送一次，每个验证码有效期窗口最多 5 次；鉴权入口同一来源 IP 最多 20 次，验证入口 60 次；同一邮箱密码检查最多 10 次。获取验证码四个 start 接口还共享每 IP 默认 1 QPS，Telegram 同手机号跨用户/IP 有 60 秒冷却，发送失败也保留；超限返回 429、Retry-After 和 retry_after。Redis 不可用时不会放行受保护接口。

## 四张业务表

| 表 | 数据和关系 |
| --- | --- |
| user_info | 用户 id、唯一邮箱、密码哈希、注册时间；普通用户验证码通过后创建，管理员由 env 初始化 |
| tg_info | account_id、user_id、api_id、api_hash、手机号、MTProto session、登录阶段、待确认验证码信息、待补写创建结果 |
| bot_info | user_id、account_id、Bot ID、用户名、显示名、Token，以及客户落地页、卡片和 Webhook 配置 |
| channel_info | user_id、account_id、request_key、Bot/客户关联、Channel ID、access_hash、邀请链接、状态，以及 posts JSON 中的帖子幂等记录 |

关系为 `user_info.id → tg_info.user_id`，以及 `tg_info.account_id → bot_info.account_id / channel_info.account_id`；服务检查这些归属关系，数据库目前通过索引关联，没有外键级联删除。不同用户访问他人的 account_id、Bot 或 Channel 返回 404。customer_id 仅是业务标识，不能代替平台身份。旧共享 API_KEY 不再用于业务鉴权。

服务按 DB_TYPE 选择 MySQL 或 PostgreSQL，自动创建环境变量 `DB_DATABASE` 指定的库及核心业务表。初始化 SQL 见 [MySQL SQL](sql/init.sql) 和 [PostgreSQL SQL](sql/postgresql/init.sql)。DB_AUTO_CREATE_DATABASE=false 可连接已有库，仍初始化表/索引。数据库配置只读取 DB_*。最新版本包含原十表及十四张产品表，共 24 张表，见[统一流程](PRODUCT-FLOW.md)。凭据与队列载荷使用 CREDENTIAL_KEYS/CREDENTIAL_KEY_ID 加密；旧明文库按 [PRODUCTION.md](PRODUCTION.md) 分页迁移。Telegram session 不受平台 2 小时 TTL 影响，支持 /v1/accounts/:id/logout 或客户端设备列表撤销。

## 旧 JSON 会话迁移

升级保留旧数据卷和旧表，但不会自动将它们分配给新注册用户。先完成归属邮箱的平台注册，然后由部署管理员运行：

```bash
docker compose exec \
  -e MIGRATE_ACCOUNT_ID=OLD_ACCOUNT_ID \
  -e MIGRATE_EMAIL=you@example.com \
  telegram-api npm run assign:account
```

`DATA_DIR` 默认本地 `./data`，Compose 为 `/data`；只用于读取旧 `<account_id>.json`。脚本将该会话导入 tg_info，保留 account_id，不删除原文件，也不允许转移已属于他人的账号。新 API 登录直接存关系数据库，不再创建 JSON 会话文件。旧 Bot/客户/Channel 表的数据需要由管理员确认归属后迁移，不能仅凭知道旧 account_id 通过 HTTP 认领。

## 普通用户密码恢复

POST /auth/password/reset/start 提交 email，接收邮件 OTP；POST /auth/password/reset/verify 提交 challenge_id/code/new_password，成功后撤销全部会话，重新登录。沿用验证码 TTL、60 秒邮件冷却及发码 QPS。管理员不能用此流程重置。Telegram App 自助配置与测试/生产流程见 [PRODUCT-FLOW.md](PRODUCT-FLOW.md)。
