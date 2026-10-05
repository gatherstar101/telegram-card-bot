# Docker 生产升级与运行手册

本文适用于 main 的 Node.js Docker 服务；Cloudflare 适配维护在 feature-cfworker。Docker 支持 MySQL 8.0+ 或 PostgreSQL 16+，并使用 Redis、SMTP；本次安全加固没有给主分支引入 D1、KV 或 Durable Objects。

## 升级步骤

在维护窗口停止旧版本写入，备份关系数据库、Redis 和密钥。记录当前镜像与配置，先在测试库恢复和演练升级。

1. 数据库配置统一重命名为 DB_*，不再读取旧前缀；保留对应值、Redis、AUTH_HMAC_SECRET、REDIS_KEY_PREFIX，配置必填 ADMIN_EMAIL、ADMIN_PASSWORD、CREDENTIAL_KEYS、CREDENTIAL_KEY_ID，以及可选独立管理凭据 ADMIN_API_KEY。
2. 启动新版。服务创建环境变量指定的数据库、十张表，MySQL 还会按 information_schema 扩容旧凭据字段为 TEXT/MEDIUMTEXT。需要 ALTER 权限；此步骤不加密旧数据。
3. 管理员 POST /admin/credentials/rewrap，table=tg_info、cursor=""、limit=50，按 next_cursor 翻页至 done=true；然后处理 bot_info。每批最多 100 行，不返回凭据。
4. 调用方把创建和核对请求改为 202 后查询 /v1/accounts/:id/jobs/:job_id。成功后读取 result，失败查看 error。
5. 检查 ready 与真实业务闭环后恢复流量。SMTP 未配时 ready=503，但 health=200，可进行基础验证。

```bash
curl -X POST https://YOUR_API_HOST/admin/credentials/rewrap \
  -H 'Authorization: Bearer YOUR_ADMIN_API_KEY' -H 'Content-Type: application/json' \
  -d '{"table":"tg_info","cursor":"","limit":50}'
```

新库自动写密文，无需明文迁移。普通接口默认拒绝明文，不提供全局允许明文开关。启动迁移仅扩容已知旧列和幂等建表，不能代替未来业务 SQL 迁移。手动 SQL 见 MySQL init.sql、002-security.sql 与 PostgreSQL sql/postgresql/init.sql，执行前选择正确库，避免直接对生产反复 ALTER。

## 运行时配置

