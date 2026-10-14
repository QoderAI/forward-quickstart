# SDK 迁移测试记录

日期：2026-10-14（北京时间）。分支：`codex/qca-sdk-migration`，从 `origin/main` 的 `dc392a43b9fe5259cfa2c684338ebe97e2efceae` 开始实施。依赖固定为 `qca-sdk@0.5.0`。

## 结论

中国站 Service Account 下的主要交互链路已真实验证。测试期间修复了 Agent 产物图片预览和用量页统计口径混用问题，均已在真实页面复测。Schedule 创建、编辑、运行、暂停接口成功，但运行结果未遵循测试初始消息，保留为未解决项。不能将此次结果视为所有环境、权限组合及在线部署全面通过。

本地前端 `http://localhost:5173/`，服务端健康检查 `http://localhost:3001/api/health`。凭证由用户直接填写页面；测试报告不保存凭证。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| client Vitest | 214 项通过，17 个文件 |
| server Node test | 32 项通过 |
| 本地构建与 Vercel 导出入口对照 | 6 项通过；不代表 Vercel 在线基础设施验收 |
| client/server TypeScript 与构建 | 通过；Vite 仍提示产物大于 500 kB |
| Usage/文件相关测试，TZ=UTC | 此前 91 项通过 |
| git diff --check | 通过 |
| 前端 lint | 4 个错误、2 个警告；已对照 main，均为原有 App/batchPanel 问题 |

测试使用真实 SDK 和受控 HTTP/WebSocket 上游，覆盖鉴权隔离、错误状态及 request ID、幂等键、multipart、文件预览、SSE、语音连接生命周期和 Usage 分页。新增回归覆盖元数据 404 且内容可用、通用 MIME 的图片识别、401/403 不降级，并验证 Schedule 初始消息经 SDK 创建和更新后原样发送。

## 中国站 SA 真实验证

| 功能 | 实际操作及结果 |
| --- | --- |
| 登录与 Identity | SA Key 签发成功；Identity 查询/创建成功；刷新后复用 SAT 成功；过期 SAT 显示错误并可重新登录 |
| 模型与模板 | 模型列表成功；创建、读取、编辑测试模板并绑定资源成功 |
| 文本对话 | 创建会话、多轮发送、SSE、工具调用、Credit 显示、刷新恢复历史成功 |
| 文本附件 | 上传、挂载已有会话、Agent 读取并回复 SDK_ATTACHMENT_OK/42；下载内容与原文件一致 |
| 图片附件与产物 | 用户上传图片预览成功；Agent 生成 PNG 下载成功；修复后两类图片在页面均解码为 32×32 |
| Skill | 合法单目录 ZIP 上传和编辑成功；扁平 ZIP 返回明确校验错误；绑定模板后 Agent 执行并回复 SDK_SKILL_OK |
| 环境/Vault | 创建受限网络环境、创建 Vault、写入公开测试变量并绑定模板；Agent 读取 SDK_SMOKE_MARKER=public-test-value 成功 |
| 个人记忆 | 生效配置、资源列表和空记忆列表读取成功；未验证写入及召回 |
| 用量 | Identity/Template 汇总与 Session 明细成功；截至 11:00 显示 2.07 Credit、5 个汇总会话、1m 32s；明细有 6 条、小计 2.06 |
| 批量任务 | 创建 1 条输入，详情与任务状态加载成功，完成 1/1，回复 SDK_BATCH_OK_42；输出 JSONL 下载并校验成功 |
| Schedule | 创建、编辑、手动运行、查看运行与会话、暂停成功；初始消息执行结果异常，见下文 |
| IM 渠道 | 空列表和创建表单加载成功；未绑定真实平台或发送外部消息 |
| 语音 | Conversation 创建、SDK WebSocket ready、麦克风输入、字幕、音频回复成功；用户确认听到回复；静音、文字混输、结束确认及历史读取成功 |

