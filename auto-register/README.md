# Bot 自动化 API · Node.js Docker

`main` 分支用于 Docker，`feature-cfworker` 用于 Cloudflare Workers。本目录包含平台邮箱鉴权、Telegram 个人账号登录、Bot 创建、客户卡片、Webhook、Channel、帖子和后台任务，只需构建本目录一个镜像。运行依赖现有 MySQL 8.0+、Redis 6.0+ 和用于真实鉴权的 SMTP。

最新版本对凭据、任务和投递载荷加密保存，获取验证码默认每 IP 1 QPS、同邮箱或 Telegram 手机号 60 秒冷却。Bot/Channel/帖子创建与远端核对返回 HTTP 202，查询 job_id 获取最终结果。完整[架构](../README.md#architecture)、[变量表](../README.md#configuration)、[接口](../README.md#api-reference)和[调用示例](../README.md#usage)见主 README。

## 运行时配置

首次复制 .env.example，后续保留原文件：

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
```

必填 MYSQL_HOST、MYSQL_DATABASE、MYSQL_USER、MYSQL_PASSWORD，Redis URL 或 host，以及 AUTH_HMAC_SECRET、CREDENTIAL_KEYS、CREDENTIAL_KEY_ID。密钥生成命令和 JSON 格式见[配置说明](../README.md#configuration)。数据库名由 MYSQL_DATABASE 决定，启动自动建库建表与扩容旧凭据列。SMTP 可暂不配置，但无法完成真实邮箱注册/登录。

环境变量只在容器运行时传入；Docker build 不需真实数据库、Redis、SMTP 或 Telegram 凭据，镜像不包含 .env。多用户的 App 凭据、手机号和 Bot 名称通过请求传入；TG_* 只提供可选默认值。PUBLIC_BASE_URL 是 API 的 HTTPS 源地址，用于注册 Webhook，可在纯登录/创建阶段留空。

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

Compose 仅创建 API 容器，连接已有 MySQL/Redis。默认宿主机端口 3100、仅监听 127.0.0.1，公网入口使用 HTTPS 反向代理。容器使用非 root、只读根文件系统、移除 capabilities 和 6 分钟退出宽限。health 检查 HTTP，可在 SMTP 空缺时为 200；ready 检查必要配置与依赖，SMTP 未配置为 503，不实际探测邮件投递。

修改 .env 后执行 `docker compose up -d telegram-api` 重建容器；restart 不加载新变量。更新代码先 build 再 up，保留 MySQL/Redis、密钥与 Redis prefix。多副本需负载均衡和独立端口配置，不能直接扩展当前固定端口的 Compose。

## 使用顺序

1. register/start 提交 email/password，register/verify 提交邮件 challenge_id/code，获得平台 access_token。
2. 携带 Bearer Token 调用 login/start，传 Telegram api_id/api_hash/phone，保存 account_id。
3. accounts/:id/verify 提交 Telegram code；需要时再提交两步验证 password。
4. accounts/:id/bots 提交 name/username，返回 202；查询 jobs/:job_id 的 result.token。
5. PUT Bot landing 配置客户 URL 和卡片，POST webhook 注册回调。
6. 按需创建 channels、发布 channels/:key/posts，两者均查询任务取得结果。

Bot request_key 可省略，默认用 username；其他任务提供稳定的 request_key。同 key 不同参数返回 409。所有账号路径检查归属。验证码由用户接收后提交，本服务不读取客户端验证码。完整 curl 和响应见[使用示例](../README.md#usage)。

## 持久化、退出与升级

MySQL 四张业务表之外新增 user_security、channel_posts、api_jobs、webhook_deliveries。Redis 保存 10 分钟邮件验证码和 2 小时平台会话；StringSession 加密存在 MySQL，不需要本地 JSON/blob 才能持久化。

支持当前/全部平台会话注销、改密撤销、Telegram logout、同 Bot Token 更新，以及管理员禁用。未知创建结果先 reconcile；Webhook 未知发送结果重试需要 allow_duplicate=true。详见[操作说明](../README.md#operations)。

旧库升级先备份，自动列扩容后分页 rewrap tg_info/bot_info；普通 API 拒绝明文。轮换时保留队列记录和备份仍使用的旧密钥。SQL 与详细步骤见 [PRODUCTION.md](PRODUCTION.md)、[sql/init.sql](sql/init.sql) 和 [sql/002-security.sql](sql/002-security.sql)。旧 JSON 归属迁移见 [AUTH.md](AUTH.md)。

## 测试

```bash
npm ci
npm run check
npm test
# 独立测试数据库与 Redis prefix；调整地址为当前测试进程可连接的依赖
SECURITY_INTEGRATION=1 node --env-file=.env --test test/security.test.js
# 已运行同配置 API，SMTP 由本地接收器捕获
INTEGRATION_TEST=1 TEST_API_URL=http://127.0.0.1:3100 \
  node --env-file=.env --test test/integration.test.js
```

普通测试不依赖外部服务。真实 MySQL/Redis 测试验证持久化、限流、加密、撤销、任务及投递状态，Telegram 副作用模拟；真实邮件、登录、Bot/Channel 创建、帖子与公网 Webhook 需另做端到端验收。

原独立卡片 Worker 见 [card-bot](../card-bot/README.md)，使用本 API 的 Webhook 无需部署它。