全部变量通过容器 env 注入，完整默认值与范围见[主 README](../README.md#configuration)和 [.env.example](.env.example)。构建不连接生产依赖，不包含真实 .env。

同邮箱注册/登录发码共享 60 秒冷却，同 Telegram 手机号跨用户/IP 共享 60 秒冷却，失败也保留。三个 start 接口共享默认每 IP 1 QPS；429 提供 Retry-After 和 retry_after。验证码默认 600 秒、平台会话 7200 秒，访问不续期。修改 OTP_IP_QPS 不改变冷却时间。

多个 API 副本共享关系数据库、Redis、密钥和 REDIS_KEY_PREFIX。当前 Compose 使用固定宿主机端口，扩容需要部署平台或独立端口与负载均衡。初始化/迁移阶段须串行发布，避免多副本同时 ALTER。运行账号需要目标库的表/索引 DDL 与业务读写权限；MySQL 旧列升级需要 ALTER，PostgreSQL 自动建库需要 CREATEDB 和维护库连接权限。已有库可用 DB_AUTO_CREATE_DATABASE=false 跳过建库；DB_SSL_MODE=verify-full 验证证书与主机名。数据库密码通过 DB_PASSWORD 运行时注入。切换 DB_TYPE 不会迁移两个引擎之间的数据，须另行迁移并保留原密钥。

TRUST_PROXY_HOPS 默认 0，只按 TCP 对端限流。可信反向代理后按实际层数配置，确保代理正确追加/覆盖 X-Forwarded-For，并禁止绕过代理；客户端伪造头不能成为可信来源。公网入口配置 TLS、请求体/超时限制、WAF 或反向代理限流，管理员路径限制访问。应用层限流已经消耗服务/Redis 资源，不能代替入口防护。

## 密钥轮换与备份

AES-256-GCM 密文绑定记录和字段。CREDENTIAL_KEYS 是 JSON 密钥环，值为 32 字节随机密钥的 base64，CREDENTIAL_KEY_ID 选择写入版本。密码使用 scrypt。手机号、api_hash、StringSession、phone_code_hash、pending 信息、Bot Token 和 Webhook Secret 均加密；任务与投递载荷也加密。

轮换先加入新版本并保留旧版本，切换写入版本，分页 rewrap tg_info/bot_info。**不能仅迁移两张表就删除旧密钥**：api_jobs 的 body/result、webhook_deliveries.payload 与备份还可能使用旧版本；当前 rewrap 不迁移队列表。保留仍被记录与恢复备份使用的旧密钥。ADMIN_API_KEY 与用户 Token 分开管理。

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

未知 Bot/Channel 先 reconcile 再 retry 原任务。Bot 通过 BotFather 请求已有 Token 并 getMe 核对；Channel 要求已有本地记录、远端 channel_id/access_hash，核对创建者、标题及频道类型。不会根据未知结果盲目再次创建。帖子复用 random_id，不能宣称无限期去重。清理仅处理默认保留 7 天的完成/失败/取消任务，uncertain 保留至核对。

后台每个副本一次领取一个创建任务和一个投递，默认分别每 1000 ms 轮询；操作完成后再启动下一轮。没有额外 broker 或常驻 Telegram 接收客户端。Redis 锁使用随机持有者值和比较释放，避免释放他人的锁。[Redis SET 说明](https://redis.io/docs/latest/commands/set/)。

## Webhook 投递

入口验证专属 Secret 与 update_id，只处理私聊 /start，持久化后返回 200。相同 bot_id/update_id 默认 7 天内去重；队列满或正在处理接收返回 503，Telegram 可以重投。达到 Bot/私聊发送分钟上限时确认接收但不再发送。

投递为 queued/sending/sent/failed/uncertain。明确 Telegram 429 遵守 retry_after，最多 5 次；明确 4xx failed。网络错误、5xx 或发送中断 uncertain，不自动重发，因为 sendMessage 没有远端幂等键。

```bash
curl https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
curl -X POST https://YOUR_API_HOST/v1/accounts/ACCOUNT_ID/bots/BOT_USERNAME/deliveries/UPDATE_ID/retry \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"allow_duplicate":true}'
```

未知结果重试需明确 allow_duplicate=true，可能重复发送；failed 重试不需要该标记。队列恢复不会盲目重发已领取后中断的消息。更新 landing 后投递读取最新配置。

## 监控、容量与退出

health 只检查可响应；ready 检查必要邮件配置和关系数据库/Redis，不在线探测 SMTP 投递或 Telegram 授权。返回请求 ID，结构化日志只记录固定事件、资源 UUID、状态和耗时，不记录请求体、Authorization、手机号、邮箱或含 Token 的外部 URL。

监控 5xx、ready、Redis/关系数据库、队列等待时间、failed/uncertain、磁盘、连接池、CPU/内存与外部服务超时。设置真实告警通知、备份恢复演练和 RPO/RTO。状态故障日志脱敏，排障需要时在受控测试环境重现，不将原始异常或 URL 长期输出生产日志。

SIGTERM 停止新请求和轮询，等待活动任务完成再关闭依赖；Compose stop_grace_period 为 6 分钟。强制终止会等待租约过期恢复。不要用容器 restart 来更新 .env，使用 compose up 重建容器。

容量测试覆盖多个 API 副本、同手机号并发、数据库死锁/不可用、Redis 故障与重启、慢 SMTP、队列填满和未知远端结果。使用模拟 Telegram，不能对真实发码/创建资源做高频压测。当前单实例关系数据库、Redis、SMTP 的高可用部署与外部服务可用性仍需运维提供；本仓库不构建依赖集群，也不承诺线上 SLA。

## 管理员与审计

默认同 IP 在 3600 秒内累计两次管理员认证失败，Redis 原子封禁全部 /admin/* 接口 3600 秒。第二次失败及封禁期间返回 429 与 Retry-After/retry_after；正确凭据不能绕过，访问不会延长封禁，成功认证不清零计数。业务参数及通过管理员认证后的资源权限错误不计数。ADMIN_AUTH_MAX_FAILURES 和 ADMIN_IP_BAN_SECONDS 为运行时配置，默认 2/3600；多副本保持一致并共享 Redis prefix。Redis 校验不可用时拒绝管理请求并返回 503，失败与封禁仍写入审计。

ADMIN_EMAIL/ADMIN_PASSWORD 均为必填运行时配置；启动直接创建管理员，创建和 /admin/login 均不需要邮件验证码及 SMTP。已有管理员重启不覆盖密码，普通邮箱冲突不会自动提升角色。普通用户鉴权仍依赖邮件验证码，SMTP 缺失时 /ready 返回 503。

用户管理接口仅修改普通用户邮箱、密码和启停状态，并撤销旧会话；管理员自身改密使用 /auth/password。资料修改、凭据重加密和成功审计同一事务，审计写入失败时回滚。所有管理请求的成功、拒绝和失败均保存 UTC 时间、request_id、操作者、目标用户、IP、连接来源 IP、UA 与脱敏变更；不保存密码、哈希或 Token。查询/拒绝审计无法写入时返回 503。

TRUST_PROXY_HOPS 仅在可信代理入口设置，限制直连并由代理重写转发头。audit_logs 查询按 ID 分页，只提供读取接口；容量与保留周期由数据库运维管理。初始化日志操作者为 bootstrap，无 HTTP IP/UA；独立密钥调用标记为 api_key。接口及完整示例见[主 README](../README.md#api-reference)。