语音文字混输测试发送“这是文字混输测试，请回答：语音文字测试通过。”，收到“语音文字测试通过。”；语音会话已结束。

## 发现的问题

### 已修复：元数据缺失导致产物图片无法预览

产物 `file_00scuix0e988wtzehvw4` 的元数据接口返回 404，内容下载成功，但 MIME 是 `application/octet-stream`，大小为 95 字节。旧卡片依赖元数据判断图片，因而只显示文件 ID。

现仅在元数据 404 时继续访问经过鉴权的预览接口，并对通用 MIME 的常见图片进行文件头识别。未知格式保留下载卡片。实际浏览器验证该 PNG 与上传的 PNG 均成功加载，尺寸都是 32×32。元数据缺失时文件名仍回退为 file ID。

### 已修复：汇总会话数被用作明细总数

真实接口返回汇总会话数 5、明细 6 条，其中包含语音会话。此前页面显示“已加载 6 / 共 5”，平均值又来自明细，造成口径混用。

现明细使用自己的 `has_more` 判断分页完成，显示“已加载 6 条（已全部加载）”；平均每会话使用官方汇总计算并显示 0.41。页面说明汇总按时段统计，明细按会话创建时间筛选并显示累计消耗。2.07 与 2.06 的服务端数据差异保留，不通过修改数据强行对齐。

### 未解决：Schedule 未遵循初始消息

测试 Schedule：`sched_8afaad71ef201694bb58fc53`。

1. 初始消息“请只回复 SDK_SCHEDULE_OK。”，运行回复“Ready. What would you like me to do?”。
2. 更新为“Integration test: return exactly SDK_SCHEDULE_OK_42. Do not use tools or ask questions.”，运行调用 Bash 后回复“SDK_OK”。

前端传入 `initial_events: [{ type: 'user.message', content: string }]`，SDK 请求保留该字段。官方 [Schedule 数据结构](https://docs.qoder.com/cloud-agents/api/forward/schedules/schemas) 和 [查询示例](https://docs.qoder.com/cloud-agents/api/forward/schedules/get) 使用字符串 content；没有依据将其改成其他结构。离线回归确认真实 SDK 创建/更新请求原样发送初始消息。尚不能确定异常来自服务端调度、模板上下文还是模型执行，需要继续服务端排查。

排查线索：

- 第一次 run request ID：`1963a3a8-8c6d-47f4-9a07-e49a42422f7a`；会话 `sess_00sctf6d5u8lcy5rksew`。
- 第二次 run request ID：`a00829bc-9d05-445c-bfed-9c1285dd8abd`；会话 `sess_00sctkukazxtsabfl7p0`。
- Schedule 已暂停，且触发类型为手动。

## 保留的测试资源与未测范围

测试身份：`ui-smoke-1787214097675`（`idn_02e9ea0bbbcf9b02b6aed978`）。以下资源保留用于复查：

| 资源 | ID |
| --- | --- |
| 模板 sdk-smoke-20261014 | tmpl_20928ab4e1c170bda76cf097 |
| Skill sdk-smoke-20261014 | skill_00sct7ngmpc74vntlkbb |
| 环境 sdk-smoke-env-20261014 | env_00scta8dgrgg0gfjg6su |
| Vault sdk-smoke-vault-20261014 | vault_00sctbkvjru2o24kbdni |
| 已完成 Batch | batch_db5261fsrbayr27hj5css12pxj |
| 资源集成会话 | sess_00scui2d9kqgw4z47t4s |
| 已结束语音 Conversation | conv_1781dddb3a7743e4bc67113275d87ce2 |

未实测：PAT、Global、Identity 限权组合、真实 IM 绑定和消息收发、记忆写入/召回、全部删除/归档及故障分支、Vercel 在线部署。跨环境与异常分支的离线回归不能替代这些真实验证。此次测试未永久删除资源，测试数据可供后续检查。
