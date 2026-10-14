# QCA SDK 接入说明

Quickstart 在 Node 服务端使用固定版本 `qca-sdk@0.5.0`。浏览器的请求信封、SSE 和语音连接仍访问 Quickstart；本地 Express 与 Vercel 入口复用同一个实现。项目的 Node 要求高于 SDK 的 20.12 最低要求。

## 调用位置

| 位置 | 职责 |
| --- | --- |
| `server/src/qca/clients.ts` | 为每次请求、每条连接创建独立 client，显式传递环境与 PAT/SAT |
| `server/src/qca/dispatch.ts` | 将本地请求映射到 SDK 资源方法，保留业务 payload 和原始响应 |
| `server/src/qca/extensions.ts` | SDK 暂未提供资源方法的显式兼容清单 |
| `server/src/qca/http.ts` | HTTP 状态、错误、request ID、期限与断开取消 |
| `server/src/qca/transfers.ts` | multipart、文件元数据和二进制预览 |
| `server/src/qca/stream.ts` | SSE 原始字节转发、背压与会话结束判断 |
| `server/src/voiceProxy.ts` | 本地 WebSocketServer；用 SDK connect/sendEvent/事件迭代访问 QCA |

例如，Forward Session 创建对应以下 SDK 调用：

```ts
import { ForwardClient } from 'qca-sdk';

const client = new ForwardClient({
  baseURL: 'https://api.qoder.com.cn/api/v1/forward',
  authMode: 'sa',
  accessToken: forwardSAT,
  timeout: 30_000,
  maxRetries: 0,
});
const response = await client.sessions.create(
  { identity_id: identityId, template_id: templateId, incremental_streaming_enabled: true },
  { idempotencyKey, signal },
).asResponse();
```

代码中的 token、资源 ID、幂等键和 signal 来自当前请求。PAT 使用 `{ authMode: 'pat', pat }`；CN/Global 地址继续由已有环境配置控制。SDK 自动重试关闭，写操作继续使用浏览器生成的幂等键，避免迁移改变重复发送行为。SDK 的 `.asResponse()` 保留 HTTP 状态与 wire DTO，包括 204、专用 Realtime 历史页和扩展字段。

## 鉴权

SA 登录使用 `forward.serviceAccountTokens.create({ saKey, ... })`，返回完整 Forward SAT 签发信息。SA Key 只作为签发方法的当次参数；后续请求使用签发得到的 SAT。现有 Identity SAT 签发分支也已映射到 SDK。页面没有新增吊销功能。

SDK `ServiceAccountCredential` 的平台交换链路与此不同。Realtime 需要 Forward 签发的绑定 SAT，因此本项目继续保留 Forward 登录方式。静态 SAT 过期后需要重新登录。

JSON、上传、预览、SSE 及 `proxy.auth` 都会传递 `authMode`；旧页面未传此字段时保留 PAT 兼容默认。SDK client 不跨用户共享；不默认读取进程凭据来执行普通业务请求。历史文件的 Cloud 回退仍由客户端按现有 PAT/404 条件触发。

## 兼容扩展

当前页面需要两类 SDK `request()` 适配：

- `GET /resources`：保留注册资源列表语义。
- Forward/Cloud `GET /files/{id}/content`：仅返回签名 URL；`files.download()` 用于需要文件字节的预览，SDK 不会向存储请求附带 API token。

为保持旧导出函数可调用，显式保留 8 个兼容操作：Identity access_tokens 的查询/创建/删除，Resource 注册/删除，Vault 更新/归档，Schedule DELETE。页面没有使用这些功能；保留传输不表示目标服务已经实现它们。未知接口返回明确的 404，不做任意路径转发。

## 语音、文件和用量

语音 Conversation 创建和历史查询使用 SDK 原生方法。创建时幂等键进入 header；历史页保留 `conversation/events/page`，多页恢复仍由浏览器负责。

