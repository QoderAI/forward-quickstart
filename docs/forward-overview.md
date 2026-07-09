# Forward 概览

Forward 是 Qoder Cloud Agents 面向应用集成场景的交付模式。它通过 Template、Identity、Session、Schedule、Channel、Resource 等业务对象，把云端 Agent 能力开放给应用使用。

Forward Quickstart 是一个示例应用，用于展示 Forward API 的主要使用流程。

## Forward 提供什么能力

Qoder Cloud Agents 可以在托管云环境中运行 AI Agent。Forward 在此基础上提供应用集成层，适合需要向多个终端用户提供 Agent 能力的应用。

通过 Forward，应用可以：

- 通过 Template 定义可复用的 Agent 行为。
- 将应用用户映射为 Forward Identity。
- 为对话或任务执行启动隔离的 Session。
- 接入文件、技能、环境、凭据库和记忆资源。
- 实时接收 Agent 执行进度和结果。
- 通过定时任务和外部渠道扩展集成方式。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| Template | 可复用的 Agent 配置，包括模型、指令、工具、技能、文件、环境和凭据库引用。 |
| Identity | 终端用户或应用侧主体，用于隔离 Session 和配置。 |
| Session | 基于一个 Identity 和一个 Template 创建的一次对话或任务执行。 |
| Event | Session 中产生的输入、输出、状态和工具调用记录。 |
| Resource | 可提供给 Agent 使用的可复用资源，例如 Skill、File、Environment、Vault 或 Memory Store。 |
| Schedule | 用于手动或定时运行 Template 的触发配置。 |
| Channel | 与 Forward 流程连接的外部消息渠道或应用渠道。 |

## CN 与 Global 环境

Forward Quickstart 支持两个生产环境。两者 API 模型一致，但账号和资源相互独立。

| 维度 | `cn-prod` | `global-prod` |
| --- | --- | --- |
| Forward API | `https://api.qoder.com.cn/api/v1/forward` | `https://api.qoder.com/api/v1/forward` |
| Cloud API | `https://api.qoder.com.cn/api/v1/cloud` | `https://api.qoder.com/api/v1/cloud` |
| 账号 | Qoder 中国站账号 | Qoder Global 账号 |
| 资源 | 中国站的 Template、Identity、Session、Environment、Skill、File、Vault 等资源 | Global 站的 Template、Identity、Session、Environment、Skill、File、Vault 等资源 |
| 模型与配额 | 由所选 Qoder 中国站账号决定 | 由所选 Qoder Global 账号决定 |

请选择与你的 Qoder 账号和资源位置匹配的环境。CN 与 Global 环境之间不能复用资源 ID。

## Forward Mode 特性

Forward Mode 侧重于让应用更容易嵌入 Agent 能力。

| 特性 | 说明 |
| --- | --- |
| 基于 Template 的配置 | 一次定义可复用的 Agent 行为，并在多个 Session 中使用。 |
| 终端用户隔离 | 使用 Identity 按用户或应用侧主体隔离 Session 和配置。 |
| Session 生命周期 | 创建、查看、归档和取消单次任务或对话。 |
| 实时事件流 | 通过 SSE 接收状态变化、消息、工具调用和工具结果。 |
| Resource Registry | 注册可复用的 Cloud 资源，供 Forward Template 和 Session 使用。 |
| Schedule 与 Channel | 将 Agent 执行扩展到定时任务和外部通信渠道。 |

Forward Quickstart 主要展示 Identity、Template、Resource Registry、Session 和 SSE 事件流。

## Forward Quickstart 覆盖的能力

Forward Quickstart 覆盖了 Forward Mode 的主链路，也包含部分配套 Cloud 资源管理能力。

