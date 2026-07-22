# Forward Quickstart

Forward Quickstart 是一个用于体验 Qoder Cloud Agents Forward API 的示例 Web 应用。它展示了如何创建终端用户身份、配置 Agent 模板、启动会话、发送消息，并通过 SSE 接收实时 Agent 事件。

你可以先通过本项目理解 Forward API 的主流程，再将相关能力集成到自己的应用中。

## 展示能力

- **身份管理**：基于应用侧的 `external_id` 查找或创建 Forward Identity。
- **模板配置**：创建和查看可复用的 Agent Template，包括模型、工具、技能、文件、环境和凭据库等配置。
- **资源管理**：上传或创建 Skill、File、Environment、Vault 等 Cloud 资源，并注册为 Forward Resource。
- **凭据管理**：在 Vault 中创建和删除凭据，支持 Bearer Token、OAuth Token 和环境变量类型。
- **会话执行**：基于 Identity 和 Template 创建 Session，发送 `user.message`，并支持取消当前 Turn；已有任务执行时仍可点击「新建对话」另起新会话，后台任务继续执行且不会干扰当前视图。提问时可点击发送按钮旁的回形针图标添加本地文本类文件（单个 ≤5MB）作为对话附件——文件上传后挂载到 Agent 工作目录（新会话随创建挂载，进行中的会话动态追加挂载），消息中自动标注挂载路径，Agent 可直接读取附件内容作答；附件在消息气泡中以文件卡片展示，刷新后依然可见。
- **实时事件**：通过 SSE 接收 Agent 状态、消息、思考过程、工具调用和工具结果，支持打字机流式输出并实时渲染 Markdown；流式过程中不完整的表格/标题片段也能安全渲染，Session 运行失败（如模型过载）会在对话中显示错误提示；消息按服务端时间戳排序展示，多轮追问时新提问始终显示在对话最底部。发送按钮旁的设置图标可开关「显示思考过程 / 显示工具调用过程」（选择持久化到本地）；点击历史会话加载事件时显示加载动画，不会闪现欢迎页；历史会话列表支持置顶——悬浮某条记录时显示图钉图标，点击后该会话固定到列表顶部的「置顶」分组（再次点击取消置顶，置顶状态持久化到本地）。
- **模板快速切换**：在对话列表顶部直接切换当前会话使用的 Template，无需离开对话界面。
- **权限模式**：内置「开发者模式 / 用户模式」开关（默认用户模式，选择持久化到本地）。开发者模式解锁模板及模板资源（技能、文件、环境、凭据）的新建、编辑和删除权限，并显示对应的「模板资源」菜单；用户模式仅能查看和使用模板。切换到开发者模式时会弹出风险确认提示。
- **会话历史与用量**：查看历史 Session、事件历史、执行状态和会话时长统计。
- **定时任务**：创建、编辑、暂停、恢复、归档和手动执行 Schedule。
- **IM 渠道**：创建和管理微信、企业微信、钉钉、飞书渠道，支持扫码绑定或手动凭据配置。
- **个人记忆查看**：基于 Template 生效配置读取关联 Memory Store，并查看记忆条目内容。

## 文档

- [Forward 概览](./docs/forward-overview.md)：介绍产品概念、CN/Global API 环境、Forward Mode 特性，以及 Forward Mode 与 Build Mode 的区别。
- [安全说明](./docs/security.md)：介绍 token 使用、日志记录和生产集成相关建议。

官方文档：

