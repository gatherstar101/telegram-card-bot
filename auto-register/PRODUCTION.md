# Docker 生产升级与运行手册

本文适用于 main 的 Node.js Docker 服务；Cloudflare 适配维护在 feature-cfworker。Docker 支持 MySQL 8.0+ 或 PostgreSQL 16+，并使用 Redis、SMTP；本次安全加固没有给主分支引入 D1、KV 或 Durable Objects。

## 升级步骤

在维护窗口停止旧版本写入，备份关系数据库、Redis 和密钥。记录当前镜像与配置，先在测试库恢复和演练升级。

1. 数据库配置统一重命名为 DB_*，不再读取旧前缀；保留对应值、Redis、AUTH_HMAC_SECRET、REDIS_KEY_PREFIX，配置必填 ADMIN_EMAIL、ADMIN_PASSWORD、CREDENTIAL_KEYS、CREDENTIAL_KEY_ID，以及可选独立管理凭据 ADMIN_API_KEY。
2. 使用迁移账号运行 node scripts/migrate.js，或以默认 DB_SCHEMA_INIT=true 启动新版。在数据库初始化锁内创建 24 张表、索引及 api_jobs 的 project_id/workflow_id、tg_info.phone_key、webhook_deliveries.remote_message_id 列；MySQL 还扩容旧凭据列。此步骤需要对应 DDL 权限，不加密旧数据。配置 DB_AUTO_CREATE_DATABASE=false、DB_SCHEMA_INIT=false 后，运行账号只进行结构兼容检查和业务读写；缺表或必要列时拒绝启动。
3. 对已有 tg_info 数据运行 node scripts/backfill-phones.js（从运行时 env 提供 DB_*、CREDENTIAL_KEYS/CREDENTIAL_KEY_ID）。未补齐时 ready 与 login/start 返回 503。脚本按批次仅处理 phone_key=NULL，支持中断后重复运行，不修改手机号密文，也不建立未认证的正式归属。未知密钥/坏密文/无效手机号会停止；修复后重跑。仅这个显式离线命令可读旧明文手机号，普通 API 仍拒绝明文。新库无需补齐。
4. 管理员 POST /admin/credentials/rewrap，table=tg_info、cursor=""、limit=50，按 next_cursor 翻页至 done=true；然后处理 bot_info。每批最多 100 行，不返回凭据。
5. 调用方把创建和核对请求改为 202 后查询 /v1/accounts/:id/jobs/:job_id。成功后读取 result，失败查看 error。
6. 检查 ready 与真实业务闭环后恢复流量。SMTP 未配时 ready=503，但 health=200，可进行基础验证。

```bash
curl -X POST https://YOUR_API_HOST/admin/credentials/rewrap \
  -H 'Authorization: Bearer YOUR_ADMIN_API_KEY' -H 'Content-Type: application/json' \
  -d '{"table":"tg_info","cursor":"","limit":50}'
```

新库自动写密文，无需明文迁移。普通接口默认拒绝明文，不提供全局允许明文开关。启动迁移仅扩容已知旧列和幂等建表，不能代替未来业务 SQL 迁移。手动 SQL 见 MySQL init.sql、002-security.sql、003-product.sql 与 PostgreSQL sql/postgresql/ 下对应 SQL，执行前选择正确库，避免直接对生产反复 ALTER。

## 运行时配置

