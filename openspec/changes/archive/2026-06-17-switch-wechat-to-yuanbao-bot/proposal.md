## Why

当前项目 yuanbao-acp 是一个将 YuanBao（微信）iLink Bot API 桥接到 ACP（Agent Client Protocol）兼容 AI Agent 的工具。现在需要将消息渠道从微信切换为腾讯元宝（Yuanbao）Bot，使用元宝官方的 WebSocket + Protobuf Bot API 来收发消息，替代原有的微信 iLink HTTP 轮询方式。`packages/yuanbao` 中已有一个可工作的元宝客户端 demo（包含 WebSocket 连接、Protobuf 编解码、Sign Token 认证），可直接复用。

## What Changes

- **BREAKING** 移除 `src/weixin/` 目录下所有微信 iLink API 相关代码（`api.ts`、`auth.ts`、`monitor.ts`、`send.ts`、`types.ts`）
- **BREAKING** 移除微信 QR 码扫码登录流程，改为元宝 AppId/AppSecret 认证
- 将 `packages/yuanbao/src/` 中的元宝客户端代码（`yuanbao-client.ts`、`yuanbao-proto.ts`、`yuanbao-sign.ts`）复制并适配到主项目 `src/yuanbao/` 目录
- 重写 `src/bridge.ts`（`YuanBaoAcpBridge` → `YuanbaoAcpBridge`），使用 `YuanbaoClient` 的 WebSocket 连接替代 HTTP 轮询
- 重写 `src/config.ts`，将 `YuanBaoAcpConfig` 改为 `YuanbaoAcpConfig`，新增 `YUANBAO_APP_ID`、`YUANBAO_APP_SECRET` 等配置项
- 重写 `src/adapter/inbound.ts`，将元宝消息格式（`IncomingMessage`）适配为 ACP prompt
- 重命名并更新 CLI 入口（`bin/yuanbao-acp.ts` → `bin/yuanbao-acp.ts`），移除 `--login` / QR 相关选项，改为 `--yuanbao-app-id`、`--yuanbao-app-secret` 等选项
- 更新 `src/index.ts` 公共 API 导出
- 新增 `ws` 依赖（元宝客户端使用 WebSocket）
- 移除 `qrcode-terminal` 依赖（不再需要二维码扫码）
- 更新 `package.json` 元数据（description/keywords），移除 YuanBao 表述

## Capabilities

### New Capabilities

- `yuanbao-connection`: 元宝 WebSocket Bot 网关连接管理——认证（Sign Token + AUTH_BIND）、心跳、自动重连、断线恢复
- `yuanbao-messaging`: 元宝消息收发——接收入站消息（文本/图片/文件）、发送文本回复、Reply Heartbeat（处理中指示）、消息去重、群聊高级能力（`@bot` 触发、群管理指令）
- `yuanbao-config`: 元宝 Bot 配置管理——支持 `YUANBAO_APP_ID`、`YUANBAO_APP_SECRET` 环境变量，CLI 参数 `--yuanbao-app-id`、`--yuanbao-app-secret`，以及配置文件

### Modified Capabilities

## Impact

- **API**：公共导出类型从 `YuanBaoAcpBridge` / `YuanBaoAcpConfig` 改为 `YuanbaoAcpBridge` / `YuanbaoAcpConfig`，**BREAKING** 对库用户
- **依赖**：新增 `ws`（WebSocket 客户端）；移除 `qrcode-terminal`
- **代码**：`src/weixin/` 整个目录删除；`src/bridge.ts`、`src/config.ts`、`src/adapter/inbound.ts`、`bin/yuanbao-acp.ts`、`src/index.ts` 大幅重写
- **认证模型**：从"扫码登录 → 获取 token → HTTP 轮询"改为"AppId/AppSecret 签名 → WebSocket 长连接"
- **测试**：`tests/send.test.ts` 需要重写以适配新的消息发送方式

## Compatibility Notes

- `YuanbaoAcpConfig` 保留原 `YuanBaoAcpConfig` 中的 `agent`、`agents`、`session`、`daemon`、`storage`、`commandAliases` 等字段结构不变。
- 仅消息通道配置从 `yuanbao` 替换为 `yuanbao`，字段为 `appId`、`appSecret`、`botId`、`wsUrl`、`apiDomain`、`routeEnv`。
