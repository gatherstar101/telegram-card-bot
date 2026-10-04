# 生产升级与运行手册

本分支的 Cloudflare API 使用 AES-256-GCM 加密账号凭据，按 IP/用户/邮箱/手机号限流，通过 Durable Object SQLite 与 Alarm 执行持久化任务和 Webhook 投递。它仍依赖 Telegram、邮件服务以及 Cloudflare 配额；本地测试通过不等于已达到某个线上可用性 SLA。仓库新增 Cloudflare API checks 工作流，执行语法、Docker/Workers 测试与 dry-run 构建，不部署资源。npm run build 本身先执行语法与 workerd 测试，失败就不会进入默认 Workers Builds 的部署步骤。直接执行 Wrangler 或 npm run deploy 不运行这套检查，本地发布要先运行 npm run build。部署前要在独立测试 Worker 完成真实邮件、Telegram 登录、Bot/Channel、Webhook 和容量验证。

## 升级影响与配置

构建方式不变：Root directory `cfworker`，Build command `npm run build`，Deploy command `npm run deploy`。不要使用 `dist/server/wrangler.json`。所有下列参数均为 **Settings → Variables and Secrets 的运行时配置**，不放入 Build Variables。

新增必填配置：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `CREDENTIAL_KEYS` | Secret | JSON 密钥环，例如 `{"v1":"32 字节随机密钥的 base64"}`；保留读取旧数据需要的旧密钥 |
| `CREDENTIAL_KEY_ID` | Text | 当前写入密钥版本，例如 `v1`；必须存在于密钥环 |
| `ADMIN_API_KEY` | Secret | 管理员接口使用的至少 32 字符随机凭据；不用管理员接口可不配置，接口会关闭 |

分别生成密钥后放入 Cloudflare Secrets，勿提交生成结果：