| 模块 | 已包含能力 |
| --- | --- |
| 登录与环境选择 | 选择 `cn-prod` 或 `global-prod`，输入对应环境的 PAT 和应用侧 `external_id`。 |
| Identity | 按 `external_id` 查询或创建 Identity，并基于当前 Identity 查询相关会话、任务和渠道。 |
| Template | 查询 Template 列表，创建 Template，查看模板中的模型、系统指令、工具、MCP、技能、文件、环境、凭据库和环境变量配置。 |
| Effective Config | 查询 Identity + Template 合成后的生效配置，用于查看关联的系统资源，例如 Memory Store。 |
| Resource Registry | 查询、注册和删除 Forward Resource，覆盖 Skill、File、Environment、Vault、Memory Store 等类型。 |
| Cloud Models | 查询当前账号可用模型，并在创建 Template 时选择模型。 |
| Cloud Environments | 创建、查询、查看、更新、归档和删除云端运行环境，并可注册到 Forward。 |
| Cloud Skills | 上传 `.zip` 技能包，查询、查看、更新和删除技能，并可注册到 Forward。 |
| Cloud Files | 上传文件，查询、查看、获取下载地址和删除文件，并可注册到 Forward。 |
| Cloud Vaults | 创建、查询、查看、归档和删除凭据库，并可注册到 Forward。 |
| Vault Credentials | 在 Vault 中查询、创建和删除凭据，支持 Bearer Token、OAuth Token 和环境变量类型。 |
| Sessions | 创建 Session，发送用户消息，查询历史 Session，查询事件历史，归档 Session，取消当前 Turn。 |
| SSE Events | 实时接收 Agent 消息、状态变化、思考内容、工具调用、工具结果和增量流式文本。 |
| Schedules | 查询、创建、编辑、暂停、恢复、归档和手动执行 Schedule，并查询 Schedule Run。 |
| Channels | 创建、查询、更新和删除 IM 渠道，支持微信、企业微信、钉钉、飞书；支持扫码绑定和手动凭据配置。 |
| Memory | 基于 Template 生效配置读取 Memory Store，查询记忆条目并展示内容。 |
| Usage | 基于 Session 列表展示会话数量、执行状态和时长统计。 |

其中 Identity、Template、Resource Registry、Session、Event、Schedule、Channel 属于 Forward API 主体能力；Model、Environment、Skill、File、Vault、Memory Store 等资源来自 Cloud API，并可通过 Forward Resource Registry 引入 Forward 工作流。

## Forward Mode 与 Build Mode

Forward Mode 和 Build Mode 是使用 Qoder Cloud Agents 的两种互补方式。

| 维度 | Forward Mode | Build Mode |
| --- | --- | --- |
| 主要目标 | 将 Agent 能力嵌入业务应用和终端用户流程。 | 直接构建和管理底层 Agent 运行资源。 |
| 主要对象 | Template、Identity、Session、Schedule、Channel、Resource Registry。 | Agent、Environment、Session、File、Vault、Skill、Memory Store、Model。 |
| 配置方式 | 围绕 Template 和 Identity 进行分层配置。 | 直接配置 Agent、Environment、Session 和资源。 |
| 典型使用者 | 将 Agent 集成到产品或业务流程中的应用开发者。 | 构建 Agent 运行能力的开发者或平台工程师。 |
| 适合场景 | 多用户应用、SaaS 集成、渠道机器人、定时任务、可复用助手。 | Agent 开发、底层资源编排、平台实验、自定义运行时控制。 |

简单来说：

- 当应用需要通过稳定的业务对象向用户提供 Agent 能力时，适合使用 **Forward Mode**。
- 当你需要直接控制底层 Agent 和运行资源时，适合使用 **Build Mode**。

## 推荐体验路径

1. 选择 `cn-prod` 或 `global-prod`。
2. 输入所选环境对应的 PAT。
3. 输入应用侧 `external_id`。
4. 创建或选择 Template。
5. 注册或选择文件、技能、环境、凭据库等资源。
6. 创建 Session 并发送消息。
7. 查看 SSE 事件流中的 Agent 消息、状态变化和工具调用。
8. 查看 Session 历史和事件历史。
9. 创建 Schedule，体验手动执行、暂停和恢复。
10. 创建 IM Channel，体验扫码绑定或手动凭据配置。
11. 查看 Template 关联的个人记忆内容。

## 集成建议

- Forward Quickstart 是示例应用，不是生产鉴权网关。
- 不要将 PAT 或其他密钥放入前端源码或公开仓库。
- 生产环境中，建议通过自己的后端转发浏览器请求，由后端处理认证、授权、租户映射、限流和审计日志。
- 长期凭据建议使用 Vault，不建议直接写入 Template 的明文环境变量。
- 可用模型、工具、资源和配额取决于所选 Qoder 账号。

## 参考资料

- [Qoder Cloud Agents Overview](https://docs.qoder.com/cloud-agents/overview)
- [Forward Mode Overview](https://docs.qoder.com/cloud-agents/api/forward/overview)
- [Authentication](https://docs.qoder.com/cloud-agents/api/conventions/authentication)