全部变量通过容器 env 注入，完整默认值与范围见[主 README](../README.md#configuration)和 [.env.example](.env.example)。构建不连接生产依赖，不包含真实 .env。

当前 Redis 客户端仅实现 Standalone 普通连接，支持 REDIS_URL 或独立连接字段。原生 Redis Cluster 和 Sentinel 自动发现/主节点切换未实现、未验收；不能通过把 REDIS_HOST 指向集群节点来替代客户端适配。多个 API 副本共享 Redis 不代表已支持 Redis Cluster。REDIS_MODE、REDIS_CLUSTER_NODES 是待实现方案，当前不读取，配置说明见[主 README](../README.md#redis-deployment)。

同邮箱注册/登录/密码恢复发码共享 60 秒冷却，同 Telegram 手机号跨用户/IP 共享 60 秒冷却，失败也保留。四个 start 接口共享默认每 IP 1 QPS；429 提供 Retry-After 和 retry_after。验证码默认 600 秒、平台会话 7200 秒，访问不续期。修改 OTP_IP_QPS 不改变冷却时间。

多个 API 副本共享关系数据库、Redis、密钥和 REDIS_KEY_PREFIX。当前 Compose 使用固定宿主机端口，扩容需要部署平台或独立端口与负载均衡。同版本初始化在同一数据库连接持有 MySQL GET_LOCK 或 PostgreSQL advisory lock，默认等待 60 秒，DB_SCHEMA_LOCK_TIMEOUT_SECONDS 可设 1–300 秒；超时拒绝启动。锁负责协调遵守该协议的实例，跨版本升级仍须维护窗口停止旧版本写入。迁移账号需要 DDL，自动建库还需建库权限；业务账号设置 DB_AUTO_CREATE_DATABASE=false、DB_SCHEMA_INIT=false，仅需表 SELECT/INSERT/UPDATE/DELETE，PostgreSQL 另需 schema USAGE 与 sequence USAGE/SELECT。DB_SSL_MODE=verify-full 验证证书与主机名。切换 DB_TYPE 不迁移引擎之间的数据，须另行迁移并保留原密钥。

同一个镜像可完成迁移和运行，构建无需这些账号信息。迁移文件配置 DDL 账号及 DB_AUTO_CREATE_DATABASE；migrate 命令强制执行结构初始化，不启动 HTTP、Redis 或管理员初始化，也不需要凭据密钥：

```bash
docker run --rm --env-file .env.migrate YOUR_IMAGE node scripts/migrate.js
# 已有账号升级：业务 .env 提供数据库读写权限和历史凭据密钥，无需 Redis/SMTP
docker run --rm --env-file .env YOUR_IMAGE node scripts/backfill-phones.js
# 业务 .env 使用最小权限账号，两个初始化开关设为 false
docker run -d -p 127.0.0.1:3100:3100 --env-file .env YOUR_IMAGE
```

结构初始化仍是代码明确列出的幂等操作，不是任意 schema 自动同步或通用版本迁移框架。已有库手动升级参考各引擎的 004-production.sql 和 005-reliability.sql；MySQL 手动文件仅执行一次，推荐锁内迁移命令。新库 init.sql 已包含新增列和索引，不再执行 004/005。

TRUST_PROXY_HOPS 默认 0，只按 TCP 对端限流。可信反向代理后按实际层数配置，确保代理正确追加/覆盖 X-Forwarded-For，并禁止绕过代理；客户端伪造头不能成为可信来源。公网入口配置 TLS、请求体/超时限制、WAF 或反向代理限流，管理员路径限制访问。应用层限流已经消耗服务/Redis 资源，不能代替入口防护。

## 密钥轮换与备份

AES-256-GCM 密文绑定记录和字段。CREDENTIAL_KEYS 是 JSON 密钥环，值为 32 字节随机密钥的 base64，CREDENTIAL_KEY_ID 选择写入版本。密码使用 scrypt。手机号、api_hash、StringSession、phone_code_hash、pending 信息、Bot Token 和 Webhook Secret 均加密；任务与投递载荷也加密。

轮换先加入新版本并保留旧版本，切换写入版本，分页 rewrap tg_info、bot_info、telegram_apps、telegram_identities、project_versions、telegram_visitors、business_events、api_jobs、webhook_deliveries。复合主键使用返回的 next_cursor。所有在线数据和需要恢复的备份处理前保留旧密钥。ADMIN_API_KEY 与用户 Token 分开管理。

关系数据库定期备份并演练恢复，密钥另行安全备份；恢复关系数据库不会撤回 Telegram 远端动作。Redis 配置符合可接受的数据丢失窗口的持久化与故障切换，丢失验证码/平台会话后用户重新邮箱登录。Redis 锁在异步复制故障切换中可能丢失，不能保证严格分布式 exactly-once；保留关系数据库检查点和未知结果核对。

禁止回滚到不能读取密文/任务协议的旧代码。回滚应使用兼容当前数据的版本，或完整恢复数据与密钥后逐项核对远端结果。

## 持久化任务 API

创建 Bot、Channel、帖子及 reconcile 返回 HTTP 202 和 job_id。POST retry 也返回 202。客户端轮询任务状态，按 API 用户分钟上限控制频率，不将受理视为远端成功。

任务为 queued/running/succeeded/failed/uncertain/cancelled。同账号、路径、request_key、参数复用已有任务，不同参数返回 409；Bot 默认 key 为 username，其他任务明确提交 key。关系数据库使用事务和 FOR UPDATE SKIP LOCKED 领取，租约防止正常多副本重复领取。[MySQL 锁定读取说明](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html)、[PostgreSQL 锁定读取说明](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)。

执行前检查用户禁用、会话版本和归属。Telegram 任务操作上限 240 秒，领取租约额外保留 60 秒并定期续期。执行手机号锁最长 600 秒，超过有效执行时间。进程异常退出后租约到期重新处理：已落库结果恢复成功，没有副作用检查点可继续，有检查点且结果未知标 uncertain。

```bash
curl https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/jobs/JOB_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl -X POST https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/jobs/JOB_ID/retry \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' -d '{}'
```

未知 Bot/Channel 先 reconcile 再 retry 原任务。Bot 通过 BotFather 请求已有 Token 并 getMe 核对；Channel 要求已有本地记录、远端 channel_id/access_hash，核对创建者、标题及频道类型。不会根据未知结果盲目再次创建。帖子复用 random_id，不能宣称无限期去重。清理默认保留 7 天的完成/失败/取消任务，uncertain 保留至核对；尚未 succeeded/cancelled 的项目流程引用的任务继续保留，避免失败、挂起或等待验收流程失去恢复数据。

项目任务入队与步骤关联在同一 SQL 事务内提交；任务另存 project_id/workflow_id，执行时检查归属、当前活动流程与授权版本，显式关联缺失则拒绝执行。流程重试接口只原子保存步骤恢复意图，子任务重试在后台逐步执行。流程租约每 30 秒续期，过期或被其他持有者替代后不能覆盖步骤结果或提交发布。开通事务内的配额及资源查询复用事务连接，DB_POOL_SIZE=1 也支持开通。

后台每个副本分别运行创建任务、Webhook 投递和项目编排三个循环，每轮各领取一项；创建任务与投递默认每 1000 ms 轮询，项目阶段推进后至少间隔 1000 ms 再领取。操作完成后再启动下一轮。没有额外 broker 或常驻 Telegram 接收客户端。Redis 锁使用随机持有者值和比较释放，避免释放他人的锁。[Redis SET 说明](https://redis.io/docs/latest/commands/set/)。

## Webhook 投递

入口验证专属 Secret 与 update_id，私聊 /start 持久化投递后返回 200；其他合规更新记录事件和可用访客资料，不触发发卡。相同 bot_id/update_id 默认 7 天内去重；队列满或正在处理接收返回 503，Telegram 可以重投。达到 Bot/私聊发送分钟上限时确认接收但不再发送。

投递为 queued/sending/sent/failed/uncertain/cancelled。明确 Telegram 429 遵守 retry_after，最多 5 次；明确 4xx failed。网络错误、5xx 或发送中断 uncertain，不自动重发，因为 sendMessage 没有远端幂等键。

```bash
curl https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl -X POST https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID/retry \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"allow_duplicate":true}'
```

成功投递的状态、message_id 和 card_sent 事件在同一事务内提交，先锁行校验租约与状态，并检查更新行数。失败时事务回滚；若远端已确认成功，优先保留回执并标为 uncertain。整个数据库不可用或进程中断仍可能丢失回执，不能提供跨系统原子保证。

投递查询返回 message_id 字符串或 null。uncertain 且有已保存成功回执时，POST /v1/accounts/:id/bots/:username/deliveries/:update_id/reconcile，body={}，只补齐事件和 sent 状态，不发送 Telegram 消息，返回 200；重复操作幂等。补齐保留原投递时间，防止旧投递被误计为新测试流程的证据。无成功回执返回 409 DELIVERY_RECEIPT_REQUIRED。

未知结果重试需明确 allow_duplicate=true，可能重复发送；failed 重试不需要该标记。队列恢复不会盲目重发已领取后中断的消息。项目投递使用接收时的配置版本；旧版独立 Bot 投递仍读取最新 landing 配置。

## 监控、容量与退出

health 只检查可响应；ready 检查必要邮件配置、关系数据库/Redis 和历史手机号索引完整性，不在线探测 SMTP 投递或 Telegram 授权。返回请求 ID，结构化日志只记录固定事件、资源 UUID、状态和耗时，不记录请求体、Authorization、手机号、邮箱或含 Token 的外部 URL。

监控 5xx、ready、Redis/关系数据库、队列等待时间、failed/uncertain、磁盘、连接池、CPU/内存与外部服务超时。设置真实告警通知、备份恢复演练和 RPO/RTO。状态故障日志脱敏，排障需要时在受控测试环境重现，不将原始异常或 URL 长期输出生产日志。

SIGTERM 停止新请求和轮询，等待活动任务完成再关闭依赖；Compose stop_grace_period 为 6 分钟。强制终止会等待租约过期恢复。不要用容器 restart 来更新 .env，使用 compose up 重建容器。

容量测试覆盖多个 API 副本、同手机号并发、数据库死锁/不可用、Redis 故障与重启、慢 SMTP、队列填满和未知远端结果。使用模拟 Telegram，不能对真实发码/创建资源做高频压测。当前单实例关系数据库、Redis、SMTP 的高可用部署与外部服务可用性仍需运维提供；本仓库不构建依赖集群，也不承诺线上 SLA。

## 管理员与审计

默认同 IP 在 3600 秒内累计两次管理员认证失败，Redis 原子封禁全部 /admin/* 接口 3600 秒。第二次失败及封禁期间返回 429 与 Retry-After/retry_after；正确凭据不能绕过，访问不会延长封禁，成功认证不清零计数。业务参数及通过管理员认证后的资源权限错误不计数。ADMIN_AUTH_MAX_FAILURES 和 ADMIN_IP_BAN_SECONDS 为运行时配置，默认 2/3600；多副本保持一致并共享 Redis prefix。Redis 校验不可用时拒绝管理请求并返回 503，失败与封禁仍写入审计。

ADMIN_EMAIL/ADMIN_PASSWORD 均为必填运行时配置；启动直接创建管理员，创建和 /admin/login 均不需要邮件验证码及 SMTP。已有管理员重启不覆盖密码，普通邮箱冲突不会自动提升角色。普通用户鉴权仍依赖邮件验证码，SMTP 缺失时 /ready 返回 503。

用户管理接口支持修改普通用户邮箱、密码、启停状态，以及单独设置资源配额，并撤销旧会话；管理员自身改密使用 /auth/password。资料修改、凭据重加密和成功审计同一事务，审计写入失败时回滚。所有管理请求的成功、拒绝和失败均保存 UTC 时间、request_id、操作者、目标用户、IP、连接来源 IP、UA 与脱敏变更；不保存密码、哈希或 Token。查询/拒绝审计无法写入时返回 503。

TRUST_PROXY_HOPS 仅在可信代理入口设置，限制直连并由代理重写转发头。audit_logs 查询按 ID 分页，只提供读取接口；容量与保留周期由数据库运维管理。初始化日志操作者为 bootstrap，无 HTTP IP/UA；独立密钥调用标记为 api_key。接口及完整示例见[主 README](../README.md#api-reference)。

## 产品流程与全量停用

项目编排、测试/生产发布、配置版本、原始数据保留和操作步骤见 [PRODUCT-FLOW.md](PRODUCT-FLOW.md)。启动自动增加产品表与索引，不自动接管旧 Bot。禁用在 SQL 事务中更新业务授权版本、取消积压、挂起流程并审计；所有远端派发再次检查。已经批准的在途请求可能完成，管理员详情展示在途状态。恢复不会自动重放或继续流程；旧追踪链接不自动恢复。远端帖子、成员和第三方地址不自动删除。

新流程在发频道帖子前验证 Webhook；旧流程保持已有步骤顺序。生产追踪链接按具体版本查询成功生产流程记录，待发布或失败版本返回 VERSION_NOT_PUBLISHED。帖子可先于最终数据库提交发出，其新版本链接在提交成功后开放；不提供远端发帖与数据库的跨系统原子提交。回滚保留曾成功发布版本的链接资格，但用户/项目停用、授权版本变更及过期规则仍生效。

生产回归 test/production.test.js 覆盖双实例初始化、缺列拒绝启动、无 DDL 权限运行账号、单连接池开通、关联写入回滚、未提交任务不可领取、暂停拦截、关联缺失、恢复数据保留、租约失效和后台重试。test/products.test.js 通过真实 HTTP 验证发布前链接拒绝、发布后开放及回滚后历史链接；Telegram 使用模拟执行器，真实远端仍需验收。

可靠性回归 test/reliability.test.js 覆盖身份/手机号事务回滚、跨副本归属争用、identity_pending 重试、离线索引补齐与跨批中断恢复、发送结果与事件同事务可见、回执核对回滚、租约丢失和零更新行数。test/products.test.js 通过 HTTP 验证投递核对的资源隔离、幂等、不重发和测试验收恢复。