```bash
node -e "console.log(JSON.stringify({v1:require('node:crypto').randomBytes(32).toString('base64')}))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

原 `AUTH_HMAC_SECRET`、邮件服务、`PUBLIC_BASE_URL` 和 TG 默认参数继续使用，见根 README。`npm run secrets` 可从本地 `.env` 经 stdin 上传 AUTH_HMAC_SECRET、MAIL_API_KEY、TG_API_HASH、CREDENTIAL_KEYS、ADMIN_API_KEY；CREDENTIAL_KEY_ID 是 Dashboard Text。

新增 `WEBHOOK_DELIVERIES` 绑定，类型 Durable Object，类名 `WebhookDelivery`。Wrangler 的 `v2` migration 会创建其 SQLite 命名空间，保留原 AUTH_STATE、TELEGRAM_ACCOUNTS 和 DB 关联。D1 增加 `user_security`、`channel_posts` 两张辅助表：前者保存禁用标记和会话版本，后者把新增帖子拆成独立记录，避免不断扩大的单行 JSON。旧帖子 JSON 仍可读取，重试完成后写入独立记录。0001 原迁移不变；首次业务请求自动应用两个仅包含幂等 CREATE 的迁移。后续 ALTER 或数据迁移仍须管理员明确执行。

### 运行时限流、配额与保留时间

| 变量 | 默认 | 允许范围 / 用途 |
| --- | --- | --- |
| `OTP_IP_QPS` | 1 | 1–100；邮箱注册发码、邮箱登录发码与 Telegram 发码共享每 IP 每秒上限 |
| `API_IP_PER_MINUTE` | 120 | 1–10000；非 Webhook API 每 IP 分钟上限 |
| `API_USER_PER_MINUTE` | 60 | 1–10000；已鉴权业务每用户分钟上限 |
| `WEBHOOK_IP_PER_MINUTE` | 1200 | 1–10000；Webhook 每 IP 分钟上限；Telegram 共享 IP，按实际流量调整 |
| `TG_LOGIN_PER_TEN_MINUTES` | 5 | 1–20；每用户 Telegram 发码次数 |
| `TG_CREATE_PER_TEN_MINUTES` | 10 | 1–100；每用户 Bot/Channel 创建请求次数，包括重复提交 |
| `MAX_TG_ACCOUNTS_PER_USER` | 5 | 1–100；过期未完成的 Telegram 登录在新请求时清理，已保存账号仍计数 |
| `MAX_BOTS_PER_USER` | 20 | 1–1000；每用户已保存 Bot 上限，Telegram 自身上限也适用 |
| `MAX_CHANNELS_PER_USER` | 50 | 1–1000；每用户 Channel 记录上限 |
| `TELEGRAM_TIMEOUT_SECONDS` | 60 | 15–240；同步 Telegram 操作的连接和操作总超时 |
| `JOB_TIMEOUT_SECONDS` | 240 | 30–240；任务中一次 Telegram 连接及操作的总超时 |
| `JOB_QUEUE_LIMIT` | 20 | 1–100；同一手机号待执行或运行中任务总量 |
| `JOB_RETENTION_SECONDS` | 604800 | 86400–2592000；已完成/失败/取消任务保留秒数；结果不确定的任务保留至核对 |
| `WEBHOOK_CHAT_PER_MINUTE` | 5 | 1–60；每 Bot 每私聊分钟上限，超过后确认接收但不再发卡片 |
| `WEBHOOK_BOT_PER_MINUTE` | 300 | 1–3000；每 Bot 每分钟上限，超过后确认接收但不再发卡片 |
| `WEBHOOK_QUEUE_LIMIT` | 500 | 1–10000；每 Bot 待处理投递队列上限，满时返回 503 |
| `WEBHOOK_BATCH_SIZE` | 10 | 1–30；每次 Alarm 最多顺序处理的卡片数，批次之间至少 1 秒 |
| `WEBHOOK_RETENTION_SECONDS` | 604800 | 172800–2592000；投递和去重记录保留秒数 |

**同一邮箱的注册/登录发码共享 60 秒冷却；同一 Telegram 手机号跨用户、跨 IP 共享 60 秒冷却。** 冷却保存在 AuthState，并非进程内计时。发送失败或响应未知也保留冷却。拒绝时返回 HTTP 429、Retry-After 秒数以及 JSON `retry_after`。Telegram 验证码提交每 account_id 10 分钟最多 5 次。原邮箱 OTP 五次错误上限和验证码 600 秒 TTL、平台会话 7200 秒 TTL 保留。

IP 限流读取 Cloudflare 注入的 CF-Connecting-IP。公网部署需配合自定义域名 WAF/边缘限流；应用层限流已经发生了 Worker/DO 调用，不能替代抵御分布式流量和费用攻击的边缘措施。生产使用自定义域名边缘规则时，应在对应 Wrangler 部署配置中关闭 workers_dev 和 preview_urls，避免直接入口绕过域名保护；当前仓库保留 workers.dev 便于首次部署，不能据此认为域名防护已经落实。管理员路径建议再用 Cloudflare Access 限制访问。共享办公网络和 Telegram 出口 IP 的阈值应以压测结果调整。

## 旧数据加密与密钥轮换

在维护窗口停用旧服务写入，记录 D1 恢复书签并保存密钥。部署新代码、配置密钥后，普通 API 默认拒绝读取明文凭据。管理员迁移接口只返回计数与游标，不返回任何凭据：

```bash
curl -X POST https://API_HOST/admin/credentials/rewrap \
  -H 'Authorization: Bearer YOUR_ADMIN_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"table":"tg_info","cursor":"","limit":50}'
# 将返回的 next_cursor 放入下一次请求，直到 done=true
# 再对 table=bot_info 做同样的分页迁移
```

每批最多 100 行；更新使用旧值比较，避免覆盖并发变化。此接口支持管理员显式迁移明文，不需要开启普通 API 的明文读取。手机号、api_hash、session、phone_code_hash、pending_bot、pending_channel、Bot Token、Webhook Secret 以带随机 nonce 和版本的密文保存；AAD 绑定账号/Bot 与字段，跨记录调换密文会解密失败。密码继续使用 scrypt 哈希。

轮换时先在 CREDENTIAL_KEYS 中加入新版本并保留旧版本，再切换 CREDENTIAL_KEY_ID，分页调用 rewrap 重加密 D1。**不能仅迁移 D1 就删除旧密钥**：DO 中的任务载荷/Token 结果、Webhook 投递载荷和历史备份也可能使用旧版本。等相关记录保留期结束，确认没有旧版本未决任务，并根据备份恢复策略保留旧密钥。当前管理员 rewrap 不修改 DO 历史记录。

D1 导出/Cloudflare 平台存储加密不能代替应用密钥隔离。密钥应单独备份，限制 Cloudflare Secrets 和数据库的管理员权限。只有数据库和密钥一起可用，才可恢复账号凭据。

## 持久化任务 API

以下 POST 改为 **HTTP 202**，返回 job_id；调用方不要再从创建请求直接读取 token 或 invite_url：

- `/v1/accounts/:id/bots`
- `/v1/accounts/:id/channels`
- `/v1/accounts/:id/channels/:key/posts`
- `/v1/accounts/:id/bots/:username/reconcile`
- `/v1/accounts/:id/channels/:key/reconcile`

```bash
curl -X POST https://API_HOST/v1/accounts/ACCOUNT_ID/bots \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"request_key":"bot-create-001","name":"客户助手","username":"customer_unique_bot"}'
# {"job_id":"64位任务标识","account_id":"...","status":"queued",...}

