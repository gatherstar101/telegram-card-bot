# Bot 自动化创建

单用户 Node.js API：通过验证码登录个人 Telegram 账号，持久化会话，创建指定 Bot 并将信息和 Token 保存到已有 MySQL。

在本目录复制 `.env.example` 为 `.env`，填写 API_KEY、MySQL 连接和可选 Telegram 默认参数，然后执行：

```bash
docker compose up -d --build
```

启动自动建库建表，默认 API 地址为 `http://127.0.0.1:3100`。先调用 `/v1/login/start`，再向 `/v1/accounts/:account_id/verify` 提交验证码，成功后调用 `/v1/accounts/:account_id/bots` 创建 Bot。所有业务接口使用 Bearer API_KEY。

会话保存在容器 `/data`，Compose 沿用 `telegram-card-bot-github_telegram-data` 卷。Bot Token 保存在 MySQL。完整的配置表、调用示例和维护步骤见 [项目 README](../README.md#1-bot-自动化创建)。