- [Qoder Cloud Agents Overview](https://docs.qoder.com/cloud-agents/overview)
- [Forward Mode Overview](https://docs.qoder.com/cloud-agents/api/forward/overview)
- [Authentication](https://docs.qoder.com/cloud-agents/api/conventions/authentication)

## 项目结构

```text
client/   React + Vite + TailwindCSS 前端
server/   本地 Express 代理，用于 API 转发和 SSE 流代理
docs/     公开产品说明与安全说明
```

## 环境要求

- Git：用于克隆本仓库。
- Node.js：`^20.19.0` 或 `>=22.12.0`。推荐使用 Node.js 22.12 或更高版本。
- npm：随 Node.js 一起安装，建议 `>= 10`。

本项目使用 npm workspaces 同时启动前端和本地代理，请在仓库根目录执行安装和启动命令。

可以先在本地检查版本：

```bash
git --version
node -v
npm -v
```

如果没有安装 Node.js，建议先通过 [Node.js 官网](https://nodejs.org/)安装 LTS 版本，或使用 `nvm` 管理 Node 版本。

如果没有安装 Git，可以通过 [Git 官网](https://git-scm.com/downloads)安装，或在 macOS 上执行 `xcode-select --install` 安装 Command Line Tools。

## API 环境

本示例支持两个生产 API 环境：

| 环境 | Forward API | Cloud API | 适用情况 |
| --- | --- | --- | --- |
| `cn-prod` | `https://api.qoder.com.cn/api/v1/forward` | `https://api.qoder.com.cn/api/v1/cloud` | 使用 Qoder 中国站账号和中国站资源。 |
| `global-prod` | `https://api.qoder.com/api/v1/forward` | `https://api.qoder.com/api/v1/cloud` | 使用 Qoder Global 账号和 Global 站资源。 |

资源与环境绑定。不要在 CN 和 Global 环境之间混用 PAT、Template ID、Identity ID、Environment ID 或其他资源 ID。

## 配置

应用会在登录页面要求输入 PAT 和 API 环境。如果需要覆盖默认 API 地址，也可以复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

不要将 PAT 或其他密钥提交到代码仓库。

## 本地启动

首次获取项目：

```bash
git clone https://github.com/QoderAI/forward-quickstart.git
cd forward-quickstart
```

安装依赖并启动：

```bash
npm install
npm run dev
```

默认本地地址：

- 前端：`http://localhost:5173`
- 本地代理：`http://localhost:3001`

启动成功后，终端会同时显示前端 Vite 服务和 Express 本地代理的日志。打开前端地址后，在登录页面选择 API 环境并输入对应的 Forward PAT 即可开始体验。

如果端口被占用，可以先停止占用 `5173` 或 `3001` 的本地进程，再重新执行 `npm run dev`。

## Vercel 部署

本仓库同时支持本地运行和 Vercel 部署：

- 本地运行继续使用 `npm run dev`，Vite 会将 `/api` 请求代理到本地 Express 服务。
- Vercel 会构建 `client/dist` 并将现有 Express API 作为 Serverless Functions 部署；前端和 API 使用同一域名。

建议先 Fork 本仓库到自己的 GitHub 账号，再在 Vercel 导入 Fork 后的仓库。Vercel 检测到根目录的 `vercel.json` 后会自动使用正确的构建命令和 API 函数配置。

也可以使用 Vercel CLI 部署：

```bash
npm install
npx vercel link
npx vercel
npx vercel --prod
```

- `npx vercel` 创建 Preview 部署，用于测试。
- `npx vercel --prod` 发布到正式域名。
- 连接 GitHub 后，推送到配置的生产分支会自动触发 Vercel 部署。

默认的 CN / Global API 地址已经内置，不需要在 Vercel 保存 PAT。若需要覆盖 API 地址，可在 Vercel Project Settings 的 Environment Variables 中配置：

```text
CN_PROD_FORWARD_API_BASE_URL
GLOBAL_PROD_FORWARD_API_BASE_URL
CN_PROD_CLOUD_API_BASE_URL
GLOBAL_PROD_CLOUD_API_BASE_URL
```

不要将 PAT、Vault 凭据或其他密钥提交到 Git 仓库或写入 Vercel 的公开前端变量。

## 体验流程

1. 打开前端页面。
2. 选择 `cn-prod` 或 `global-prod`。
3. 输入所选环境对应的 Forward PAT。
4. 输入应用侧用户标识，例如 `user-001`。
5. 创建或选择一个 Template。
6. 上传或注册需要的资源，例如文件、技能、环境或凭据库。
7. 创建 Session 并发送消息。
8. 查看实时 SSE 事件流。
9. 按需体验定时任务、IM 渠道和个人记忆等扩展能力。

## 核心流程

```text
PAT + external_id
  -> 查找或创建 Identity
  -> 选择或创建 Template
  -> 创建 Session
  -> 发送 user.message
  -> 订阅 /sessions/{session_id}/events/stream
  -> 接收 status、message、tool_use、tool_result 等事件
```

## 覆盖的 API

### Forward API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/identities` | 创建 Identity |
| GET | `/identities` | 查询或查找 Identity |
| POST | `/identities/{id}/access_tokens` | 创建 Identity 访问令牌 |
| GET | `/templates` | 查询 Template 列表 |
| POST | `/templates` | 创建 Template |
| GET | `/identities/{id}/templates/{template_id}/effective` | 查看生效后的运行配置 |
| POST | `/resources/registry` | 注册 Resource |
| GET | `/resources` | 查询已注册 Resource |
| POST | `/sessions` | 创建 Session |
| GET | `/sessions` | 查询 Session 列表 |
| GET | `/sessions/{id}` | 查询 Session 详情 |
| POST | `/sessions/{id}/events` | 发送 Session 事件 |
| GET | `/sessions/{id}/events` | 查询 Session 事件历史 |
| GET | `/sessions/{id}/events/stream` | 订阅 Session 事件流 |
| POST | `/sessions/{id}/archive` | 归档 Session |
| POST | `/sessions/{id}/cancel` | 取消当前 Turn |
| GET | `/schedules` | 查询 Schedule 列表 |
| POST | `/schedules` | 创建 Schedule |
| GET | `/schedules/{id}` | 查询 Schedule 详情 |
| POST | `/schedules/{id}` | 更新 Schedule |
| POST | `/schedules/{id}/archive` | 归档 Schedule |
| POST | `/schedules/{id}/run` | 手动执行 Schedule |
| POST | `/schedules/{id}/pause` | 暂停 Schedule |
| POST | `/schedules/{id}/unpause` | 恢复 Schedule |
| GET | `/schedule_runs` | 查询 Schedule Run 列表 |
| GET | `/schedule_runs/{id}` | 查询 Schedule Run 详情 |
| GET | `/channels` | 查询 Channel 列表 |
| POST | `/channels` | 创建 Channel |
| GET | `/channels/{id}` | 查询 Channel 详情 |
| POST | `/channels/{id}` | 更新 Channel |
| DELETE | `/channels/{id}` | 删除 Channel |
| POST | `/channels/{id}/qr_sessions` | 创建渠道扫码绑定会话 |
| GET | `/qr_sessions/{session_key}` | 查询扫码绑定状态 |

### Cloud API

本示例也会调用 Cloud API 中的资源接口，配合 Forward Template 和 Resource Registry 使用。

| 资源 | 能力 |
| --- | --- |
| Models | 查询当前账号可用模型，用于创建 Template。 |
| Environments | 查询、创建、查看、更新、归档和删除云端运行环境。 |
| Skills | 查询、上传、查看、更新和删除技能包。 |
| Files | 查询、上传、查看、获取下载地址和删除文件。 |
| Vaults | 查询、创建、查看、归档和删除凭据库。 |
| Vault Credentials | 查询、创建和删除凭据，支持 Bearer Token、OAuth Token 和环境变量类型。 |
| Memory Stores | 读取 Template 生效配置中的 Memory Store，并查询记忆条目和内容。 |