curl https://API_HOST/v1/accounts/ACCOUNT_ID/jobs/JOB_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
# 成功时 {"status":"succeeded","result":{"username":"...","token":"...",...},...}
```

只有资源所有者可查询任务。Bot 的 request_key 可省略，此时使用 username；其他任务必须传稳定的 request_key。相同路径、key、参数返回同一个任务，不同参数返回 409。任务 body 只接受该接口支持的字符串字段。GET 列表 `/v1/accounts` 最多返回 100 条；返回 next_cursor 时用 `?after=...` 继续。

任务状态：queued、running、succeeded、failed、uncertain、cancelled。Alarm 在持久化记录后执行任务，客户端断线不终止已排队任务。执行前重新检查用户禁用状态、会话版本和账号归属；注销全部平台会话会取消未开始的旧版本任务，已执行远端动作无法撤回。同一手机号只进行一个 Telegram 操作，同一用户的 Bot/Channel 创建另有租约锁保护配额检查。

```bash
curl -X POST https://API_HOST/v1/accounts/ACCOUNT_ID/jobs/JOB_ID/retry \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' -d '{}'
```

重试允许 failed、uncertain、cancelled。结果已保存在 D1 时直接恢复为 succeeded；没有创建副作用检查点的失败可以重新排队。帖子复用原 random_id，但 Telegram 去重不应被视为无限期的 exactly-once 保证。创建 Bot 后还会调用 getMe 核对返回 Token 的用户名和 ID。明确的 BotFather 用户名拒绝可安全重试；无法识别的创建回复或核验失败保留 uncertain。结果未知的 Bot/Channel 不自动再次创建；需要先核对并恢复。已明确拒绝的 Channel 创建会删除 creating 预留，可安全重试原任务。

### 核对 Bot 与 Channel

Bot 在 Telegram 已创建、D1 未保存时：

```bash
curl -X POST https://API_HOST/v1/accounts/ACCOUNT_ID/bots/customer_unique_bot/reconcile \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"request_key":"bot-reconcile-001"}'
```

任务通过该个人账号向 BotFather 请求已有 Bot 的 Token，并用 Bot API getMe 核对用户名，再加密保存。不再次执行 /newbot；BotFather 无法确认时保留失败供人工核对。此过程仍依赖 BotFather 对话提示，勿与手工对话同时操作。

Channel 需要从 Telegram 管理工具取得已创建频道的 ID/access_hash：

```bash
curl -X POST https://API_HOST/v1/accounts/ACCOUNT_ID/channels/CHANNEL_KEY/reconcile \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"request_key":"channel-reconcile-001","channel_id":"123456789","access_hash":"987654321"}'
```

服务从 Telegram 核对该账号是创建者、频道标题相同、类型为广播频道；已记录的 Channel 不可替换为其他 ID。核对后补存记录、生成邀请链接。核对任务成功后调用原创建任务的 retry，恢复原任务状态。无法取得远端证据时继续保留 uncertain，避免猜测或重复创建。

## Webhook 投递

Webhook 校验 Secret 后，按 bot_id/update_id 持久化去重，排队成功即返回 HTTP 200。Alarm 发送卡片；同一个更新重复提交不会重复发送。每 Bot 的发送顺序串行，队列过载返回 503，Telegram 可稍后重投。忽略非私聊 /start 更新。

明确的 Telegram 429 按 retry_after 重试，最多 5 次；明确 4xx 标为 failed。网络异常、5xx 或发送途中对象重启标为 uncertain，不自动重发：sendMessage 没有远端幂等键，无法同时保证绝不丢失和绝不重复。

```bash
curl https://API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl -X POST https://API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID/retry \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"allow_duplicate":true}'
```

投递状态为 queued、sending、sent、failed、uncertain。仅 Bot 所有者可以查看或重试；uncertain 重试必须明确传 allow_duplicate=true，可能重复发送。failed 重试无需该标记。去重只保证记录保留期内生效；默认 7 天，应长于 Telegram 正常重投窗口。支持正文和图片卡片，投递时读取最新 Landing 配置。

## 撤销与用户管理

| 接口 | 说明 |
| --- | --- |
| POST `/auth/logout` | 撤销当前平台 token |
| POST `/auth/logout-all` | 增加用户会话版本，使全部 token 和旧登录验证失效，未开始的旧版本任务取消 |
| POST `/auth/password` | body 为 current_password/new_password；验证当前密码、保存新 scrypt 哈希并撤销全部平台 token |
| POST `/v1/accounts/:id/logout` | 调用 Telegram auth.logOut，确认成功或会话已失效后清空本地 session，状态改为 revoked；网络未知时保留凭据供重试 |
| PUT `/v1/accounts/:id/bots/:username/token` | 传新 token；getMe 验证是同一个 Bot 后加密更新，响应不回显 Token |
| PUT `/admin/users/:user_id/disabled` | 管理员 Bearer ADMIN_API_KEY，body 为 disabled 布尔值；禁用或重新启用都撤销旧会话 |

Token 更新接口保存用户已在 BotFather 轮换的新 Token，不会替用户调用 BotFather 轮换；新 Token 写入后可再次注册 Webhook。平台 logout 与 Telegram logout 是两个独立操作。管理员禁用不删除 D1 业务数据，也不会替用户删除 Telegram 账号或 Bot。

## 监控、灾备与容量验收

- GET `/health` 是进程可响应检查。GET `/ready` 验证密钥、鉴权 TTL、必要邮件配置、D1 可查询和 AuthState 可读取；失败返回无敏感详情的 503。不在线探测邮件投递或 Telegram 授权。
- 返回 X-Request-ID；结构化日志记录 HTTP 状态/耗时、任务状态、投递异常、用户禁用、凭据迁移计数。禁止记录请求体、Authorization、邮箱、手机号、原始异常文本或含 Token 的外部 URL。Wrangler 启用日志，关闭自动 invocation 日志；长期审计保存和访问权限由运维配置。
- 外部监控 `/ready`，对持续 5xx、任务 failed/uncertain、webhook_delivery_error、D1 overloaded、CPU/请求/存储配额和邮件失败建立告警。具体阈值和通知渠道需在实际 Cloudflare 账户配置，仓库不会自动创建外部监控。
- 测试与生产使用不同 Worker、D1、DO 命名空间和 Secrets；绑定名相同不代表资源可共享。独立 Worker 名称必须与对应 Wrangler name 一致。

部署或批量迁移前记录恢复书签，管理员可另行导出：

```bash
cd cfworker
npx wrangler d1 time-travel info YOUR_D1_DATABASE_NAME
npx wrangler d1 export YOUR_D1_DATABASE_NAME --remote --output ../data/d1-backup.sql
# 保护导出文件权限；恢复命令会覆盖现有数据库，先在测试资源演练
```

D1 提供 Time Travel；付费计划通常可恢复最近 30 天，免费计划 7 天，按当前账户限制核实。[官方说明](https://developers.cloudflare.com/d1/reference/time-travel/)。D1 恢复不恢复 Telegram 的远端动作，也不一起回滚 DO 任务/投递记录：停止写入后恢复，再逐项核对可能已完成的远端创建，保持不确定任务不自动创建。生产演练应记录 RPO/RTO。备份密钥与数据库分开存放；需要更长备份保留期时配置独立导出到 R2/安全存储。

**不要回滚到不支持密文或任务 API 的旧版本**。本次升级后，旧 f5bc6a7 代码不能正确读取密文；回滚应选兼容当前数据和 DO 类的版本，或在维护窗口按完整的数据与密钥恢复方案操作。保留 DO migration 历史，不删除已创建类的声明。

容量测试应覆盖注册/登录 QPS 与 60 秒拒绝、多个用户并发读取、同手机号并发操作、队列填满、对象回收与任务恢复、邮件/Telegram 超时和 D1 故障。不要对真实 Telegram 发码或创建资源做高频压测。单 D1 库吞吐有限，当前分离帖子记录和分页减少放大，但未实现多库分片；需要以线上代表性压测确定用户规模和扩容阈值。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。

发布前在测试 Worker 完成真实业务闭环、配置边缘防护与告警、演练恢复，检查 `/ready`、任务和 Webhook 状态后再开放公网注册。应用修复本身不替代账户端的配置与生产验收。
