# yuanbao-connection Specification

## Purpose
TBD - created by archiving change switch-yuanbao-to-yuanbao-bot. Update Purpose after archive.
## Requirements
### Requirement: Sign Token 认证
桥接器 SHALL 在建立 WebSocket 连接前，使用 AppId 和 AppSecret 通过 HMAC-SHA256 签名调用元宝 Sign Token API 获取认证 token。token SHALL 在有效期内被缓存，并在过期前自动刷新。

#### Scenario: 首次获取 token
- **WHEN** 桥接器启动且本地无缓存 token
- **THEN** 系统向元宝 Sign Token API 发送带签名的 POST 请求并获取 token

#### Scenario: 使用缓存 token
- **WHEN** 桥接器重连且缓存 token 仍在有效期内（距过期 > 60 秒）
- **THEN** 系统直接使用缓存 token，不重新请求 API

#### Scenario: AppId 或 AppSecret 缺失
- **WHEN** 配置中 `appId` 或 `appSecret` 为空
- **THEN** 系统记录错误日志并终止连接，不抛出未捕获异常

### Requirement: WebSocket AUTH_BIND 握手
桥接器 SHALL 在 WebSocket 连接建立后立即发送 AUTH_BIND 帧，并等待 BIND_ACK 响应（超时 10 秒）。AUTH_BIND 帧 SHALL 使用 Sign Token API 返回的 `source` 字段。

#### Scenario: 认证成功
- **WHEN** 服务器返回 BIND_ACK 且 code 为 0
- **THEN** 桥接器进入 `connected` 状态并启动心跳

#### Scenario: 认证失败（需刷新 token）
- **WHEN** 服务器返回 BIND_ACK 且 code 在 {4001, 4002, 4003} 中
- **THEN** 系统强制刷新 token 并触发重连

#### Scenario: AUTH_BIND 超时
- **WHEN** 10 秒内未收到 BIND_ACK
- **THEN** 系统关闭连接并触发重连

### Requirement: 心跳保活
桥接器 SHALL 每 30 秒发送一次 PING 帧并等待 PONG 响应（超时 10 秒）。连续 2 次 PONG 超时 SHALL 触发重连。

#### Scenario: 心跳正常
- **WHEN** PING 帧在 10 秒内收到 PONG 响应
- **THEN** 系统重置超时计数器，连接保持

#### Scenario: 连续心跳超时
- **WHEN** 连续 2 次 PING 未在 10 秒内收到 PONG
- **THEN** 系统关闭当前连接并触发自动重连

### Requirement: 自动重连
桥接器 SHALL 在连接意外断开时以指数退避策略自动重连（最多 100 次，最大间隔 60 秒）。以下关闭码 SHALL 不触发重连：4012, 4013, 4014, 4018, 4019, 4021。

#### Scenario: 网络断开后重连
- **WHEN** WebSocket 连接以非禁止重连码关闭
- **THEN** 系统在退避延迟后发起新的连接，强制刷新 token

#### Scenario: 达到最大重连次数
- **WHEN** 重连次数达到 100 次
- **THEN** 系统停止重连并将状态设为 `error`

