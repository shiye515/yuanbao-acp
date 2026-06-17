# yuanbao-config Specification

## Purpose
TBD - created by archiving change switch-yuanbao-to-yuanbao-bot. Update Purpose after archive.
## Requirements
### Requirement: 必需配置项
`YuanbaoAcpConfig` SHALL 包含 `yuanbao.appId`（元宝 App Key）和 `yuanbao.appSecret` 两个必需字段。桥接器启动时 SHALL 校验这两个字段非空，否则拒绝启动并输出明确错误信息。

#### Scenario: 缺少 appId 或 appSecret
- **WHEN** 桥接器启动时 `appId` 或 `appSecret` 为空字符串
- **THEN** 系统打印错误 `Error: --yuanbao-app-id and --yuanbao-app-secret are required` 并以非零状态退出

### Requirement: 非通道配置保持兼容
`YuanbaoAcpConfig` SHALL 保持现有 ACP 运行配置结构兼容，包括 `agent`、`agents`、`session`、`daemon`、`storage`、`commandAliases` 字段。迁移到元宝通道时 SHALL 仅替换 `yuanbao` 为 `yuanbao`。

#### Scenario: 从微信配置迁移
- **WHEN** 用户将原配置中的 `yuanbao` 字段替换为 `yuanbao`
- **THEN** 其余 ACP 运行相关字段保持原语义并继续生效

### Requirement: 可选配置项
`YuanbaoAcpConfig` SHALL 支持以下可选字段，均有默认值：
- `botId`：Bot ID，默认由 Sign Token API 自动返回
- `wsUrl`：WebSocket 网关地址，默认 `wss://bot-wss.yuanbao.tencent.com/wss/connection`
- `apiDomain`：API 域名，默认 `https://bot.yuanbao.tencent.com`
- `routeEnv`：路由环境（用于测试环境），默认为空

#### Scenario: 使用默认配置
- **WHEN** 用户只提供 `appId` 和 `appSecret`，其余字段未设置
- **THEN** 系统使用内置默认值建立连接，无需额外配置

### Requirement: 环境变量配置
系统 SHALL 支持通过以下环境变量配置元宝 Bot：`YUANBAO_APP_ID`、`YUANBAO_APP_SECRET`、`YUANBAO_BOT_ID`、`YUANBAO_WS_URL`、`YUANBAO_API_DOMAIN`、`YUANBAO_ROUTE_ENV`。所有本项目新增环境变量 SHALL 使用 `YUANBAO_` 前缀（例如 `YUANBAO_ACP_DAEMON`）。

#### Scenario: 通过环境变量启动
- **WHEN** 用户设置 `YUANBAO_APP_ID` 和 `YUANBAO_APP_SECRET` 环境变量后运行桥接器
- **THEN** 桥接器读取环境变量作为配置，无需传递 CLI 参数

### Requirement: CLI 参数配置
系统 SHALL 支持通过 CLI 参数覆盖配置：`--yuanbao-app-id`、`--yuanbao-app-secret`、`--yuanbao-bot-id`、`--yuanbao-ws-url`、`--yuanbao-api-domain`、`--yuanbao-route-env`。CLI 参数优先级 SHALL 高于环境变量。

#### Scenario: CLI 参数覆盖环境变量
- **WHEN** 同时设置了 `YUANBAO_APP_ID` 环境变量和 `--yuanbao-app-id` CLI 参数
- **THEN** 系统使用 CLI 参数的值

### Requirement: 配置文件支持
系统 SHALL 支持通过 `--config <file>` 指定 JSON 配置文件，文件中的 `yuanbao` 字段 SHALL 被合并到配置中。配置文件中的值优先级低于 CLI 参数但高于默认值。

#### Scenario: 通过配置文件指定 appId
- **WHEN** 配置文件包含 `{ "yuanbao": { "appId": "xxx", "appSecret": "yyy" } }`
- **THEN** 桥接器使用文件中的值建立元宝连接

#### Scenario: 配置文件 + CLI 参数
- **WHEN** 配置文件指定了 `appId`，CLI 同时传入 `--yuanbao-app-id`
- **THEN** 系统使用 CLI 参数的值（CLI 优先级更高）

