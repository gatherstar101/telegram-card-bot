# 统一开通、测试与生产发布

本文适用于 main 的单镜像 Node.js Docker API。用户完成邮箱注册与登录，保存自己的 Telegram App 配置并认证个人账号，提交业务项目。系统编排 Bot、卡片、Webhook、可选私有 Channel 和引导帖子。继续使用平台 Bearer 会话，未增加用户 API Key。

Landing Page 是客户提供的 HTTP(S) 地址；平台配置卡片及追踪链接，不生成页面。测试与生产使用 Telegram 正式网络中的独立 Bot，必要时使用独立私有 Channel。Telegram 也有[官方独立测试网络](https://core.telegram.org/api/auth#test-accounts)，本版本未切换到该网络。

## 身份与数据归属

平台注册生成 user_id；App 配置使用 app_config_id；个人 Telegram 账号使用 account_id；业务项目使用 project_id；流程使用 workflow_id，具体异步任务使用 job_id。

所有身份归属从登录用户取得，普通请求不能指定 user_id。跨用户账号、App、项目与任务返回 404。Telegram 手机号只有完成认证后才登记正式绑定，未完成的发码不能占有别人的账号。重复登录优先复用已有 account_id。Telegram 数字身份和正式手机号归属在同一 SQL 事务内绑定，失败不会留下部分绑定。暂时存储故障保留 identity_pending 和加密 Session，恢复后向 verify 提交 {}；此状态不能开通业务。账号手机号摘要通过索引查询，旧库需离线补齐 phone_key，未完成前拒绝新登录。Telegram 数字 user_id 唯一绑定平台账号，username 只用于展示；当前没有跨用户转移接口。

Bot 访客与平台用户分别存储。test_user_ids 是允许访问测试 Bot 的 Telegram 数字 ID，不是平台 UUID 或 @username。生产 Bot 面向实际访客，平台用户的资源管理身份不作为生产访客白名单。

## 运行与配置

构建只需 auto-register/，全部业务配置在容器运行时注入。镜像不含真实 .env，不需要构建时连接 SQL、Redis 或 SMTP：

```bash
cd auto-register
cp .env.example .env
# 填写 ADMIN_EMAIL/ADMIN_PASSWORD、DB_*、Redis、SMTP、HMAC、凭据密钥
# 完整开通还需要 PUBLIC_BASE_URL，例如 https://api.example.com
docker compose build telegram-api
docker compose up -d telegram-api
```

数据库、Redis、邮件、端口及密钥全部设置见[主 README](../README.md#configuration)。新增全局默认配置：

| env | 默认 / 范围 | 用途 |
| --- | --- | --- |
| MAX_TG_APPS_PER_USER | 5 / 1–100 | 用户 App 配置数 |
| MAX_PROJECTS_PER_USER | 10 / 1–1000 | 未归档项目数 |
| MAX_ACTIVE_WORKFLOWS_PER_USER | 2 / 1–20 | queued/running 流程数 |
| BUSINESS_EVENT_RETENTION_DAYS | 90 / 1–3650 | 业务事件及已完成派发记录保留期 |
| RAW_UPDATE_RETENTION_DAYS | 7 / 0–90 | Telegram 原始更新保留期，0 不保存 |
| TRACKING_LINK_TTL_SECONDS | 86400 / 60–604800 | 私聊卡片链接有效期 |

MAX_TG_ACCOUNTS_PER_USER、MAX_BOTS_PER_USER、MAX_CHANNELS_PER_USER 沿用已有配置，测试资源和生产资源都计入总量。管理员 PUT /admin/users/:user_id/limits 可以覆盖这六种资源/并发额度；body={} 恢复 env 默认值。修改配额有审计，不删除已创建资源。GET /v1/me/limits 返回覆盖值与有效值。

API 的 Telegram 登录必须使用用户保存的 app_config_id 或请求中的 api_id/api_hash，不再读取平台 TG_API_ID/TG_API_HASH 作为登录默认值。独立 create-bot 脚本继续使用 TG_*。

## 完整开通示例

先按[平台注册与登录](../README.md#usage)取得 ACCESS_TOKEN。以下变量为调用方的本地变量，业务参数保存到 DB：

```bash
BASE_URL='https://api.example.com'
ACCESS_TOKEN='YOUR_PLATFORM_ACCESS_TOKEN'
```

### 1. 保存自己的 Telegram App

```bash
curl -X POST "$BASE_URL/v1/telegram-apps" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"My Telegram App","api_id":123456,"api_hash":"REPLACE_WITH_YOUR_32_HEX_APP_HASH"}'
```

返回 id、api_id、name、version、status=configured，不回显 api_hash。GET /v1/telegram-apps 查询配置摘要；PATCH /v1/telegram-apps/:id 用同样字段更新。保存配置只校验格式，可用性通过实际 Telegram 认证确认。修改配置不会覆盖已有授权会话。

### 2. 认证个人 Telegram 账号

```bash
APP_CONFIG_ID='UUID_FROM_PREVIOUS_RESPONSE'
curl -X POST "$BASE_URL/v1/login/start" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"app_config_id\":\"$APP_CONFIG_ID\",\"phone\":\"+447700900123\"}"
```

保存 account_id，POST /v1/accounts/:id/verify 提交 code；status=password_required 时再提交 password。本地绑定暂时失败返回 503 IDENTITY_PERSISTENCE_FAILED / retry_verify，稍后向相同 verify 提交 {}，无需再次使用验证码。验证码和两步验证密码不会作为历史资料保存。再次 start 已授权账号返回原 account_id；需要重新认证时传 reauthenticate=true，重新接收验证码，资源归属保持。发码仍有每手机号 60 秒冷却。

GET /v1/onboarding 返回下一阶段、App 是否配置、已保存的认证状态、账号与项目列表；不会在线探测 Telegram 会话。

### 3. 创建项目草稿

```bash
ACCOUNT_ID='YOUR_ACCOUNT_UUID'
curl -X POST "$BASE_URL/v1/projects" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d "{
    \"account_id\":\"$ACCOUNT_ID\",
    \"name\":\"Customer A campaign\",
    \"customer_id\":\"customer-a\",
    \"test_bot\":{\"name\":\"Customer A Test\",\"username\":\"YOUR_UNIQUE_TEST_BOT\"},
    \"production_bot\":{\"name\":\"Customer A\",\"username\":\"YOUR_UNIQUE_PRODUCTION_BOT\"},
    \"landing_url\":\"https://customer.example.com/offer\",
    \"card_text\":\"Welcome\",
    \"button_text\":\"Learn more\",
    \"test_user_ids\":[\"123456789\"],
    \"channel\":{\"title\":\"Customer A offers\",\"about\":\"Campaign\",\"post_text\":\"Explore our offer\"}
  }"
```

Bot username 必须为 5–32 位字母/数字/下划线、首位字母、以 bot 结尾，测试与生产不同且 Telegram 全局可用。name/account_id/customer_id/test_bot/production_bot/landing_url/test_user_ids 必填；card_text/button_text 有默认值，card_image 可选，channel 可省略。test_user_ids 为 1–100 个 ID 字符串。

返回 id、draft_version。PUT /v1/projects/:id 使用完整项目参数保存新草稿。已创建 Bot 的名称/用户名及 Channel title/about 不通过草稿替换；可修改落地页、卡片、测试名单及帖子文案。执行中的项目不能编辑，先取消流程。GET /v1/projects/:id/preview 返回配置预览 JSON，没有新增网页前端。

### 4. 系统创建测试资源

```bash
PROJECT_ID='YOUR_PROJECT_UUID'
curl -X POST "$BASE_URL/v1/projects/$PROJECT_ID/provision" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

返回 HTTP 202、workflow_id。系统依次创建测试 Bot、配置 Landing 卡片、注册 Webhook、按需创建测试 Channel/帖子、检查远端 Webhook 状态，最后进入 waiting_test。

```bash
WORKFLOW_ID='YOUR_WORKFLOW_UUID'
curl "$BASE_URL/v1/projects/$PROJECT_ID/workflows/$WORKFLOW_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

进度示例：

```json
{
  "workflow_id":"UUID",
  "environment":"test",
  "version":1,
  "status":"running",
  "completed_steps":2,
  "total_steps":7,
  "stage":"register_webhook",
  "next_action":null,
  "steps":[
    {"position":0,"code":"create_bot","status":"succeeded","job_id":"JOB_ID"},
    {"position":1,"code":"configure_landing","status":"succeeded","job_id":null},
    {"position":2,"code":"register_webhook","status":"running","job_id":null}
  ]
}
```

步骤数量由是否启用频道和帖子决定，completed_steps 不代表剩余时间。流程与步骤均在 DB，重启后继续执行，已有资源不会按流程重建。一个项目只允许一个活动流程。GET /v1/projects/:id/workflows 查看历史摘要；GET /v1/projects/:id 返回 active_workflow，可找回丢失的受理响应。

新流程先执行 verify_webhook，再创建频道和发帖；已有流程保留原步骤顺序。底层任务与步骤 job_id 在同一事务提交，并保存 project_id/workflow_id；工作进程执行前检查关联和项目状态，关联缺失不会当作独立任务执行。流程租约每 30 秒续期，步骤和最终发布只允许当前有效持有者写入。流程重试只在接口事务中保存恢复意图，后台逐步恢复子任务，仍保留未知结果核对要求。

### 5. 测试并验收

使用 test_user_ids 中的 Telegram 账号打开测试 Bot，点击 Start，确认文案/图片并点击卡片按钮，确认目标页面。非名单用户不收到测试卡片。必须存在本版本测试卡片发送成功和追踪链接访问记录，再确认：

```bash
curl -X POST "$BASE_URL/v1/projects/$PROJECT_ID/test-confirmation" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"confirmed":true}'
```

链接访问记录代表平台收到跳转请求；页面最终正确打开仍由测试人员确认，不代表浏览器已完整加载目标页面。测试 Bot 白名单不等于测试 Channel 入群审批；测试频道保持私有，仅向测试人员发放邀请链接，当前没有自动入群审批功能。

### 6. 发布生产资源

```bash
curl -X POST "$BASE_URL/v1/projects/$PROJECT_ID/publish" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

系统为已验收草稿创建并配置独立生产 Bot/Channel，完成检查后更新 published_version。生产 Bot、Token、Webhook Secret 与测试资源独立。之后发布新版本复用资源。生产卡片读取已发布配置，草稿和未完成发布不影响当前已发布卡片。

频道帖子可能已经发出，但新版本签名链接只有在该版本存在成功生产流程记录后才能跳转；尚未发布或失败版本返回 403 / VERSION_NOT_PUBLISHED。Telegram 发帖与数据库发布提交不能组成一个远端事务，失败后不自动撤回已发帖子。回滚不撤销曾成功发布版本的链接资格，链接仍受用户/项目授权版本和有效期限制。

GET /v1/projects/:id/versions 查看最近 100 个版本摘要。POST /v1/projects/:id/rollback，body={"version":1,"confirmed":true}，返回 202；只能回滚到成功发布过的生产版本，运行同样的配置/检查流程。回滚改变后续业务配置，不撤回已发送卡片或删除旧频道帖子。

## 状态、错误与恢复

| 流程状态 | 下一步 |
| --- | --- |
| queued / running | 等待并查询进度 |
| waiting_test | 测试名单用户验收 |
| failed | 查看失败步骤，修正后 POST workflows/:id/retry |
| needs_reconciliation | 查看步骤 job_id，先核对远端资源，再重试 |
| suspended | 恢复用户/项目，重新登录并明确重试 |
| succeeded / cancelled | 已结束 |

取消使用 POST /v1/projects/:id/workflows/:workflow_id/cancel，不删除远端资源。重试复用成功步骤。Bot/Channel 结果未知时仍使用现有 reconcile 接口，不盲目再次创建。retry 返回 202。

错误保留兼容的 error 字符串，并追加 code、next_action、retryable、request_id 和可选 retry_after：

```json
{"error":"请先验证当前草稿版本","code":"TEST_REQUIRED","next_action":"test_and_confirm","retryable":false,"request_id":"UUID"}
```

## 访客、来源与效果数据

项目 Bot 收到 /start SOURCE 时保存来源、发送者可用资料、卡片版本和业务事件。频道引导使用带项目/环境来源的 Bot 链接。客户端可生成独立来源链接 https://t.me/YOUR_BOT?start=SOURCE，SOURCE 为最多 64 位字母/数字/下划线/短横线。

GET /v1/projects/:id/events 查询事件（最多 100 条、UUID after 游标）；GET /v1/projects/:id/statistics 按 environment/type/source 汇总。测试和生产分别统计。私聊卡片使用带期限签名跳转，频道帖子使用签名持久链接；后者不受卡片 TTL 限制，但仍受用户和项目停用/授权版本控制。网页访问记录包括时间、IP、客户端声明的 UA；链接访问可能包含预览或重复访问，不是唯一用户或成交。

POST /v1/projects/:id/conversions 用平台 Bearer 回传 {"event_id":"order-123","source":"channel_a","value":10,"currency":"USD"}，按项目/event_id 去重，标记为客户回报，不独立验证订单真实性。

DB 保存 Telegram App、账号身份、项目版本、流程步骤、访客资料、原始更新及事件。原始更新和详细资料加密，普通事件查询不返回原始更新。有效 Webhook 的非 /start 更新也可保存，白名单拒绝、停用或限流丢弃的更新不保证留存。Telegram 不自动提供访客手机号、邮箱、浏览器 IP/UA 或消息已读状态；浏览器信息只有访问平台跳转时可获取。

后台按配置清理事件和 raw_update；实际原始数据保留期不会超过事件总保留期。管理员 audit_logs、配置版本、访客摘要和未知任务不按此保留期删除。备份应同时管理保留期。

## 全量停用与恢复

用户状态采用软控制：`user_security.disabled` 为 BOOLEAN，MySQL 对应 0/1，PostgreSQL 对应 false/true。API 统一提交布尔值；true 禁用、false 启用，不删除用户或历史业务数据。项目另用 active/paused/archived 表示生命周期。

管理员 PATCH /admin/users/:id 或 PUT /admin/users/:id/disabled，body={"disabled":true,"reason":"业务暂停"}。在同一 SQL 事务中撤销会话、更新业务授权版本、取消排队任务/投递、挂起流程并记录审计。远端操作的派发许可与禁用使用同一个用户行锁协调；每次 Telegram 操作、卡片发送、Webhook 配置、跳转都检查。

禁用后 Webhook 验证来源并返回 200 丢弃，避免 Telegram 不断重投；已领取的任务在下一操作前停止。管理员 GET /admin/users/:id 返回账号、项目、配额以及已获许可的在途操作。中断后超过 10 分钟仍无结果的派发记录标记 unknown，不能当作远端已完成。

禁用提交后不再批准新派发。提交前已批准/发出的请求可能完成，保留结果或待核对状态；已发布 Telegram 消息、现有频道成员、复制出去的第三方 Landing URL 不会自动删除或失效。当前不提供自动远端删帖、踢成员或撤销全部邀请链接，remote_cleanup 返回 not_requested。

重新启用不会自动重放消息、恢复旧会话或继续挂起流程。项目 POST pause/resume/archive 也更新项目授权版本，取消积压任务。旧追踪链接在暂停/禁用后不会随重新启用而恢复；明确重新发布会生成新授权版本的帖子链接。archive 保留数据与 Telegram 资源，不提供物理删除接口。

## 密码恢复、升级与验证

普通用户 POST /auth/password/reset/start 提交 email；POST /auth/password/reset/verify 提交 challenge_id、6 位 code、new_password。验证通过更新哈希并撤销全部平台会话，重新登录。仍使用 10 分钟 OTP、60 秒邮件冷却与发码 QPS。未知/管理员邮箱不发送重置码，管理员不能通过此入口绕过管理登录保护。

启动自动增加 14 张产品表，总计 24 张表。旧十表的数据保留，新项目模型不自动接管旧 Bot。MySQL [003-product.sql](sql/003-product.sql) 与 PostgreSQL [003-product.sql](sql/postgresql/003-product.sql) 为新增表参考；MySQL 手动索引 SQL 仅首次安装执行，运行时会检查索引是否存在。完整新库 SQL 仍为各引擎 init.sql。

凭据重加密接口还支持 telegram_apps、telegram_identities、project_versions、telegram_visitors、business_events、api_jobs、webhook_deliveries。按各表返回的 next_cursor 分页，不自行构造复合游标。所有在线记录及需要恢复的备份完成处理前，保留旧密钥。

```bash
# auto-register/，使用隔离测试库与 Redis prefix
npm run check
npm test
SECURITY_INTEGRATION=1 node --env-file=.env --test --test-concurrency=1 \
  test/database.test.js test/admin.test.js test/security.test.js test/products.test.js test/production.test.js test/upgrade.test.js
```

产品集成测试使用临时独立库，验证统一入口、归属隔离、双 Bot 发布、失败重试、版本回滚、指标、暂停/禁用、执行中停用、密码恢复和完整凭据轮换，结束删除自己的临时库。使用真实 SQL/Redis/HTTP 与本地 SMTP，Telegram 远端操作为模拟；真实 Telegram 与公网回调另行验收。SMTP 暂未配置时可以完成管理员及基础健康检查，普通用户注册/登录/密码恢复需要邮件投递。

投递事件和 sent 状态在同一租约校验事务中提交。远端成功但本地事件写入失败时，可查询 deliveries/:update_id 的 message_id；有成功回执的 uncertain 投递可 POST 同路径 /reconcile 补齐事件，不重发。事件保留原投递时间，避免把较早测试投递计为新流程验收证据；无回执则需人工核对。
