# oh-my-im 开发文档

## 目标

`oh-my-im` 是一个单独运行的钉钉机器人到 Codex CLI 的桥接程序。它只保留“钉钉机器人 <-> Codex”这条链路，不复制多平台、Web 配置页、队列管理、卡片流式渲染、Claude/CodeBuddy/OpenCode 等能力。

成功标准：

- 启动后用钉钉 Stream Mode 接收机器人消息。
- 收到文本消息后调用本机 `codex exec --json`。
- Codex 输出通过钉钉 `sessionWebhook` 回复到原会话。
- 同一钉钉会话复用 Codex sessionId，`/new` 可清空会话。
- 无需数据库、Redis、Docker；只依赖 Node.js、钉钉开放平台凭证和本机 Codex CLI 登录态。

## 功能点

### 1. 配置加载

来源：环境变量或 `.env`。

必填：

- `DINGTALK_CLIENT_ID`：钉钉开放平台企业内部应用 AppKey / Client ID。
- `DINGTALK_CLIENT_SECRET`：钉钉 AppSecret / Client Secret。

可选：

- `CODEX_CLI_PATH`：Codex CLI 路径，默认 `codex`。
- `CODEX_WORK_DIR`：Codex 工作目录，默认当前目录。
- `CODEX_PROXY`：给 Codex 子进程注入 HTTP/HTTPS proxy。
- `ALLOWED_USER_IDS`：逗号分隔的钉钉用户 ID 白名单。为空表示不限制。
- `OPEN_IM_CLI_TIMEOUT_MS`：Codex 执行超时，默认 30 分钟。

### 2. 钉钉接入

- 使用 `dingtalk-stream` 的 `DWClient` 连接 Stream Mode。
- 注册 `TOPIC_ROBOT` 回调。
- 解析机器人消息中的：
  - `conversationId`
  - `sessionWebhook`
  - `senderStaffId` 或 `senderId`
  - `text.content`
- 回调处理结束后调用 `socketCallBackResponse` ack。

### 3. 消息处理

支持命令：

- `/help`：显示命令。
- `/status`：显示工作目录、Codex 路径、当前会话数。
- `/new`：清空当前钉钉会话绑定的 Codex session。

普通文本：

- 检查白名单。
- 同一会话同一时间只跑一个 Codex 任务。
- 先回复“Codex 正在处理...”。
- 执行 Codex 并在结束后回复结果。

非文本消息：

- 当前版本不下载图片/文件，只回复暂不支持。

### 4. Codex 调用

执行模型：

```text
codex exec --json --skip-git-repo-check --cd <workDir> -
codex exec resume --json --skip-git-repo-check <sessionId> -
```

输入：

- prompt 写入 stdin。

输出：

- 解析 JSONL。
- 从 `thread.started` / `session_meta` 读取 sessionId。
- 从 `agent_message` / `message` / `task_complete` 读取文本。
- 记录工具调用数量，但第一版只在日志中使用，不单独推送流式状态。

权限：

- 默认不传 `--dangerously-bypass-approvals-and-sandbox`。
- 若要自动放权，显式设置 `CODEX_PERMISSION_MODE=bypass`。

### 5. 回复策略

第一版只使用钉钉 `sessionWebhook` 发送纯文本，不做卡片。

原因：

- `sessionWebhook` 是机器人消息的直接回复路径，依赖最少。
- 钉钉卡片涉及模板 ID、机器人 code、会话类型、card instance 等分支，不适合作为独立版第一步。

限制：

- `sessionWebhook` 有有效期；只能回复最近收到过消息的会话。
- 主动发送到历史会话暂不支持。

## 模块划分

```text
src/config.ts      配置读取和校验
src/dingtalk.ts    钉钉 Stream 连接、消息解析、webhook 回复
src/codex.ts       Codex CLI spawn、JSONL 解析、sessionId 提取
src/index.ts       命令处理、白名单、忙碌状态、主流程编排
```

## 验证方式

本地静态验证：

```bash
npm install
npm run build
```

运行：

```bash
cp .env.example .env
# 编辑 .env
npm run dev
```

Codex 预检：

```bash
codex exec --help
codex login
```

钉钉侧预检：

- 开放平台创建企业内部应用。
- 添加机器人。
- 开启 Stream Mode。
- 配置 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`。
