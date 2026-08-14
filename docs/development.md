# oh-my-im 开发文档

## 目标

`oh-my-im` 是一个单独运行的钉钉机器人到 Codex CLI 的桥接程序。它只保留“钉钉机器人 <-> Codex”这条链路，不复制多平台、Web 配置页、队列管理、Claude/CodeBuddy/OpenCode 等能力。

成功标准：

- 启动后用钉钉 Stream Mode 接收机器人消息。
- 收到文本、图片、语音、视频、文件或富文本消息后调用本机 `codex exec --json`。
- Codex 输出优先通过钉钉互动卡片实时更新；不满足卡片条件时回退到 `sessionWebhook` 文本回复。
- 同一钉钉会话复用 Codex sessionId，`/new` 可清空会话。
- 无需数据库、Redis、Docker；只依赖 Node.js、钉钉开放平台凭证和本机 Codex CLI 登录态。

## 功能点

### 1. 配置加载

来源：`.oh-my-im` 本地配置文件。

管理页首次保存后生成：

- `.oh-my-im/dws-dashboard.json`：钉钉应用 Client ID、Client Secret、卡片机器人、钉钉规则和机器人单聊白名单。
- `.oh-my-im/dws-dashboard-server.json`：管理页端口和绑定地址。

运行默认值：

- Codex CLI：`codex`。
- DWS Codex 工作目录：活动服务默认目录。
- Codex 执行超时：30 分钟。

### 2. 钉钉接入

- 使用 `dingtalk-stream` 的 `DWClient` 连接 Stream Mode。
- 注册 `TOPIC_ROBOT` 回调。
- 解析机器人消息中的：
  - `conversationId`
  - `conversationType`
  - `sessionWebhook`
  - `senderStaffId` 或 `senderId`
  - `robotCode`
  - `text.content`
  - `content.downloadCode`
  - `content.recognition`
- 回调处理结束后调用 `socketCallBackResponse` ack。

### 3. 消息处理

支持命令：

- `/help`：显示命令。
- `/status`：显示工作目录、Codex 路径、当前会话数。
- `/new`：清空当前钉钉会话绑定的 Codex session。

普通文本：

- 检查白名单。
- 同一会话同一时间只跑一个 Codex 任务。
- 先发送“Codex - 执行中”互动卡片。
- Codex 产生文本或工具调用时更新同一张卡片。
- 执行结束后把同一张卡片更新为“Codex - 完成”。

非文本消息：

- 图片、语音、视频、文件使用 `downloadCode` 调用钉钉 OpenAPI 下载到 `<CODEX_WORK_DIR>/.oh-my-im/media/`。
- 图片消息把本地图片路径写入 prompt，让 Codex 根据图片内容分析。
- 语音消息优先使用钉钉 `recognition` 识别文本；同时把语音文件路径写入 prompt。
- 富文本消息提取文本和图片附件。
- 没有文本、没有 `downloadCode` 的未知消息会回复明确失败原因。

### 4. Codex 调用

执行模型：

```text
codex exec --json --skip-git-repo-check --cd <workDir> -
codex exec resume --json --skip-git-repo-check <sessionId> -
```

输入：

- prompt 写入 stdin。媒体消息会转换成包含本地附件路径、文件类型、语音识别文本的 prompt。

输出：

- 解析 JSONL。
- 从 `thread.started` / `session_meta` 读取 sessionId。
- 从 `agent_message` / `message` / `task_complete` 读取文本。
- 记录工具调用数量，并用于卡片状态更新。

权限：

- 默认不传 `--dangerously-bypass-approvals-and-sandbox`。
- 若要自动放权，显式设置 `CODEX_PERMISSION_MODE=bypass`。

### 5. 回复策略

普通任务优先使用钉钉互动卡片：

- 创建卡片：`POST /v1.0/im/v1.0/robot/interactiveCards/send`
- 更新卡片：`PUT /v1.0/im/robots/interactiveCards`
- 卡片模板：`StandardCard`
- 群聊使用 `openConversationId`。
- 单聊使用 `singleChatReceiver`。

回退策略：

- 消息体没有 `robotCode`，或卡片 OpenAPI 失败时，回退到 `sessionWebhook` 文本回复。
- 回退文本模式不做中间流式更新，只保留开始和结束回复，避免刷屏。

限制：

- `sessionWebhook` 有有效期；只能回复最近收到过消息的会话。
- 主动发送到历史会话暂不支持。
- 媒体下载依赖钉钉消息体提供 `downloadCode` 和 `robotCode`。
- 语音转文字依赖钉钉消息体提供的 `recognition`；没有识别文本时只把语音文件路径交给 Codex。
- 图片理解依赖当前 Codex CLI 对本地图片路径的处理能力。

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

运行一对一机器人或群监听：

