# Bot 自动化 API · Node.js Docker

`main` 分支用于 Docker，`feature-cfworker` 用于 Cloudflare Workers。本目录包含管理员账号与用户管理、审计及 IP 防爆破、平台邮箱鉴权、Telegram 个人账号登录、Bot 创建、客户卡片、Webhook、Channel、帖子和后台任务，只需构建本目录一个镜像。运行依赖现有 MySQL 8.0+ 或 PostgreSQL 16+、Redis 6.0+ Standalone；普通用户邮件鉴权还需要 SMTP，管理员直接登录无需 SMTP。

最新版本对凭据、任务和投递载荷加密保存，获取验证码默认每 IP 1 QPS、同邮箱或 Telegram 手机号 60 秒冷却。推荐[统一项目开通与发布](PRODUCT-FLOW.md)，查询 workflow_id 获得完整分步进度。底层 Bot/Channel/帖子创建与远端核对仍返回 HTTP 202，查询 job_id 获取最终结果。完整[架构](../README.md#architecture)、[变量表](../README.md#configuration)、[接口](../README.md#api-reference)和[调用示例](../README.md#usage)见主 README。

## 保留的 special case 设计

平台邮箱注册与 Telegram 配置分开，用户可以先注册，再自行提供 App 凭据完成 Telegram 登录。暂不提供配置的用户保留为 special case，计划由管理员启用协助流程，补充用户配置或分配平台管理的独立 Bot/Channel。一个业务用户分配一个 Bot，继续使用现有 Landing Page 配置方式。

管理员已支持必填运行时 `ADMIN_EMAIL`、`ADMIN_PASSWORD`，启动直接创建、密码哈希入库，重启不覆盖已有密码。`POST /admin/login` 使用 email/password 直接登录，无需邮箱验证及 SMTP。管理接口包含在现有 Node.js 服务和 Docker 镜像中。

管理员可通过 `GET /admin/users`、`GET /admin/users/:user_id` 查询用户，`PATCH /admin/users/:user_id` 修改普通用户邮箱、密码和启停状态，`GET /admin/audit-logs` 查询审计。操作时间、管理员身份、IP、UA、目标用户、结果和脱敏变更持久化；修改与成功审计同一事务，修改会撤销目标用户旧会话。也可使用独立的 `ADMIN_API_KEY`，审计操作者类型为 api_key。

默认同 IP 一小时内累计两次管理员认证失败，Redis 原子封禁所有 `/admin/*` 接口 3600 秒；第二次及封禁期间返回 429 和剩余秒数，正确凭据也不能绕过。成功认证不清零计数，业务参数错误不计数，封禁期间请求不延长 TTL。运行时变量 `ADMIN_AUTH_MAX_FAILURES=2`、`ADMIN_IP_BAN_SECONDS=3600` 可配置此规则；Redis 校验不可用时返回 503，失败和封禁请求仍审计。

**用户自助 App 配置、项目开通和测试 Bot 数字 ID 白名单已实现**。管理员协助配置、平台资源分配和 Channel 入群审批仍为待实现方案。完整[设计理念与状态](../README.md#special-case)、[初始化及权限规则](SPECIAL-CASE.md)、[管理员接口及示例](../README.md#api-reference)见相应文档。

## 运行时配置

首次复制 .env.example，后续保留原文件：

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
```

必填 ADMIN_EMAIL、ADMIN_PASSWORD、DB_HOST、DB_DATABASE、DB_USER、DB_PASSWORD，Redis URL 或 host，以及 AUTH_HMAC_SECRET、CREDENTIAL_KEYS、CREDENTIAL_KEY_ID。密钥生成命令和 JSON 格式见[配置说明](../README.md#configuration)。DB_TYPE 选择 mysql（默认）或 postgresql，DB_PORT 留空按引擎选择 3306/5432。DB_DATABASE 指定库名；DB_AUTO_CREATE_DATABASE=false 只跳过建库。DB_SCHEMA_INIT=true 默认在数据库锁内初始化表、索引和已知缺失列，锁等待由 DB_SCHEMA_LOCK_TIMEOUT_SECONDS 控制。生产可先用迁移账号运行 node scripts/migrate.js，再用两个初始化开关均为 false 的业务账号启动；此时只校验结构，不执行 DDL。数据库变量全部使用 DB_*；切换引擎不迁移数据。完整运行权限、TLS 和示例见[配置说明](../README.md#configuration)。SMTP 可暂不配置，但无法完成真实邮箱注册/登录。

Redis 当前通过普通 createClient 连接 Standalone，原生 Cluster 和 Sentinel 自动发现/切换尚未实现。REDIS_URL 优先于独立地址、认证与 DB 配置；REDIS_MODE、REDIS_CLUSTER_NODES 目前不读取。完整支持范围、配置示例及后续适配边界见[Redis 部署模式](../README.md#redis-deployment)。

环境变量只在容器运行时传入；Docker build 不需真实数据库、Redis、SMTP 或 Telegram 凭据，镜像不包含 .env。多用户的 App 凭据、手机号和 Bot 名称通过请求传入；用户 API 需自有 App 配置；TG_API_ID/TG_API_HASH 仅独立脚本使用。PUBLIC_BASE_URL 是 API 的 HTTPS 源地址，用于注册 Webhook，可在纯登录/创建阶段留空。

## 构建与部署

在本目录执行：

```bash
docker compose config --quiet
docker compose build telegram-api
docker compose up -d --no-build telegram-api
docker compose ps
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/ready
```

Compose 仅创建 API 容器，连接已有关系数据库/Redis。默认宿主机与容器内部端口均为 3100，映射为 `127.0.0.1:3100:3100`；API_PORT 和 PORT 无需手动配置。直接运行镜像可用 `docker run -p 127.0.0.1:3100:3100 --env-file .env YOUR_IMAGE`。公网入口使用 HTTPS 反向代理。容器使用非 root、只读根文件系统、移除 capabilities 和 6 分钟退出宽限。health 检查 HTTP，可在 SMTP 空缺时为 200；ready 检查必要配置与依赖，SMTP 未配置为 503，不实际探测邮件投递。

修改 .env 后执行 `docker compose up -d telegram-api` 重建容器；restart 不加载新变量。更新代码先 build 再 up，保留关系数据库/Redis、密钥与 Redis prefix。多副本需负载均衡和独立端口配置，不能直接扩展当前固定端口的 Compose。

## 使用顺序

推荐使用[统一开通流程](PRODUCT-FLOW.md)：保存自有 App、认证账号、项目草稿、系统开通测试资源、验收并发布独立生产资源。支持分步进度、版本回滚、来源数据及全量停用。

部署管理员填写 ADMIN_EMAIL/ADMIN_PASSWORD 后启动服务，调用 `/admin/login` 获取管理员 Token。使用该 Token 调用用户查询/修改与审计接口，完整参数及 curl 见[管理员操作示例](../README.md#管理员后台操作)。管理员只能通过 `/admin/login` 登录；`/auth/login/*` 用于普通用户。

普通用户流程：

1. register/start 提交 email/password，register/verify 提交邮件 challenge_id/code，获得平台 access_token。
2. 携带 Bearer Token 调用 telegram-apps 保存 api_id/api_hash，取得 app_config_id，再调用 login/start 传 app_config_id/phone，保存 account_id。
3. accounts/:id/verify 提交 Telegram code；需要时再提交两步验证 password。数据库暂时无法保存绑定时保留 identity_pending，恢复后提交 {} 重试 verify，不重新提交已使用的验证码。
4. POST /v1/projects 保存测试/生产 Bot、卡片、Landing URL、测试名单和可选 Channel；GET preview 查询配置预览。
5. POST provision 开通测试资源，查询 workflow_id；白名单账号启动 Bot 并访问卡片链接后提交 test-confirmation。
6. POST publish 发布独立生产资源，查询 workflow_id 至 succeeded；GET 项目详情读取环境资源，再读取本人的 Bot Token。
7. 后续 PUT 保存新草稿，再测试验收和发布；支持 rollback、流程 retry/cancel、pause/resume/archive 及事件统计。

项目资源的 landing/webhook 写操作必须通过版本发布流程，直接调用底层接口返回 409。独立资源仍可使用 Bot/Channel/帖子底层接口，见 [CONVERSION.md](CONVERSION.md)。所有资源路径检查归属。验证码由用户接收后提交，本服务不读取客户端验证码。完整 curl 和响应见[使用示例](../README.md#usage)。

## 数据库与 SQL

库名通过运行时 DB_DATABASE 自定义，表名固定，不提供表前缀配置；所有用户共用 24 张表并检查资源归属。服务启动自动建表和检查索引，DB_AUTO_CREATE_DATABASE=false 只跳过建库。完整表名、主键、DDL 设计、各 SQL 文件的用途和手动执行示例见[主 README 的 SQL 说明](../README.md#database-ddl)。

## 持久化、退出与升级

用户软启停字段为 user_security.disabled，MySQL 0/1、PostgreSQL false/true，API 统一用布尔值。禁用撤销会话、取消积压、挂起流程并拦截新业务派发；恢复后重新登录并明确恢复，不自动重放。已批准的在途请求可能完成，历史 Telegram 消息和频道成员不自动清理。项目归档保留数据，不可恢复。

关系数据库保留原十张表，另增加十四张产品表，共 24 张表。Redis 保存 10 分钟邮件验证码和 2 小时平台会话；StringSession 加密存在关系数据库，不需要本地 JSON/blob 才能持久化。

支持当前/全部平台会话注销、改密撤销、Telegram logout、同 Bot Token 更新，以及管理员禁用。未知创建结果先 reconcile；Webhook uncertain 且已保存 message_id 时调用 deliveries/:update_id/reconcile 补齐本地状态，不重发；无回执而选择重新发送时仍需 allow_duplicate=true。详见[操作说明](../README.md#operations)。

已有库先在维护窗口运行 scripts/migrate.js，再用含历史密钥的运行环境执行 scripts/backfill-phones.js，补齐 tg_info.phone_key。补齐前 /ready 与 login/start 返回 503；新库无需此步骤。脚本不依赖 Redis/SMTP，可重复运行，不改变手机号密文或正式绑定。MySQL 旧库升级先备份，自动列扩容后分页 rewrap tg_info/bot_info；普通 API 拒绝明文。轮换时保留队列记录和备份仍使用的旧密钥。SQL 与详细步骤见 [PRODUCTION.md](PRODUCTION.md)、[sql/init.sql](sql/init.sql)、[sql/postgresql/init.sql](sql/postgresql/init.sql) 和 [sql/002-security.sql](sql/002-security.sql)。旧 JSON 归属迁移见 [AUTH.md](AUTH.md)。

## 测试

```bash
npm ci
npm run check
npm test
# 独立测试数据库与 Redis prefix；调整地址为当前测试进程可连接的依赖
SECURITY_INTEGRATION=1 node --env-file=.env --test --test-concurrency=1 \
  test/database.test.js test/admin.test.js test/security.test.js test/products.test.js test/production.test.js test/reliability.test.js test/upgrade.test.js
# 已运行同配置 API，SMTP 由本地接收器捕获
INTEGRATION_TEST=1 TEST_API_URL=http://127.0.0.1:3100 \
  node --env-file=.env --test test/integration.test.js
```

普通测试不依赖外部服务。真实关系数据库/Redis 测试验证持久化、限流、加密、撤销、任务及投递状态，Telegram 副作用模拟；真实邮件、登录、Bot/Channel 创建、帖子与公网 Webhook 需另做端到端验收。

原 [card-bot](../card-bot/README.md) **已弃用 / 不可用**，仅保留历史源码；当前卡片和 Webhook 由本 API 提供。
