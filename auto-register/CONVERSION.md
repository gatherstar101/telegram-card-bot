# 客户 Bot、Landing Page 和 Channel 转化流程

在同一个已登录 Telegram 账号下，可以为不同客户创建各自的 Bot、绑定不同落地页，并创建频道和发布引导内容。`customer_id` 是客户业务标识，不是登录用户权限；目前仍使用管理员 API_KEY。这里配置的是客户已有的 Landing Page URL，不自动生成或部署落地页。

流程拆分为独立 API，便于分别调用和恢复：

```text
登录 → 创建 Bot → 配置客户 Landing Page
                   ├─ 注册 Webhook → Bot 私聊卡片回复
                   └─ 创建 Channel → 发布引导帖子

Channel → Bot 链接 → 用户按 Start → 客户卡片 → Landing Page
        └─ Landing Page 直接链接
```

频道帖子同时包含落地页直接链接。加入频道不会自动启动 Bot，也不会主动私信频道成员。当前统计范围不包含点击、注册或成交归因。

## 部署和配置

在 `auto-register/` 目录配置 `.env`，沿用 README 的 API_KEY、MySQL 和 Telegram 参数，增加：

```ini
PUBLIC_BASE_URL=https://bots.example.com
```

此值必须是指向 API 容器的公网 HTTPS 源地址，不含路径、查询参数或认证信息。使用反向代理将此域名转发到本地 API 端口，允许 Telegram 访问 `/webhooks/*`。这些 Webhook 请求通过 `X-Telegram-Bot-Api-Secret-Token` 校验，不使用管理员 API_KEY。其他业务接口继续使用 Bearer API_KEY。

```bash
docker compose up -d --build
```

启动会自动补建 `bot_landings`、`telegram_channels`、`channel_posts`，保留已有 Bot 表和数据。可选手工 SQL 同样包含这些表。PUBLIC_BASE_URL 只用于注册 Webhook；已经注册的 URL 需重新调用注册接口才能改变。

以下示例的 YOUR_API_KEY、ACCOUNT_ID、Bot 用户名和 URL 使用自己的实际值。第一次先按项目 README 完成登录，之后复用返回的 ACCOUNT_ID。

## 0. 登录并保存 account_id

按 [项目 README 登录步骤](../README.md#步骤-1发起登录发送验证码) 调用 `/v1/login/start` 取得 account_id，再向 `/v1/accounts/:account_id/verify` 提交收到的验证码，必要时提交两步验证密码。返回 authorized 后服务保存会话，调用方保存同一个 account_id，后续步骤持续复用。

已有会话时不需要每次调用 login/start；该接口再次调用会生成新的 ID。账号状态查询只读取本地记录，不实时检查 Telegram 会话。首次配置卡片时需要已由本服务保存的 Bot；PUBLIC_BASE_URL 仅在注册 Webhook 时需要，Channel 创建只依赖有效用户会话和 Landing 配置。

## 1. 创建 Bot

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/bots \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"name":"客户 A 助手","username":"customer_a_unique_bot"}'
```

返回 username、name、token、url，并保存到 MySQL。用户名需要全局唯一；账号需要仍有效的 Telegram 授权。同一账号和用户名已有本服务记录时返回保存结果，不创建第二个 Bot。

## 2. 配置客户 Landing Page 和卡片

```bash
curl -X PUT http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/bots/customer_a_unique_bot/landing \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{
    "customer_id":"customer_a",
    "landing_url":"https://customer-a.example.com/offer?source=telegram",
    "card_text":"欢迎查看客户 A 的活动",
    "card_image":"",
    "button_text":"查看活动"
  }'