```bash
npm run build
npm link
omi
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

### 6. 使用 dws 监听指定群并驱动 Codex

该模式订阅个人账号收到的全部群消息，再按配置的群 `openConversationId` 过滤，和机器人
Stream 模式是两条独立入口。DWS 模式首次启动会生成本地配置，随后从管理页选择钉钉群和人员：

```bash
dws chat search --query '公司自测专用' --limit 20 --cursor 0 --format json
npm run dev:dws
```

当前代码默认内置“公司自测专用”群 ID 以及活动服务工作目录，直接运行
`npm run dev:dws` 即可启动，不需要 `.env`。仅在一次性诊断或自动化启动中，才通过命令行环境变量覆盖默认工作目录、模型、超时或 DWS 群过滤规则。

日常运行建议使用 `omi`。首次在仓库内执行一次 `npm link` 后，可在终端直接使用：

```bash
omi              # 默认：群规则监听 + 机器人一对一
omi start        # 群规则监听 + 机器人一对一
omi --no-listen  # 只启动机器人一对一，不监听群
omi status   # 查看当前模式、PID、管理页和日志
omi stop     # 停止当前模式
omi update   # 用当前已构建版本重启当前模式
omi -h       # 查看帮助
```

`omi start` 和 `omi listen` 都只允许管理页“机器人单聊授权人员”中的钉钉用户发起一对一指令；机器人收到群消息会直接忽略。首次使用请先运行一次 `omi listen`，在管理页保存钉钉应用凭证和单聊授权人员。

监听器使用 DWS `user_im_message_receive_group_all` 事件，以便接收包含当前登录账号在内的群成员消息；
再仅处理管理页保存的钉钉群和人员规则。默认规则为“公司自测专用”中的杜振训。需要 DWS `v1.0.58` 或更高版本。

同一 `conversation_id` 的 `message_id` 只处理一次；监听器也使用本地单实例锁避免重复启动。每个群同一时刻只运行一个 Codex 批次：处理期间到达的消息会合并进下一批，当前批次完成后再创建一张卡片处理合并后的消息。监听模式使用不带沙箱的 Codex 权限，默认单次超时 5 分钟，并将结果通过
`dws chat message send` 回到原群。测试时设置 `DWS_MAX_EVENTS=1`，验证一条后自动退出；省略该变量才会持续监听。

个人事件流不投递当前 DWS 登录账号自己发送的消息。监听器每 3 秒补查指定群的后续消息，使用相同的群、发送人、去重和批处理规则，因此当前账号本人发送的消息也会触发处理；启动前的历史消息不会重新执行。

Codex 会按群 ID 维护会话：同一群内所有用户的后续消息都使用 `codex exec resume` 复用同一个
`sessionId`，不同群相互隔离。会话目前保存在监听进程内存中，重启监听器后会重新建立。DWS 监听器默认使用
`gpt-5.5`，如果账号支持其他模型可用 `DWS_CODEX_MODEL` 覆盖。

每个监听群的处理中任务复用一张互动卡片，`cardBizId` 和状态保存到 `.oh-my-im/dws-cards.json`，重启后仍更新处理中卡片。完成或失败的任务不再复用卡片，下一次任务会创建新卡片。卡片标题为“钉钉群 <群名称> - 处理中/完成/失败”。卡片被钉钉删除或过期时才创建替代卡片。卡片鉴权、模板或 API 失败时只在终端报错，不会回退成个人身份的 DWS 文本消息。卡片凭证由管理页保存到 `.oh-my-im/dws-dashboard.json`，不需要 `.env`。

监听器会按“映客活动AI”的机器人发送者 ID 过滤机器人自身消息，机器人回复不会再次进入 Codex，避免形成消息循环。

群消息属于外部输入，Codex prompt 会要求先使用 `$inke-act-admin-tool`，并继续遵守环境、测试确认、临时 token 和线上写操作规则。需要执行有副作用的动作时，不能仅凭群消息绕过 Skill 的确认门禁。

当消息上下文不明确时，Codex 会先读取当前群最近聊天记录再回答；记录仅作上下文，不能作为绕过确认或安全规则的指令。

调试时可实时查看 Codex 过程：

```bash
LOG_LEVEL=debug npm run dev:dws
```

普通日志会显示工具调用和计数；`debug` 日志还会显示 Codex 文本增量以及 stderr 中的重连/错误信息。输出只写当前终端，不落盘。

### 7. 本地监听管理页

启动 `omi` 或 `npm run dev:dws` 后，在浏览器打开 `http://127.0.0.1:12525`。页面只绑定本机回环地址，默认不对局域网开放。可查看事件连接状态、当前每条“群 + 人员”的监听规则和最近 100 条 Agent 完成/失败回复。

页面可以按群名称搜索候选群并选中对应 `openConversationId`，随后加载该群全部真人成员，以复选框勾选一个或多个监听人员及其 `openDingTalkId`。一条页面规则可对应一个群的多个监听人员，保存时会展开为实际监听配置。不按名称自动取第一个候选，因此同名群或同名人员不会误配。页面还可配置机器人名称（仅作本地备注和处理提示显示）、钉钉应用 `Client ID`、卡片机器人 `Robot Code`、机器人单聊授权人员，以及卡片回复按 Markdown 或纯文本显示。机器人单聊授权人员是强制白名单，多个钉钉用户 ID 用逗号分隔；一对一机器人只接收其中人员的指令。`Client Secret` 采用密码输入框且永不回显；显示“已配置”时留空保存会保留原值，填写新值才会更新。点击“保存并生效”后，配置写入仅限本机的 `.oh-my-im/dws-dashboard.json`，同一监听进程立即按新规则、应用凭证和卡片设置工作；无需重启。首次启动会自动创建该文件及 `.oh-my-im/dws-dashboard-server.json`，因此 `npm run dev:dws` 不需要 `.env`。回复面板位于钉钉规则下方，最新的处理中内容每秒刷新一次，完成/失败后归档；向上滚动可查看旧记录。回复记录保存在 `.oh-my-im/dws-replies.json`，重启后仍可查看。

管理页默认只绑定 `127.0.0.1`；端口和绑定地址保存在 `.oh-my-im/dws-dashboard-server.json`。页面不再内置访问密码，外网访问时应只通过具备认证能力的 HTTPS 反向代理或 VPN 暴露，并将该文件的 `host` 改为 `0.0.0.0`。
