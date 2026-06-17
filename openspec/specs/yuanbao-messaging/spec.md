# yuanbao-messaging Specification

## Purpose
TBD - created by archiving change switch-yuanbao-to-yuanbao-bot. Update Purpose after archive.
## Requirements
### Requirement: 接收入站消息
桥接器 SHALL 通过 WebSocket Push 帧接收元宝入站消息，支持 Protobuf 和 JSON 两种格式解码。收到 Push 帧后 SHALL 立即发送 Push ACK。

#### Scenario: 接收文本消息
- **WHEN** 元宝服务器推送包含 TIMTextElem 的消息
- **THEN** 系统提取文本内容并转发给 ACP agent session

#### Scenario: 接收图片消息
- **WHEN** 元宝服务器推送包含 TIMImageElem 的消息
- **THEN** 系统提取图片 URL，格式化为 `[图片] <url>` 并转发给 ACP agent

#### Scenario: 接收文件消息
- **WHEN** 元宝服务器推送包含 TIMFileElem 的消息
- **THEN** 系统提取文件名和 URL，格式化为 `[文件: <name>] <url>` 并转发给 ACP agent

#### Scenario: 忽略自身发送的消息
- **WHEN** 收到消息的 `fromAccount` 等于 bot 自身的 botId
- **THEN** 系统静默丢弃该消息，不触发 ACP session

### Requirement: 消息去重
桥接器 SHALL 对每条消息的 msgId 进行去重，在 5 分钟窗口内重复收到的相同 msgId SHALL 被丢弃。

去重窗口 SHALL 按消息维度独立计算（每条消息自首次接收起 5 分钟），不得通过“固定周期全量清空去重集合”替代。

#### Scenario: 重复消息
- **WHEN** 5 分钟内收到相同 msgId 的消息推送（如网络重传）
- **THEN** 系统丢弃重复消息，不重复触发 ACP session

### Requirement: 发送文本回复
桥接器 SHALL 将 ACP agent 的输出文本通过 `YuanbaoClient.sendMessage()` 发送回对应的 chatId。长文本 SHALL 按最大 4000 字符分块发送，优先在换行符处分割。

#### Scenario: 短消息直接发送
- **WHEN** ACP agent 回复文本长度 ≤ 4000 字符
- **THEN** 系统发送一条消息到元宝

#### Scenario: 长消息分块发送
- **WHEN** ACP agent 回复文本长度 > 4000 字符
- **THEN** 系统将文本分割为多个 ≤ 4000 字符的块并依次发送

### Requirement: Reply Heartbeat（处理中指示）
桥接器 SHALL 在开始处理用户消息时启动 Reply Heartbeat，每 2 秒向元宝发送"处理中"心跳帧，直到 ACP agent 完成回复或超时（30 秒）时发送"完成"帧。

#### Scenario: 正常处理流程
- **WHEN** 收到用户消息并开始转发给 ACP agent
- **THEN** 系统立即发送第一个 WS_HEARTBEAT_RUNNING 帧，并每 2 秒重复发送

#### Scenario: Agent 完成回复
- **WHEN** ACP agent session 完成当前 turn
- **THEN** 系统停止 Reply Heartbeat 并发送 WS_HEARTBEAT_FINISH 帧

#### Scenario: Reply Heartbeat 超时
- **WHEN** Reply Heartbeat 持续 30 秒仍未收到 agent 完成信号
- **THEN** 系统发送 WS_HEARTBEAT_FINISH 帧并停止当前会话心跳

### Requirement: 支持私聊和群聊
桥接器 SHALL 根据消息的 `chatType` 字段区分私聊（`dm`）和群聊（`group`），并使用对应的消息发送 API（`send_c2c_message` / `send_group_message`）。

#### Scenario: 私聊消息处理
- **WHEN** 收到 `chatType` 为 `"dm"` 的消息
- **THEN** 系统以 `dm:<fromAccount>` 为 chatId 建立独立的 ACP session，回复使用 C2C 发送

#### Scenario: 群聊消息处理
- **WHEN** 收到 `chatType` 为 `"group"` 的消息
- **THEN** 系统以 `group:<groupCode>` 为 chatId 建立独立的 ACP session，回复使用群聊发送

### Requirement: 群聊 `@bot` 触发策略
桥接器 SHALL 对群聊消息启用显式触发门槛。默认情况下，只有满足以下任一条件的群聊消息才会进入 ACP session：`mentions` 包含 botId、消息为 reply-to-bot、或命中群管理指令前缀 `/acp`。

#### Scenario: 普通群消息不触发
- **WHEN** 收到 `chatType` 为 `"group"` 且未 `@bot`、非 reply-to-bot、且不含 `/acp` 指令的消息
- **THEN** 系统忽略该消息，不触发 ACP session

#### Scenario: `@bot` 消息触发
- **WHEN** 收到 `chatType` 为 `"group"` 且 `mentions` 包含 botId 的消息
- **THEN** 系统将该消息转发给 ACP session 并在同一群会话中回复

#### Scenario: reply-to-bot 触发
- **WHEN** 收到 `chatType` 为 `"group"` 且消息引用了 bot 最近发送消息
- **THEN** 系统将该消息转发给 ACP session 并在同一群会话中回复

### Requirement: 群管理指令
桥接器 SHALL 支持群管理指令 `/acp on`、`/acp off`、`/acp reset`、`/acp status`，并将其作用域限定为当前群 chatId。`/acp` 指令处理 SHALL 在桥接层完成，不进入 ACP agent 推理流程。

#### Scenario: 关闭群会话响应
- **WHEN** 群内发送 `/acp off`
- **THEN** 系统将当前群会话状态设为关闭，仅继续接收 `/acp` 管理指令

#### Scenario: 开启群会话响应
- **WHEN** 群内发送 `/acp on`
- **THEN** 系统将当前群会话状态设为开启，恢复 `@bot/reply` 触发

#### Scenario: 重置群会话上下文
- **WHEN** 群内发送 `/acp reset`
- **THEN** 系统清空当前群对应的 ACP session 历史上下文，并返回重置成功提示

#### Scenario: 查询群会话状态
- **WHEN** 群内发送 `/acp status`
- **THEN** 系统返回当前群会话状态（开启/关闭）和最近一次重置时间

