# Bot 自动化创建与 Telegram Card Bot

先通过 Node.js Docker API 登录 Telegram、创建 Bot 并获取 Token，再将 Token 配置到 Cloudflare Workers 卡片服务。两个服务可独立部署。

- [Bot 自动化创建](#1-bot-自动化创建)：环境配置、容器部署、登录、创建和持久化。
- [Telegram Card Bot](#2-telegram-card-bot)：卡片配置、Worker 部署和 Webhook 注册。

## 1. Bot 自动化创建

Node.js API 服务与 Worker 卡片服务独立运行。创建参数通过 JSON 请求传入，也可在 `.env` 设置默认值；请求值优先。首次验证码验证后，登录会话保存到 `/data` 数据卷，Bot 信息和 Token 存入 MySQL，容器重启后可继续使用。单实例运行，同一手机号的操作禁止并发。

当前用于一个操作者管理自己的 Telegram 账号，所有业务接口共用一个 `API_KEY`。流程为：配置环境变量 → Docker 启动并自动建库建表 → 发起登录 → 提交验证码/两步验证密码 → 保存 `account_id` → 创建 Bot → 返回并查询 Token。登录成功后继续使用同一 `account_id` 创建 Bot，无需重复调用登录接口。

### 准备

- 已注册的个人 Telegram 账号，能够接收登录验证码。
- 在 [my.telegram.org](https://my.telegram.org) → API development tools 获取 App `api_id` 和 `api_hash`；它们与 Bot Token 不同。
- Docker、Docker Compose 和可访问的现有 MySQL。
- 首次需完成验证码及可能的两步验证密码校验，网页端登录不会自动授权本服务。

### Docker 部署

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env：设置随机 API_KEY（至少 32 字符）、MYSQL_HOST、MYSQL_PORT、MYSQL_DATABASE、MYSQL_USER、MYSQL_PASSWORD，可选填 App 凭据等默认值
# 生成随机密钥：openssl rand -hex 32
docker compose up -d --build
```

默认仅监听宿主机 `127.0.0.1:3100`。所有业务请求必须携带 `Authorization: Bearer <API_KEY>`。远程访问可通过 HTTPS 反向代理。健康检查为 `GET /health`。以下命令中的值均为占位符，使用自己的实际配置。

| 环境变量 | 必填 | 默认值 | 用途和格式 |
| --- | --- | --- | --- |
| API_KEY | 是 | 无 | 至少 32 字符；所有业务接口使用 Bearer 鉴权 |
| API_PORT | 否 | `3100` | Compose 的宿主机监听端口 |
| MYSQL_HOST | 是 | 无 | 数据库 IP/域名；宿主机已映射 MySQL 可用 `host.docker.internal` |
| MYSQL_PORT | 否 | `3306` | 1–65535 的整数 |
| MYSQL_DATABASE | 是 | 无 | 自动创建的库名，1–64 位字母、数字或下划线 |
| MYSQL_USER | 是 | 无 | 对目标库具有 CREATE、SELECT、INSERT 权限的用户 |
| MYSQL_PASSWORD | 是 | 无 | 数据库密码 |
| TG_API_ID | 条件必填 | 无 | 正整数；登录请求未传 `api_id` 时使用 |
| TG_API_HASH | 条件必填 | 无 | 32 位十六进制密钥；请求未传 `api_hash` 时使用 |
| TG_PHONE | 条件必填 | 无 | `+` 加 7–15 位数字，不含空格；请求未传 `phone` 时使用 |
| TG_BOT_NAME | 条件必填 | 无 | 显示名称，最多 64 个 JavaScript 字符；请求未传 `name` 时使用 |
| TG_BOT_USERNAME | 条件必填 | 无 | 5–32 位，字母开头、bot 结尾，仅含字母/数字/下划线；请求未传 `username` 时使用 |
| PORT | 否 | `3000` | Node.js 服务端口；Dockerfile 设置为 3000，Compose 不透传自定义值 |
| DATA_DIR | 否 | 本地 `./data`；容器 `/data` | 会话目录；Compose 固定为 `/data` 并挂载命名卷 |

Dockerfile 使用 Node.js 22、非 root 用户运行，并内置 HTTP 健康检查。仅 API 代码和依赖进入镜像，真实 `.env` 和登录数据不进入镜像。使用现有 MySQL 时不需要部署新数据库容器。

可单独构建镜像并运行（同样使用环境变量和持久化卷）：

```bash
docker build -t telegram-card-bot-api:local .
docker run -d --name telegram-card-bot-api --restart unless-stopped \
  --env-file .env --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:3100:3000 -v telegram-bot-data:/data \
  telegram-card-bot-api:local
```

单独使用 `docker run` 时端口由 `-p` 参数指定；`API_PORT` 只供 Compose 插值。两种部署方式使用不同的卷名，选择一种并在后续部署中保留同一个卷。

### API 使用约定和接口明细

API 用 JSON 接收参数并返回 JSON；POST 请求设置 `Content-Type: application/json`，业务接口设置 `Authorization: Bearer <API_KEY>`。请求体最大 16 KiB。每次首次登录会生成一个新的 `account_id`；完成登录后保存这个标识，后续创建和查询都使用同一个标识。

| 方法 | 路径 | 请求字段 | 返回内容 |
| --- | --- | --- | --- |
| GET | `/health` | 无；无需鉴权 | `{"ok":true}`；表示 HTTP 服务已启动，不实时探测 MySQL/Telegram |
| POST | `/v1/login/start` | `api_id`、`api_hash`、`phone`，可由环境变量提供 | `account_id`、`status`、`delivery` |
| POST | `/v1/accounts/:account_id/verify` | `code`；需要两步验证时提交 `password` | `account_id`、`status` |
| GET | `/v1/accounts/:account_id` | 无 | 已保存的账号标识和登录状态 |
| POST | `/v1/accounts/:account_id/bots` | `name`、`username`，可由环境变量提供 | `username`、`name`、`token`、`url` |
| GET | `/v1/accounts/:account_id/bots/:username` | 无 | MySQL 中已保存的 Bot 信息和 Token |

下面示例的 `YOUR_API_KEY`、`ACCOUNT_ID`、App 凭据和用户名需要替换。也可在自己的 Bash 终端加载 `.env` 后使用 `-H "Authorization: Bearer $API_KEY"`；`source` 会执行文件内容，只加载自己维护的可信文件。

```bash
set -a
source .env
set +a
```

登录状态依次为 `code_required` → `password_required`（如启用两步验证）→ `authorized`。验证码和密码通过 verify 请求提交，API 不读取脚本专用的 `TG_PHONE_CODE`、`TG_PASSWORD` 环境变量。

### 发起登录，发送验证码

```bash
curl http://127.0.0.1:3100/v1/login/start \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"api_id":123456,"api_hash":"YOUR_APP_API_HASH","phone":"+8613800000000"}'
```

返回 `account_id`、`status: "code_required"`、`delivery`。`telegram_app` 表示通过 Telegram 客户端接收，`other` 表示其他渠道；本服务不保证短信发送。App 凭据和手机号已设置环境变量时可发送 `{}`。保存 `account_id`，后续调用均使用它，不需要重复发送验证码。

### 提交验证码，完成登录

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/verify \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345"}'
```

成功响应示例：

```json
{"account_id":"返回的账号标识","status":"authorized"}
```

成功返回 `status: "authorized"`。如返回 `password_required`，向同一接口再次提交 `{"password":"你的两步验证密码"}`；也可首次提交 `code` 和 `password` 两个字段。验证码和密码不写入持久化文件。登录流程在本服务中 10 分钟后过期，Telegram 验证码也可能提前失效；重新调用登录接口获取新的 `account_id`。当前不支持注册个人账号、额外邮箱验证或验证码自动读取。

### 创建指定 Bot，回传 Token

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/bots \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Gatherstar Card Bot","username":"gatherstar_unique_card_bot"}'
```

响应示例：

```json
{"username":"gatherstar_unique_card_bot","name":"Gatherstar Card Bot","token":"123456:EXAMPLE_TOKEN","url":"https://t.me/gatherstar_unique_card_bot"}
```

`name`、`username` 可分别由 `TG_BOT_NAME`、`TG_BOT_USERNAME` 提供默认值。BotFather 对话依赖英文提示，用户名占用、账号限制或回复变化会返回错误；超时后先检查 BotFather 对话，避免重复创建。不要同时手动操作该账号的 BotFather。服务只对已成功保存的结果去重，无法保证远程创建与本地写入之间的事务一致性。

### 查询登录状态或取回已保存 Token

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID \
  -H 'Authorization: Bearer YOUR_API_KEY'
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/bots/gatherstar_unique_card_bot \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

状态查询返回本地记录；创建时会检查 Telegram 会话是否仍有效。Token 查询仅支持本服务保存的 Bot，不会从 BotFather 导入已有 Bot，也不会轮换 Token。获得的 Token 可用于下方 Telegram Card Bot 的 Worker 配置和 Webhook 注册。

### 常见错误和处理

失败返回 `{"error":"错误说明"}`，不会返回 App 密钥或用户会话。

| HTTP 状态 | 原因 | 处理 |
| --- | --- | --- |
| 400 | 参数缺失、格式错误或 JSON 错误 | 检查请求字段和配置表 |
| 401 | API_KEY 错误、未登录或实际 Telegram 会话失效 | 检查鉴权；会话失效时重新发起登录 |
| 404 | 接口、账号记录或已保存 Bot 不存在 | 检查路径、account_id 和用户名 |
| 409 | 同一手机号正在执行其他操作 | 等待上一次请求完成 |
| 410 | 本服务登录流程超过 10 分钟 | 重新发起登录并使用新的 account_id |
| 413 | 请求体超过 16 KiB | 缩小请求体 |
| 422 | Telegram 拒绝认证、需要额外验证或 BotFather 创建失败 | 根据错误和 BotFather 对话处理；当前不支持邮箱验证或注册个人账号 |
| 429 | Telegram FLOOD_WAIT 限流 | 等待 Telegram 指定时间，避免立即重复请求 |
| 500 | 数据库、网络或其他内部错误 | 检查容器日志、MySQL 和网络连接 |
| 504 | BotFather 回复超时 | 先检查 Telegram 中是否已创建成功，再决定是否重试 |

同一 account_id 和用户名已有数据库记录时，创建接口直接返回已保存 Token；更改 name 不会更新已有 Bot。它不提供 Token 轮换、删除 Bot 或导入已有 Bot 功能。

### 持久化和维护

用户会话文件位于容器内 `/data/<account_id>.json`，挂载到 Compose 命名卷 `<项目名>_telegram-data`。当前本地卷为 `telegram-card-bot-github_telegram-data`。宿主机路径可通过以下命令查询：

```bash
docker volume inspect telegram-card-bot-github_telegram-data \
  --format '{{.Mountpoint}}'
```


- `.env`、`data/` 已被 Git 忽略，真实凭据不放入镜像。
- Docker 命名卷 `telegram-data` 保存 App 凭据和用户会话，现有 MySQL 保存 Bot 信息和 Token；数据库写入失败时，会话文件临时保存待补写的 Bot 结果，文件权限为 `600`，应保护宿主机和备份。`API_KEY` 可访问本服务管理的所有账号。
- `docker compose down` 保留数据；`docker compose down -v` 会删除数据卷。
- 账号会话撤销或失效时重新发起登录；旧 Bot Token 仍可从旧 `account_id` 的记录取回。
- 非 Docker 本地运行：设置 `API_KEY` 后执行 `npm run start:api`；需设置 `MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`，可用 `MYSQL_PORT`（默认 3306）、`PORT`、`DATA_DIR` 设置连接和目录。

### 重启、退出登录和验证

```bash
docker compose ps
docker compose logs --tail 50 telegram-api
curl http://127.0.0.1:3100/health
docker compose restart telegram-api
```

重启后用原 `account_id` 查询状态和 Token；创建新 Bot 时会实际检查 Telegram 会话。无需再次发送验证码。若要退出 Telegram 登录，在客户端「设置 → 设备/活跃会话」中终止该脚本会话；本服务尚无退出接口。终止会话不会删除 Bot 或使其 Token 失效，本地记录仍保留。

已在本地 Docker 完成真实 MySQL 自动建库建表、测试记录写入读取、API 鉴权与 Token 查询，以及真实 Telegram 验证码登录。真实 BotFather 创建尚未实测。文档不包含测试账号、验证码或真实密钥。

### MySQL Bot 数据

Compose 仅启动 API 服务，使用已有 MySQL，不会创建新的数据库容器。所有数据库连接参数均来自 `.env`：`MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`。服务启动时先连接 MySQL 自动创建 `MYSQL_DATABASE` 指定的数据库，再创建 `telegram_bots` 表，完成后才开始监听 API，保存所属 `account_id`、Telegram Bot 数字 ID、用户名、显示名称、Token、创建和更新时间。用户名不区分大小写并有唯一约束。Token 以明文保存在数据库中以便 API 返回，数据库访问凭据与备份应保密。

本地 MySQL 已映射宿主机 3306 时，使用模板中的 `MYSQL_HOST=host.docker.internal`；Compose 已配置 Linux 的 host-gateway 映射。不要在 API 容器中使用 `localhost` 连接另一个容器。也可将两个容器加入同一个 Docker 网络，然后用 MySQL 容器名作为主机。无需预先创建数据库；API 用户需对目标数据库有 `CREATE`、`SELECT`、`INSERT` 权限。`MYSQL_DATABASE` 仅允许 1–64 位字母、数字、下划线，支持通过环境变量动态指定。初始化失败时服务启动失败，不会接受业务请求。若远程创建成功后数据库暂时不可用，结果先记入会话恢复记录；同一 `account_id` 的后续请求会先补写数据库，避免重复创建。

默认 API 宿主机端口为 `3100`，可通过 `API_PORT` 调整，避免与已有 3000 端口服务冲突。将 `MYSQL_DATABASE` 配置为目标库名即可；库表已存在时不会清空数据或自动修改已有结构。

### 可选：手动初始化数据库和表

通常无需手动导入，服务启动已自动完成建库建表。如需管理员预先初始化，建库建表脚本为 [`sql/init.sql`](sql/init.sql)，默认数据库名为 `telegram_bot`，与 `.env.example` 一致。若使用其他 `MYSQL_DATABASE`，先修改 SQL 中的 `CREATE DATABASE` 和 `USE` 数据库名。脚本使用 `IF NOT EXISTS`，可重复导入，不会清空现有数据；不会自动修改已存在表的结构。

使用宿主机 MySQL 客户端导入（密码在提示中输入）：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p < sql/init.sql
```

也可通过本地 `mysql` 容器导入：

```bash
docker cp sql/init.sql mysql:/tmp/telegram-bot-init.sql
docker exec -it mysql mysql -u root -p -e 'source /tmp/telegram-bot-init.sql'
```

导入后，将 `.env` 的 `MYSQL_DATABASE` 设置为对应库名，并填写有权限访问此库的 `MYSQL_USER`、`MYSQL_PASSWORD`，再启动 API 服务。SQL 不包含数据库账号或密码。

### 可选：通过 Node.js 脚本自动创建 Bot

除 Docker API 外，也可在本地终端运行独立创建脚本。需要 Node.js 20 或更新版本；脚本将会话和 Token 保存为本地文件，不使用 API 的数据卷或 MySQL。

`scripts/create-bot.js` 使用个人 Telegram 账号通过 MTProto 与官方 BotFather 对话，依次发送 `/newbot`、名称和用户名，提取返回的 Bot Token。首次无需已有 Bot Token，但需要在 [my.telegram.org](https://my.telegram.org) → API development tools 申请的 App `api_id`、`api_hash`。网页端登录会话不能直接作为本脚本的会话。

在仓库根目录执行：

```bash
npm install
cp scripts/create-bot.env.example scripts/create-bot.env
chmod 600 scripts/create-bot.env
```

编辑 `scripts/create-bot.env`，填写以下环境变量。模板不包含真实凭据：

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| TG_API_ID | 是 | App api_id，正整数 |
| TG_API_HASH | 是 | App api_hash，32 位十六进制密钥 |
| TG_PHONE | 是 | 个人账号手机号，包含国家区号，如 `+86...` |
| TG_BOT_NAME | 是 | 新机器人的显示名称 |
| TG_BOT_USERNAME | 是 | 唯一用户名，5–32 位，以字母开头、以 bot 结尾，仅含字母、数字、下划线 |
| TG_PHONE_CODE | 否 | 首次登录验证码，不提供时终端输入 |
| TG_PASSWORD | 否 | 两步验证密码，不提供时终端输入 |
| TG_SESSION_PATH | 否 | 用户会话路径，默认 `scripts/.telegram-user.session`，直接保存 StringSession 文本 |
| TG_TOKEN_FILE | 否 | Token 输出文件，默认 `scripts/.bot-token.env`，必须不存在 |

加载环境变量并运行：

```bash
set -a
source scripts/create-bot.env
set +a
npm run create:bot
```

脚本只从环境变量读取创建配置；也可由终端或密钥管理工具直接注入，无需配置文件。`source` 会执行 Bash 语法，只加载自己填写的可信文件。可通过 `TG_PHONE_CODE`、`TG_PASSWORD` 环境变量传入登录验证码和两步验证密码；未提供时在终端输入；验证码会过期，建议临时注入。用户会话有效时，后续运行可复用登录。

成功后 Token 写入 `TG_TOKEN_FILE`，格式为 `BOT_TOKEN=...`，文件仅当前用户可读写，不在终端显示 Token。脚本会拒绝覆盖已有输出文件。将该值填入下文 Cloudflare 的 `BOT_TOKEN` Secret 和 `scripts/env` 的 `BOT_TOKEN`；不会自动部署 Worker 或注册 Webhook。

不要同时手动操作 BotFather 或运行多个创建脚本。脚本依赖 BotFather 的英文提示，用户名占用、创建限制、回复变化或超时会停止流程；重新运行前检查 BotFather 对话，确认是否已创建成功，避免重复创建。脚本属于对话自动化，没有官方独立的 `createBot` HTTP 接口，尚未完成真实账号创建实测。

`scripts/create-bot.env`、默认 Token 输出和会话文件已被 Git 忽略。若自定义输出路径，请自行确认不会提交到 Git。会话文件可用于访问个人账号，应与 `api_hash`、Bot Token 一并保密。详见 [BotFather 流程](https://core.telegram.org/bots/features#creating-a-new-bot)、[用户授权](https://core.telegram.org/api/auth) 和 [Teleproto](https://docs.teleproto.dev/)。


## 2. Telegram Card Bot

Cloudflare Workers 接收 Telegram Webhook，在私聊收到 `/start` 后发送图片、文案和网址按钮。无图片时发送文字和按钮。卡片服务无需数据库。

### 准备

- 使用上方 API 创建 Bot 获取 Token，或在官方 @BotFather 通过 `/newbot` 手动创建。
- 注册 Cloudflare 账号，准备卡片图片直链和文案。
- Token 通常是 `数字ID:密钥`，Bot 用户名和普通账号 ID 不是 Token。
- 不要提交真实 Token 或 Webhook 密钥；`.dev.vars.example` 只是配置模板，不会自动配置线上变量。

### 使用流程

1. 准备 Bot Token、落地页网址，以及可选的图片和文案。
2. 将 `src/index.js` 部署到 Cloudflare Workers。
3. 设置 Worker 运行时变量和 Secrets，保存并部署。
4. 在本地配置 `scripts/env`，运行注册 Webhook 脚本。
5. 打开 `https://t.me/你的机器人用户名`，点击 Start 或发送 `/start`。

只响应私聊中的 `/start`（可带参数），忽略其他消息和群聊。配置了 `CARD_IMAGE` 时发送图片、文案和网址按钮；没有图片时发送文字和按钮。网址按钮只打开配置的网址，不在 API 服务中记录点击。

### 部署到 Cloudflare Workers

Cloudflare 控制台 → Workers & Pages → 创建应用 → 从 Git 仓库导入，选择本仓库。

- 部署命令：`npx wrangler deploy`
- 项目根目录：仓库根目录。
- 本项目无需构建；如果要求构建命令，可填写 `npm run check`。

也可以创建 Hello World Worker，在代码编辑器粘贴 `src/index.js` 并部署。使用提供的 `workers.dev` 地址，无需自有域名。

### 配置运行时变量

Worker → Settings → Variables and Secrets，添加并保存部署：

| 名称 | 类型 | 必填 | 默认值/格式 | 用途 |
| --- | --- | --- | --- | --- |
| BOT_TOKEN | Secret | 是 | `数字ID:密钥` | 调用 Telegram Bot API；不是 App api_hash |
| WEBHOOK_SECRET | Secret | 是 | 1–256 位字母、数字、下划线或短横线，建议随机 32 位以上 | 验证 Telegram 请求，需与本地注册配置一致 |
| WEBHOOK_PATH | Text | 否 | `/webhook` | 接收 Webhook 的路径；修改后重新注册 |
| LANDING_URL | Text | 是 | 完整 `http://` 或 `https://` URL，可带查询参数 | 网址按钮目标 |
| CARD_IMAGE | Text | 否 | 空 | 公网图片直链或 Telegram file_id |
| CARD_TEXT | Text | 否 | `欢迎访问平台` | 有图最多 1024、无图最多 4096 个 JavaScript 字符，普通文本 |
| BUTTON_TEXT | Text | 否 | `立即进入平台` | 网址按钮文字 |

配置的是 Worker 运行时变量，不是 Git 构建环境变量。业务值不写入 wrangler 配置，方便在控制台修改。

### 本地开发

本地开发使用 `.dev.vars`，与 API 的 `.env` 独立：

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写上表的 Bot Token、Webhook 密钥、落地页等
npm run dev
```

Wrangler 显示本地地址；Telegram 注册 Webhook 需要可从公网访问的 HTTPS 地址，不能直接使用 localhost。通过 Cloudflare 控制台配置的线上变量不会自动写入本地 `.dev.vars`，本地配置也不会自动同步线上。

### 注册 Webhook

注册脚本将公网 Worker URL 和校验密钥提交给 Telegram，并查询 Webhook 信息。它只配置消息接收入口，不会部署 Worker 或创建 Bot。复制模板：

```bash
cp scripts/env.example scripts/env
chmod 600 scripts/env
```

编辑 `scripts/env`，填写：

```ini
BOT_TOKEN=你的BotFather令牌
WEBHOOK_SECRET=与Cloudflare中完全一致的密钥
WORKER_URL=https://你的worker.你的子域.workers.dev
WEBHOOK_PATH=/webhook
```

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| BOT_TOKEN | 是 | 与 Worker 的 BOT_TOKEN 完全一致 |
| WEBHOOK_SECRET | 是 | 与 Worker 的 WEBHOOK_SECRET 完全一致 |
| WORKER_URL | 是 | 公网 HTTPS 源地址，例如 `https://example.workers.dev`，不包含路径或查询参数 |
| WEBHOOK_PATH | 否 | 默认 `/webhook`；必须与 Worker 使用的路径一致 |

支持空行、整行 `#` 注释和包裹值的单引号/双引号；值按原文读取，不执行命令或展开变量。不要使用 `export` 或行尾注释。`scripts/env` 已被 Git 忽略，不提交密钥。建议执行 `chmod 600 scripts/env`。

在 Bash 终端执行：

```bash
bash scripts/register-webhook.sh
```

脚本自动读取其所在目录的 `env`，不再交互输入。从 `scripts` 目录也可执行 `bash register-webhook.sh`。确认 setWebhook 返回 `ok: true`，getWebhookInfo 的 URL 正确。本地 env 只用于注册 Webhook，不会同步 Cloudflare 变量。

### 测试和维护

| Worker HTTP 状态 | 含义 |
| --- | --- |
| 200 | 已处理，或消息不属于私聊 `/start` 而被忽略 |
| 400 | Webhook 请求不是有效 JSON |
| 403 | Telegram Secret Header 与配置不一致 |
| 404 | 请求路径不匹配 |
| 405 | Webhook 路径收到非 POST 请求 |
| 500 | 缺少密钥、落地页无效或文案超长 |
| 502 | Telegram 发送接口失败或网络请求异常 |


进入 Bot，点击 Start 或发送 `/start`，确认收到卡片，点击按钮检查完整落地页地址。

- 根路径返回 404、浏览器 GET 访问 Webhook 返回 405 是正常行为。
- 无回复：检查 getWebhookInfo 和 Worker 日志。
- 图片失败：检查直链是否能直接下载图片；先移除 CARD_IMAGE 验证文字发送。
- 修改图片、文案、按钮、落地页：保存并部署变量即可。
- 修改密钥、Token、路径或 Worker 地址：重新注册 Webhook。

普通网址按钮无法强制使用 TG 内置浏览器，取决于客户端和用户设置。基础版没有持久化去重，Telegram 重试时可能重复发送。不提供点击统计。


## 参考文档

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [BotFather 创建流程](https://core.telegram.org/bots/features#creating-a-new-bot)
- [Telegram 用户授权](https://core.telegram.org/api/auth)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
