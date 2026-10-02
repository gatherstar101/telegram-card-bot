# Bot 自动化创建与客户转化 API

Node.js Docker 服务通过已登录个人 Telegram 账号创建 Bot 和私有 Channel，并将不同客户的 Landing Page、卡片及帖子配置保存到 MySQL。一个管理员使用 API_KEY 可以管理多个 Telegram 会话；此版本没有客户权限隔离。

## 部署和配置

以下命令在本目录执行，已有 `.env` 时保留原文件：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写下表配置
docker compose up -d --build
```

| 环境变量 | 用途 |
| --- | --- |
| API_KEY | 必填，至少 32 字符；业务管理接口使用 Bearer 鉴权 |
| API_PORT | 默认 3100，宿主机端口，仅监听 127.0.0.1 |
| MYSQL_HOST / MYSQL_PORT | 已有 MySQL 地址和端口，默认端口 3306 |
| MYSQL_DATABASE | 自动创建的数据库名，1–64 位字母、数字或下划线 |
| MYSQL_USER / MYSQL_PASSWORD | 必填；用户需有目标库 CREATE、SELECT、INSERT 权限 |
| PUBLIC_BASE_URL | 注册 Webhook 时必填；指向本服务的公网 HTTPS 源地址，不含路径 |
| TG_API_ID / TG_API_HASH / TG_PHONE | 可选登录默认值，也可在请求中提供 |
| TG_BOT_NAME / TG_BOT_USERNAME | 可选 Bot 默认值，也可在请求中提供 |

从 my.telegram.org 的 API development tools 获取 App 凭据。App 凭据不等于 Bot Token，首次还需要验证个人账号。手机号使用 `+` 加国家区号和数字，不含空格。MySQL 在宿主机发布端口时可用 `MYSQL_HOST=host.docker.internal`；容器的 localhost 指向 API 容器自己。

启动先建库及四张表，成功后监听 API。Dockerfile 使用 Node.js 22、非 root 用户和健康检查。完整的变量限制和 Docker run 部署方式见 [根 README 配置说明](../README.md#docker-部署)。

## 按步骤使用

| 顺序 | 方法和路径 | 参数及结果 |
| --- | --- | --- |
| 1 | POST `/v1/login/start` | api_id、api_hash、phone → account_id、code_required |
| 2 | POST `/v1/accounts/:id/verify` | code；必要时 password → authorized |
| 3 | POST `/v1/accounts/:id/bots` | name、username → token、Bot URL |
| 4 | PUT `/v1/accounts/:id/bots/:username/landing` | customer_id、landing_url、卡片字段 → 配置 |
| 5 | POST `/v1/accounts/:id/bots/:username/webhook` | 空 JSON → 已注册 Webhook URL |
| 6 | POST `/v1/accounts/:id/channels` | request_key、bot_username、title、about → 私有频道和邀请链接 |
| 7 | POST `/v1/accounts/:id/channels/:key/posts` | request_key、text → 发布结果及 Bot/落地页链接 |

每次登录生成独立 account_id，API 返回后调用方保存；验证和后续创建使用同一个 ID。已有有效会话时从第 3 步继续。只有客户 Bot 卡片需求时第 5 步即完成；第 6、7 步用于频道投放。

除 `/health` 和 `/webhooks/:bot_id` 外，接口都使用 `Authorization: Bearer <API_KEY>`。POST/PUT 使用 JSON，字段和可直接执行的 curl 示例见 [根 README 完整步骤](../README.md#1-bot-自动化创建和客户转化流程)。客户参数、Channel 幂等键和恢复行为也可参阅 [CONVERSION.md](CONVERSION.md)。

用户点击频道中的 Bot 链接并按 Start 后，服务读取对应 Bot 的客户配置发送卡片；卡片按钮打开 Landing Page。帖子也包含落地页直接链接。不会自动私信频道成员，不生成落地页或统计成交。

## 数据和维护

会话文件保存在容器 `/data/<account_id>.json`，使用 `telegram-card-bot-github_telegram-data` 卷。MySQL 表分别为 telegram_bots、bot_landings、telegram_channels、channel_posts。重建容器需保留原卷、数据库及 account_id。

```bash
docker compose ps
docker compose logs --tail 50 telegram-api
curl http://127.0.0.1:3100/health
docker compose restart telegram-api
```

GET `/v1/accounts/:id` 返回已保存状态，不实时证明 Telegram 授权有效；创建新资源和发布时会检查实际授权。GET Bot、Landing 和 Channel 路径读取保存结果。Channel 和帖子重试使用原 request_key，先查询状态再决定是否继续。

在 Telegram 设置的设备/活跃会话中终止该会话可以退出；本服务没有退出接口，已创建资源和 Token 不会因此删除。`docker compose down` 保留数据，`down -v` 删除会话卷。凭据、会话及 Token 应保密，不提交 `.env`。

## 验证范围

Docker、真实 MySQL 读写、真实 Telegram 登录和持久化会话授权已验证。客户卡片及 Channel 流程有模拟测试；真实 Bot/Channel 创建、帖子发布、公网 Webhook 收发尚未实测。

本地检查命令：

```bash
npm ci
npm run check
npm test
```

另有独立命令行创建脚本，配置 `scripts/create-bot.env` 后运行 `npm run create:bot`，仅保存本地会话和 Token；其配置明细见 [根 README](../README.md#可选通过-nodejs-脚本自动创建-bot)。
