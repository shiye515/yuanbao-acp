## 1. 引入元宝客户端代码

- [x] 1.1 创建 `src/yuanbao/` 目录，将 `packages/yuanbao/src/yuanbao-proto.ts` 复制到 `src/yuanbao/yuanbao-proto.ts`（调整为项目模块路径）
- [x] 1.2 将 `packages/yuanbao/src/yuanbao-sign.ts` 复制到 `src/yuanbao/yuanbao-sign.ts`
- [x] 1.3 将 `packages/yuanbao/src/yuanbao-client.ts` 复制到 `src/yuanbao/yuanbao-client.ts`，更新导入路径指向 `src/yuanbao/`，并统一配置字段命名 `appKey` → `appId`
- [x] 1.4 在 `package.json` 中添加 `ws` 依赖，移除 `qrcode-terminal` 依赖
- [x] 1.5 在 `package.json` devDependencies 中添加 `@types/ws`
- [x] 1.6 调整去重实现为逐条过期窗口（`Map<msgId, expireAt>`），与 spec 的“5 分钟窗口”语义一致

## 2. 重写配置层

- [x] 2.1 修改 `src/config.ts`：将 `YuanBaoAcpConfig` 接口中的 `yuanbao` 字段替换为 `yuanbao`（含 `appId`、`appSecret`、`botId`、`wsUrl`、`apiDomain`、`routeEnv`），重命名接口为 `YuanbaoAcpConfig`（保留 `YuanBaoAcpConfig` 作为类型别名以兼容旧引用）
- [x] 2.2 修改 `defaultConfig()` 函数，将微信默认值替换为元宝默认值（`wsUrl`、`apiDomain` 等）
- [x] 2.3 更新 `src/config.ts` 中 daemon 环境变量名：将 `YUANBAO_ACP_DAEMON` 改为 `YUANBAO_ACP_DAEMON`

## 3. 重写消息适配器

- [x] 3.1 修改 `src/adapter/inbound.ts`：将 `weixinMessageToPrompt` 函数改为 `yuanbaoMessageToPrompt`，输入类型从 `WeixinMessage` 改为 `IncomingMessage`（来自 `src/yuanbao/yuanbao-client.ts`）
- [x] 3.2 更新适配函数逻辑：元宝 `IncomingMessage` 已包含解码后的 `text`，直接使用；适配 `chatId`、`chatType`、`senderNickname` 等字段映射

## 4. 重写 Bridge 核心

- [x] 4.1 修改 `src/bridge.ts`：将 `import` 中所有 `./weixin/` 引用替换为 `./yuanbao/`，移除 `login`、`getBotQrcode` 等微信认证相关导入
- [x] 4.2 重命名 `YuanBaoAcpBridge` 为 `YuanbaoAcpBridge`（保留 `YuanBaoAcpBridge` 作为类型别名）
- [x] 4.3 删除 `bridge.ts` 中的 YuanBao QR 登录逻辑（`login()` 调用和 `renderQrInTerminal` 回调），改为直接调用 `yuanbaoClient.connect()`
- [x] 4.4 将 `startMonitor()` HTTP 轮询替换为 `yuanbaoClient.onMessage()` 回调注册
- [x] 4.5 将所有 `sendTextMessage()` / `sendTyping()` 调用替换为 `yuanbaoClient.sendMessage()` 和 `yuanbaoClient.startReplyHeartbeat()` / `yuanbaoClient.stopReplyHeartbeat()`
- [x] 4.6 将消息处理入口从 `weixinMessageToPrompt(weixinMsg)` 改为 `yuanbaoMessageToPrompt(incomingMsg)`
- [x] 4.7 更新 `bridge.ts` 中涉及 `config.yuanbao` 的所有引用，改为 `config.yuanbao`
- [x] 4.8 在群聊消息处理链路增加触发门槛：仅 `@bot`、reply-to-bot、`/acp` 指令进入会话
- [x] 4.9 增加群管理指令处理：`/acp on`、`/acp off`、`/acp reset`、`/acp status`
- [x] 4.10 按群 chatId 持久化群会话开关状态与最近重置时间

## 5. 重写 CLI 入口

- [x] 5.1 将 `bin/yuanbao-acp.ts` 重命名为 `bin/yuanbao-acp.ts`
- [x] 5.2 修改 `bin/yuanbao-acp.ts`：移除 `--login` / `qrcodeTerminal` 相关代码，添加 `--yuanbao-app-id`、`--yuanbao-app-secret`、`--yuanbao-bot-id`、`--yuanbao-ws-url`、`--yuanbao-api-domain`、`--yuanbao-route-env` CLI 参数
- [x] 5.3 更新 `parseArgs()` 函数：新增元宝参数的解析分支，移除 `forceLogin` 选项
- [x] 5.4 更新 `main()` 函数：将 CLI 参数映射到 `config.yuanbao` 字段，校验 `appId` 和 `appSecret` 非空，否则打印错误并退出
- [x] 5.5 更新 `daemonize()` 函数：将 `YUANBAO_ACP_DAEMON` 环境变量改为 `YUANBAO_ACP_DAEMON`
- [x] 5.6 更新 `loadConfigFile()` 函数：支持读取配置文件中的 `yuanbao` 字段并合并到 `config.yuanbao`
- [x] 5.7 更新 `usage()` 帮助文本，替换所有微信相关描述为元宝相关描述

## 6. 更新公共 API 导出

- [x] 6.1 修改 `src/index.ts`：将导出的 `YuanBaoAcpBridge` 替换为 `YuanbaoAcpBridge`，将 `YuanBaoAcpConfig` 替换为 `YuanbaoAcpConfig`（可同时保留旧名称作为别名）
- [x] 6.2 移除 `src/index.ts` 中对已删除函数的导出（如 `login` 相关工具）

## 7. 清理微信代码

- [x] 7.1 删除 `src/weixin/` 目录下所有文件（`api.ts`、`auth.ts`、`monitor.ts`、`send.ts`、`types.ts`）
- [x] 7.2 检查并清理 `tsconfig.json` 中如有微信相关路径引用

## 8. 更新测试

- [x] 8.1 删除或重写 `tests/send.test.ts`：原测试针对 `sendTextMessage`（微信），改为测试 `yuanbaoMessageToPrompt` 适配函数或 `YuanbaoAcpBridge` 的消息处理逻辑
- [x] 8.2 检查并删除或重写 `tests/client.test.ts` 中与微信通道耦合的测试
- [x] 8.3 增加测试：覆盖群聊误触发抑制、`@bot` 触发、指令状态切换与会话重置

## 9. 更新项目元数据

- [x] 9.1 更新 `package.json` 的 `description` 为 Yuanbao 场景描述
- [x] 9.2 更新 `package.json` 的 `keywords`，移除 `yuanbao`，加入 `yuanbao`、`tencent`

## 10. 验证

- [x] 10.1 运行 `npm run build`，确保 TypeScript 编译无错误
- [x] 10.2 运行 `npm test`，确保测试通过
- [x] 10.3 手动验证：设置 `YUANBAO_APP_ID` 和 `YUANBAO_APP_SECRET`，运行 `yuanbao-acp --agent claude` 确认桥接器能正常连接元宝并收发消息
- [x] 10.4 确认 `tsconfig.json` 的 `lib` 配置可正确解析 `fetch`、`AbortController`、`TextEncoder`/`TextDecoder` 类型
