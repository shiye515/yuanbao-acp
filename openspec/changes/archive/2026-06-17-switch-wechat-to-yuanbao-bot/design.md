## Context

yuanbao-acp 当前通过微信 iLink HTTP API 实现消息桥接：扫码登录获取 token → HTTP 长轮询 `getUpdates` 拉取消息 → HTTP POST `sendMessage` 发送回复。整个微信通道的代码位于 `src/weixin/`（api.ts, auth.ts, monitor.ts, send.ts, types.ts），由 `src/bridge.ts` 中的 `YuanBaoAcpBridge` 调度。

`packages/yuanbao/` 中已有一个完整可运行的元宝 Bot 客户端实现，使用 WebSocket + 自定义 Protobuf 协议（非 Google protobuf 库，纯 TypeScript 手写编解码），支持 Sign Token 认证、AUTH_BIND 握手、心跳保活、自动重连、消息去重、Reply Heartbeat（正在处理指示器）和资源下载。

## Goals / Non-Goals

**Goals:**

- 将消息通道从微信 iLink 替换为元宝 Bot WebSocket API
- 复用 `packages/yuanbao/` 中已验证的客户端代码，将其复制并适配到主项目 `src/yuanbao/`
- 支持 `YUANBAO_APP_ID` / `YUANBAO_APP_SECRET` 通过环境变量、CLI 参数和配置文件三种方式配置
- 保持与 ACP 协议层（`src/acp/`）的兼容，仅替换消息通道
- 保持 daemon 模式、inject 注入、session 管理等现有功能不变
- 支持元宝群聊高级能力：`@bot` 触发、群管理指令（开启/关闭、重置会话）

**Non-Goals:**

- 不修改 ACP 协议层代码（`src/acp/session.ts` 等）
- 不重构 inject 模块（`src/inject/`）
- 不支持微信和元宝双通道并存
- 不修改 telemetry 模块逻辑（仅更新环境变量名）

### 7. 群聊高级能力：`@bot` 触发与群管理

**决定**：群聊消息默认仅在以下条件触发 ACP session：

- 明确 `@bot`（mentions 包含 botId）
- 回复 bot 的上一条消息（reply-to-bot）
- 命中群管理指令前缀（如 `/acp`）

群管理指令范围限定为桥接层本地控制，不涉及元宝平台侧群成员管理：

- `/acp on`：开启当前群会话响应
- `/acp off`：关闭当前群会话响应（仅保留管理指令）
- `/acp reset`：重置当前群会话上下文
- `/acp status`：查询当前群会话状态

**理由**：避免群内噪音消息触发 Agent，控制 Token 成本；通过轻量管理指令让群管理员可在不改配置的情况下动态控制会话行为。

**替代方案**：（1）群聊全量消息都触发——成本高且易误触发；（2）只支持 `@bot` 不支持管理指令——缺少运维可控性。

## Decisions

### 1. 将元宝客户端代码从 packages/yuanbao 复制到 src/yuanbao

**决定**：将 `packages/yuanbao/src/` 下的 `yuanbao-client.ts`、`yuanbao-proto.ts`、`yuanbao-sign.ts` 复制到 `src/yuanbao/` 目录，并做适当修改以适配主项目架构。

**理由**：`packages/yuanbao` 是一个独立的 Pi 扩展包，有自己的依赖（`@earendil-works/pi-coding-agent`）和构建配置。直接引用它会引入不需要的 peer dependency。复制核心文件并调整导入路径更干净。

**替代方案**：（1）将 packages/yuanbao 作为 workspace 内部依赖——增加构建复杂度且引入 Pi 框架依赖；（2）发布 packages/yuanbao 为 npm 包——过度工程化，且需要维护两个包的发布流程。

### 2. 用 WebSocket 事件驱动替代 HTTP 轮询

**决定**：`YuanbaoAcpBridge` 不再需要 `startMonitor` 轮询循环，改为注册 `YuanbaoClient.onMessage()` 回调，由 WebSocket 的 push 事件驱动消息处理。

