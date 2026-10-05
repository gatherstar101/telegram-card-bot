# Legacy Telegram Card Bot — 已弃用 / 不可用

> **已弃用（Deprecated）：本目录不再作为可用项目提供。** 仅保留历史源码，不再维护，不提供部署或可用性保证。旧配置、开发、部署和注册 Webhook 的步骤已经移除。

该项目原为独立 Cloudflare Worker，为单个已有 Bot 回复固定卡片。当前卡片、Webhook、平台注册、Telegram 认证、Bot/Channel 创建和测试/生产发布统一由 `main` 分支的 `auto-register/` Docker API 提供。

使用[主 README](../README.md)完成运行时配置和部署，只需构建 `auto-register/` 一个目录；完整业务调用见[统一开通流程](../auto-register/PRODUCT-FLOW.md)。根目录保留的历史 `dev` / `deploy` 脚本仍指向本目录，不作为当前服务的启动或发布入口。

已有 Bot 迁移前确认所有权并保存卡片配置。当前 API 注册的新 Webhook 会替换该 Bot 原来的回调，不能同时使用两个入口；项目资源通过发布流程注册。历史源码的语法检查不证明 Legacy 可以运行。

Cloudflare 平台适配另见 [feature-cfworker 分支](https://github.com/gatherstar101/telegram-card-bot/tree/feature-cfworker)。该分支与本目录的 Legacy 项目分别管理，应按其分支文档使用。