上游语音连接使用 `forward.realtime.connect()`，仅支持 Node。浏览器负责录音重采样、播放、断线恢复和结束确认。代理只有一个 SDK 事件消费者，转发完整事件及原关闭 request_id；不会再次发起 closeGracefully 或自动重放输入。SDK 在 ready 后才返回连接，初始化阶段的事件随后按顺序送达浏览器。若迭代结束且未收到对应关闭确认，代理请求浏览器恢复连接，覆盖服务端正常关闭 transport 的重启场景。

SDK 校验事件、序号和音频格式；旧的简化 mock 报文不可用。初始化有总计 30 秒期限，浏览器断开会取消上游，部署的 280 秒连接轮换保留。SDK 内部队列有界，下游也保留缓冲限制。SDK 不改变 Vercel 的部署条件，仍需按 README 配置并在目标环境验收。

Skill 使用推荐的 `files` multipart 字段，名称和描述来自 ZIP 内的 SKILL.md。普通文件保留文件名、MIME、purpose 和对象 metadata。SSE 直接转发原始字节；子线程 idle 不关闭主会话流。

部分 Agent 产物的 Forward 元数据返回 404，但其内容接口允许下载。产物卡片在此情形下继续尝试经过鉴权的内容预览；若存储只返回 `application/octet-stream`，通过 PNG/JPEG/GIF/WebP/BMP/AVIF 文件头识别图片。未知格式仍显示下载卡片，元数据 401/403 不触发此降级。

Usage 的时间参数改为 Asia/Shanghai 整点 `start_at/end_at`，左闭右开，最大 744 小时；页面明确显示统计截止时间。时长使用 `active_seconds`，保留小数和缺失 credits。汇总读取全部分页，账本翻页复用同一时间窗口并使用 `created_at[lt]` 上界。账本按 Session 创建时间筛选，与跨窗口执行的小时聚合不保证精确对账。

平均每会话使用官方汇总的 credits/session_count；明细是否全部加载使用 Session 分页的 has_more，不以汇总会话数作为明细总数。每日趋势与明细小计来自已加载的会话累计消耗。

## 验证

在仓库根目录执行：

```bash
npm run test --workspace=client
npm run test --workspace=server
npm run build --workspace=client
npm run build --workspace=server
npm run test:deployment
```

测试使用真实 SDK、注入 fetch 和本地 HTTP/WebSocket 上游，不需要真实 token，不访问 QCA。覆盖请求隔离、签发、错误码、上传/预览、SSE、语音生命周期和 Usage。部署测试比较本地构建与真实 Vercel API 导出在本地适配器中的行为，不模拟 Vercel 基础设施。

真实服务的验证范围见下方记录；Global、PAT 和 Vercel 在线部署仍需要单独验收。


### 本次验证记录（2026-10-14）

- 客户端：214 项测试通过；服务端：32 项通过；本地/Vercel 入口对照：6 项通过，共 252 项。
- client/server 构建通过；Usage/文件相关测试另外在 TZ=UTC 下通过。
- `git diff --check` 通过。
- 全量前端 lint 仍有 4 个错误、2 个警告，均来自改造前已有的 App/batchPanel 规则问题；已对照远程 main 基线，本次修改未增加 lint 问题。
- npm audit 仍报告已有依赖的漏洞；涉及包版本与 main 一致，新增 qca-sdk 和升级的 ws 未出现在本次审计问题清单中。未在本次迁移中扩大依赖升级范围。
- 中国站 Service Account 已完成主要功能真实联调，包括用户实际说话并听到语音回复。图片预览和用量展示问题已修复并在真实页面复测。
- Schedule 管理与执行接口成功，但两次运行均未按初始消息返回指定文本，根因尚未确定。此项不能标为完整通过。
- 详细范围、证据、保留的测试资源与未测项见 [SDK 迁移测试记录](qca-sdk-test-report.md)。