**理由**：元宝 API 是 WebSocket 长连接 + 服务端推送，天然是事件驱动的。消除了轮询的延迟和资源浪费。

### 3. 移除 QR 码登录，改用 AppId/AppSecret 认证

**决定**：移除 `src/weixin/auth.ts` 中的 QR 扫码登录流程和 `qrcode-terminal` 依赖。认证通过 `YUANBAO_APP_ID` + `YUANBAO_APP_SECRET` 调用 Sign Token API 完成，无需人工交互。

**理由**：元宝 Bot API 使用 HMAC-SHA256 签名认证，不需要扫码。这也简化了 daemon 模式（无需等待用户扫码即可启动）。

### 4. 保持 Bridge 类的主要公共接口稳定

**决定**：`YuanbaoAcpBridge` 保持 `start()` / `stop()` / `log()` 三个主要公共方法；`start()` 移除仅微信扫码场景需要的参数（如 `forceLogin`、`renderQrUrl`），内部使用 `YuanbaoClient` 替代微信 API 调用。

**理由**：对外调用方式保持稳定，同时消除与元宝认证模型不匹配的历史参数。

### 5. 消息适配：复用 IncomingMessage 结构

**决定**：`src/adapter/inbound.ts` 中的 `weixinMessageToPrompt` 函数改为 `yuanbaoMessageToPrompt`，输入类型从 `WeixinMessage` 改为元宝 `IncomingMessage`（来自 yuanbao-client.ts）。

**理由**：元宝的 `IncomingMessage` 已经包含解码后的 `text`、`chatId`、`chatType` 等字段，比微信的 `WeixinMessage`（需要额外解码 item_list）更简洁，适配代码会更简单。

### 6. 配置结构调整

**决定**：`YuanBaoAcpConfig.yuanbao` 字段替换为 `yuanbao` 字段，包含 `appId`、`appSecret`、`botId`、`wsUrl`、`apiDomain`、`routeEnv`。环境变量前缀从 `YUANBAO_ACP_` 改为 `YUANBAO_`。

**补充**：`agent`、`agents`、`session`、`daemon`、`storage`、`commandAliases` 等现有字段保持不变，仅替换消息通道字段。

**理由**：与元宝接入约定保持一致，并最大化兼容现有 ACP 运行参数。

### 8. 命名统一：内部字段使用 `appId`

**决定**：统一使用 `appId` 作为内部配置字段名，对应元宝平台文档中的 App Key；不再在主项目内使用 `appKey` 字段名。

**理由**：与 `--yuanbao-app-id`、`YUANBAO_APP_ID` 命名一致，降低用户理解成本和接入歧义。

### 9. 消息去重采用逐条过期窗口

**决定**：消息去重实现采用“逐条 5 分钟过期”语义（例如 `Map<msgId, expireAt>`），而非周期性全量清空集合。

**理由**：与 spec 的“5 分钟窗口”语义严格一致，避免因全量清空导致边界时刻漏去重。

## Risks / Trade-offs

- **[Breaking Change]** 公共 API 类型全部重命名 → 使用 TSDoc `@deprecated` 标注或在 CHANGELOG 中明确说明迁移方式
- **[WebSocket 稳定性]** WebSocket 长连接可能因网络波动断开 → `YuanbaoClient` 已内置指数退避重连（最多 100 次），可靠性已在 packages/yuanbao 中验证
- **[Protobuf 脆弱性]** 手写 Protobuf 编解码在协议变更时需手动更新 → 当前元宝 Bot API 协议稳定，且 packages/yuanbao 已在生产使用，风险可控
- **[Token 过期]** Sign Token 有有效期 → `yuanbao-sign.ts` 已实现缓存+自动刷新+强制刷新机制，认证失败时自动重连并刷新 token
- **[群聊误触发]** 群消息量大且语义复杂，可能导致误触发 Agent → 引入 `@bot/reply` 触发门槛与群开关指令，默认拒绝普通群消息
