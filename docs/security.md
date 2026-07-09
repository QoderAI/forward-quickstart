# 安全说明

本文介绍使用 Forward Quickstart 以及基于本示例改造生产集成时的安全建议。

## Token 使用

Forward API 使用 Personal Access Token（PAT）进行认证。PAT 应当被视为密钥。

- 不要将 PAT 提交到代码仓库。
- 不要在前端代码中硬编码 PAT。
- 不要在截图、录屏、问题反馈、日志或共享文档中包含 PAT。
- 开发、测试和生产环境建议使用不同 token。
- 定期轮换 token；如果 token 可能已经暴露，应及时撤销。

## 本地配置

本示例可以从 `.env` 中读取可选的 API 地址覆盖配置。

建议：

- `.env` 只保存在本地。
- `.env.example` 只用于非密钥配置示例。
- 真实 PAT 应保存在安全的密钥管理系统或本地环境变量中。
- 发布 fork 或共享项目副本前，检查本地文件中是否包含密钥。

## 日志记录

日志有助于本地调试，但也可能意外记录敏感业务数据。

避免记录：

- PAT 或 Bearer token。
- 用户消息或私有对话内容。
- System prompt 或专有指令。
- 环境变量值。
- Vault 凭据值。
- 文件正文或下载链接。

推荐记录：

- Request ID。
- HTTP 状态码。
- API 路径或资源类型。
- 请求耗时。
- 数量或摘要信息，而不是完整请求体。

## 生产集成

Forward Quickstart 是示例应用。生产环境中，建议使用你自己的后端作为可信集成层。

常见生产模式：

```text
浏览器或应用客户端
  -> 你的后端
  -> Forward API / Cloud API
```

你的后端可以负责：

- 用户认证。
- 租户和 Identity 映射。
- 权限校验。
- 限流。
- 审计日志。
- 密钥存储。
- 错误处理和重试策略。

## Template 与资源安全

- 长期凭据优先使用 Vault。
- 避免将密钥直接写入 Template 的 `environment_variables`。
- Template 指令中不要包含私钥、token 或非公开凭据。
- 只挂载目标用户有权限访问的文件和技能。
- 从开发环境迁移到生产环境前，应检查相关资源配置。

## 发布前检查

发布或共享本示例的修改版本前，可以执行：

```bash
git status --short
git ls-files server/logs .env .DS_Store
rg -n --hidden --glob '!node_modules/**' --glob '!client/dist/**' --glob '!server/dist/**' --glob '!server/logs/**' --glob '!.git/**' \
  '(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{30,}|-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{20,})' .
```

期望结果：

- `.env`、`.DS_Store` 和本地日志文件没有被跟踪。
- 密钥扫描没有返回真实凭据。
- 本地调试日志不会包含在共享版本中。