```

| 字段 | 必填 | 限制或默认值 |
| --- | --- | --- |
| customer_id | 是 | 1–64 字符，绑定客户业务标识 |
| landing_url | 是 | 完整 HTTP(S) 地址，可带查询参数，不允许 URL 内嵌用户名密码 |
| card_text | 否 | 默认“欢迎访问平台”；有图片最多 1024，无图片最多 4096 字符 |
| card_image | 否 | 默认空；公网图片 URL 或 Telegram file_id，最多 2048 字符 |
| button_text | 否 | 默认“立即了解”，1–64 字符 |

PUT 保存完整配置，省略可选字段将恢复默认值。返回配置不含 Webhook 密钥。GET 同一路径可查询配置。不同 Bot 对应不同客户落地页，配置更新后后续 `/start` 使用新配置；不需要重新部署。Webhook 密钥在第一次配置时生成，后续更新保留。

## 3. 注册 Bot Webhook

```bash
curl -X POST http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/bots/customer_a_unique_bot/webhook \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' -d '{}'
```

返回：

```json
{"username":"customer_a_unique_bot","webhook_url":"https://bots.example.com/webhooks/123456","status":"registered"}
```

用户私聊发送 `/start` 时，API 根据 Bot ID 从 MySQL 读取客户配置并发送图片或文字、网址按钮。这里由 Docker API 直接处理卡片，无需为每个客户部署 Cloudflare Worker。一个 Bot 只能设置一个 Webhook；注册到 Docker API 会替换该 Bot 之前的 Worker Webhook。独立 `card-bot` 仍可用于其他 Bot。

## 4. 创建客户 Channel

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/channels \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{
    "request_key":"customer_a_channel_001",
    "bot_username":"customer_a_unique_bot",
    "title":"客户 A 活动频道",
    "about":"客户 A 的活动信息"
  }'
```

| 字段 | 必填 | 限制 |
| --- | --- | --- |
| request_key | 是 | 1–64 位字母、数字、下划线、短横线；同一账号下稳定且唯一 |
| bot_username | 是 | 当前账号已创建且已配置 landing 的 Bot 用户名 |
| title | 是 | 1–128 字符 |
| about | 否 | 最多 255 字符，默认空 |

创建的是私有广播频道，账号为创建者。响应包含 `request_key`、`channel_id`、`customer_id`、`bot_username`、`title`、`about`、`status: "ready"`、`invite_url`、`bot_url`，不返回 access_hash。当前不设置公开频道用户名，也不邀请用户或将 Bot 提升为管理员。发布通过登录用户账号完成。

GET `/v1/accounts/ACCOUNT_ID/channels/customer_a_channel_001` 查询已保存信息；GET 不会调用 Telegram。相同 request_key 和参数会返回已有频道，改变参数会返回 409。Channel 已创建但邀请链接生成失败时，使用同一 key 重试可继续生成链接。

Channel 创建请求本身没有服务端幂等键。如果发生网络错误，结果可能不确定，记录保留 `creating` 状态，服务返回 409 并禁止自动再次创建；先到 Telegram 检查，不应直接换 key 盲目重试。创建成功后数据库短暂故障时，会话 JSON 保存恢复信息，后续账号请求先补写数据库。

## 5. 发布转化引导帖子

```bash
curl http://127.0.0.1:3100/v1/accounts/ACCOUNT_ID/channels/customer_a_channel_001/posts \
  -H 'Authorization: Bearer YOUR_API_KEY' -H 'Content-Type: application/json' \
  -d '{"request_key":"offer_post_001","text":"本周活动已上线，点击下方链接了解详情。"}'
```

| 字段 | 必填 | 限制 |
| --- | --- | --- |
| request_key | 是 | 1–64 位字母、数字、下划线、短横线；同一频道内唯一 |
| text | 是 | 1–3000 字符，加入链接后总长度不超过 4096 |

频道发布普通文字，并追加两个可点击链接：Bot Start 链接、配置的 Landing Page。响应含 `status: "sent"`、`message_id`（如 Telegram 返回）、`bot_url`、`landing_url` 和文本。已成功发送的同 key 请求直接返回保存结果；改变正文或落地页需使用新 key。待发送记录保存 Telegram random_id，重试使用同一 random_id 来降低重复发送风险。不要无限重复提交。

## 验证和恢复

依次检查：Bot 已创建 → Landing 配置正确 → Webhook 指向公网地址 → Channel 邀请链接可加入 → 帖子能打开 Bot → Start 后返回客户卡片 → 按钮打开正确落地页。Webhook Secret 错误返回 403；缺少配置返回 404；Telegram 发送失败返回 502。

这里不会自动删除远程已创建资源或回滚已经发布的内容。步骤拆分后可以先查询状态再继续，避免重新执行成功步骤。账户限流、创建数量限制和账号权限仍由 Telegram 决定。项目提供模拟 Telegram 的流程测试；未经指定真实 Bot/Channel 信息，不自动在账号中创建或发布测试资源。

本地已验证真实 MySQL 新表初始化、客户配置保存和更新、Webhook 鉴权、Channel 查询及已发送帖子结果读取；模拟测试覆盖完整流程和重试。真实 Channel 创建、帖子发布和公网 Webhook 收发尚未执行，需要提供目标 Bot/Channel 参数及 PUBLIC_BASE_URL。
