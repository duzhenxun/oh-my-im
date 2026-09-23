# oh-my-im

`oh-my-im` 是一个运行在本机的钉钉 AI Agent 桥接器。它接收钉钉单聊和配置群中的消息，调用本机的 [Codex CLI](https://github.com/openai/codex)、[Pi](https://github.com/badlogic/pi-mono) 或 [OpenCode](https://opencode.ai/)，再通过钉钉文本或互动卡片返回结果。

项目是一个 TypeScript/Node.js 应用，不使用数据库、Redis 或 Docker。配置、运行状态、日志和回复历史默认保存在当前用户的 `~/.oh-my-im/` 目录。

## 能做什么

- 单聊机器人：按用户白名单接收钉钉单聊，支持文本、图片、文件、语音等可解析消息。
- 群消息监听：消费 DWS 全群消息事件，再按“群 + 发送人”规则做本地过滤。
- Agent 切换：在管理页选择 Codex、Pi 或 OpenCode（作为默认值），也可以在会话中使用已配置的关键词切换；切换结果**按会话（每个群/每个私聊）独立保存**，重启后各自沿用，互不影响。
- Agent 模型：管理页可分别配置 Codex、Pi 和 OpenCode 模型；Codex 的可选模型来自 `~/.codex/config.toml` 里 `model_catalog_json` 指向的目录（不配则沿用 Codex CLI 默认模型，配置后通过 `--model` 传入）。
- 回复方式：在管理页「机器人配置」中选择普通卡片、AI 卡片或普通消息；该设置同时作用于群聊和私聊。
- 互动卡片：显示处理中和最终回复，内容始终按 Markdown 渲染。
- Session 管理：单聊用户只能查看和切换自己工作目录下的 Session；超级管理员可管理其他工作目录。
- 本地控制台：配置钉钉凭证、群规则、单聊白名单、Agent、提示词和指令关键词。
- 进程管理：使用 `omi` 启动、停止、重启、更新和查看 worker 状态。

## 工作方式

```text
钉钉单聊 ── Stream Mode ──> bot-worker ──┐
                                         ├─> Codex CLI / Pi RPC / OpenCode CLI
DWS 群事件 ── DWS CLI ──> group-worker ──┘
                                         └─> 钉钉文本 / StandardCard / AI 卡片

dashboard-worker ──> http://127.0.0.1:12525
```

默认启动会运行三个独立 worker：

| Worker | 作用 |
| --- | --- |
| `dashboard-worker` | 提供本地管理页、配置 API、状态和日志查看 |
| `group-worker` | 监听 `user_im_message_receive_group_all`，处理配置群消息 |
| `bot-worker` | 通过钉钉 Stream `TOPIC_ROBOT` 处理单聊 |

群消息不会因为出现在 DWS 全群事件流中就自动触发 Agent，只有命中管理页配置的群和发送人才会进入处理队列。每个群独立排队，并复用该群对应 Agent 的 Session。

### 分层

代码按「入口 → 业务编排 → 外部适配 → 基础库」分层，避免相互缠绕：

```text
入口        omi.ts  group-worker.ts  bot-worker.ts  dashboard-worker.ts
            │
业务编排     bot-app.ts（单聊）   dws-dashboard.ts（管理页 + 配置模型）
            │
外部适配     dingtalk/（Stream、普通卡片、AI 卡片、机器人、Markdown）
            dws/（DWS CLI 调用、群历史补偿）
            agents/（Codex / Pi / OpenCode 进程适配）
            │
基础库       core/（config、logger、version、回复历史、群控制指令）
```

- 外部依赖（CLI、钉钉接口）只在适配层出现；上层只依赖统一的 `runAgent` / `listAgentSessions` / 卡片接口。
- 单个会话的状态（Agent、Session、工作目录、卡片）按 `群 ID` 或 `私聊 ID` 隔离，互不影响。

---

## 前置条件

- Node.js `>= 20`
- 已安装并登录的 Codex CLI；使用 Pi 时还需要已安装并登录 `pi`
- 已安装并登录的 DWS CLI；只有群监听需要 DWS
- 一个已开启 Stream Mode 的钉钉企业内部应用机器人
- 钉钉应用的 Client ID（AppKey）和 Client Secret（AppSecret）
- 用于群消息发送的机器人配置，以及可选的钉钉机器人 Webhook

可先检查本机依赖：

```bash
node --version
codex --version
codex login
dws --version
dws auth status
pi --version       # 仅使用 Pi 时需要
```

## 安装与启动

从源码运行：

```bash
npm install
npm run build
npm link
omi
```

也可以不建立全局命令：

```bash
npm run build
npm start
```

启动后打开管理页：

```text
http://127.0.0.1:12525
```

首次安装建议按以下顺序配置：

1. 在“钉钉应用”区域填写 Client ID、Client Secret、机器人名称和机器人 ID。
2. 在 DWS 区域完成登录；管理页可发起 Device Flow 登录并查看状态。
3. 搜索群并选择群成员，保存群监听规则。每条规则的唯一键是 `groupId + senderId`。
4. 选择默认 Agent，必要时填写 Agent 模型名和群提示词后缀。
5. 如需单聊，打开单聊开关并添加单聊授权人员；可另外配置 Session 超级管理员。
6. 点击“保存并生效”，然后从钉钉发送一条测试消息。

配置保存后由 worker 重新读取，通常不需要重启。新安装默认关闭单聊；没有单聊白名单时，机器人仍可启动，但所有单聊都会被拒绝。

### Agent 模型

管理页展示三个 Agent 的模型选择：

```text
Codex 默认模型    -> 所有使用 Codex 的群聊和单聊（通过 --model 传入，留空则用 Codex CLI 默认模型）
Pi 默认模型       -> 所有使用 Pi 的群聊和单聊（通过 --model 传入）
OpenCode 默认模型 -> 所有使用 OpenCode 的群聊和单聊（通过 --model 传入）
```

模型来源：

- **Codex**：可选列表来自 `~/.codex/config.toml` 中 `model_catalog_json` 指向的模型目录（默认 `~/.codex/models.json`），取其中的 `slug`；写入的是不带 provider 的模型名。
- **Pi**：`pi --list-models`，保存格式为 `provider/model`。
- **OpenCode**：`opencode models`，保存格式为 `provider/model`。

三个列表都不做白名单过滤——CLI 能列出什么就展示什么；对应 CLI 暂时不可用时可以直接留空，使用其默认模型。

## `omi` 命令

```bash
omi                 # 启动群监听、单聊机器人和管理页
omi start           # 同上
omi listen          # start 的别名
omi --no-listen     # 只启动单聊机器人和管理页
omi status          # 查看模式、PID、工作目录、管理页和日志路径
omi stop            # 停止 omi 及其 worker/子进程
omi restart         # 按当前模式重启
omi update          # 使用当前 dist/ 重启
omi -h              # 查看帮助
```

`omi update` 只重启当前已经构建的代码，不会执行依赖安装或 TypeScript 编译。修改源码后请执行：

```bash
npm run build
omi update
```

启动 `omi` 时的当前目录会作为默认 Agent 工作目录，也会影响源码运行时读取的本地 `.oh-my-im` 兼容配置。因此应在目标项目目录中启动，例如：

```bash
cd /path/to/your/workspace
omi
```

## 管理页配置

管理页默认只绑定 `127.0.0.1`，默认端口为 `12525`。可配置内容包括：

- 默认 Agent：Codex、Pi 或 OpenCode，以及各自可选的模型名（也支持在会话中用关键词切换，切换结果按会话保存）。
- 钉钉应用凭证、机器人名称、机器人发送者 ID。
- 单聊开关、单聊授权人员和 Session 超级管理员。
- 群监听规则：群、群成员和每次个人历史消息拉取参数。
- 群提示词后缀、互动卡片格式、卡片更新间隔和是否显示耗时。
- 提示词后缀会追加在群聊用户消息的最下方，对 Codex、Pi、OpenCode 三个 Agent 都生效。
- 工作目录自动按会话生成，无需配置：群聊为 `~/.oh-my-im/group/<群名>`，私聊为 `~/.oh-my-im/users/<发送人名称>`（例如 `~/.oh-my-im/users/杜振训`），三个 Agent 使用同一个工作目录。
- Agent 回复方式：在「机器人配置」页选择「普通卡片 / AI 卡片 / 普通消息」，群聊和私聊统一生效。普通卡片会创建并更新互动卡片（此时显示卡片设置）；AI 卡片使用钉钉流式卡片呈现出打字机效果；普通消息只在 Agent 完成后发送最终结果。
- AI 卡片：需先在[卡片平台](https://open-dev.dingtalk.com/fe/card)创建「消息卡片 + 场景 AI 卡片」模板（在「输出中」状态的 Markdown 组件开启流式开关并绑定变量，默认 `content`；标题变量用 `title`；结束语变量用 `end_text`），并为应用申请 `Card.Streaming.Write`（投放/改标题还需 `Card.Instance.Write`）权限。在页面填入模板 ID 后即可启用；模板未配置、权限不足或接口报错时会自动回退为普通卡片。AI 卡片标题不带图标：处理中为 `【Pi】模型名 进行中...`，完成后为 `【Pi】完成 总耗时 15s`，暂停/失败为 `【Pi】处理暂停/处理失败 总耗时 Xs`；完成时的结束语（模型名、消息数、工具次数）写入 `end_text`，不拼进正文。AI 卡片单次内容建议不超过 1K、总量不超过 3K，超长回复会自动改用文本发送。
- 处理详情：默认不显示，可在卡片设置中开启；开启后展示消息数和工具调用数。
- 卡片更新间隔设为正数时按间隔更新处理中内容；设为 `0` 或负数时关闭处理中更新，仅在 Agent 完成后发送最终结果。
- 暂停、开启/关闭监听、切换 Agent 的关键词。多个关键词用 `|` 分隔。
- 可选的 Webhook，用于 Agent 处理失败时向群发送文本通知。

管理页首次启动默认密码为 `5552123`，登录后可在“控制台安全 → 系统密码”中修改。密码使用 Node `scrypt` 哈希保存于 `~/.oh-my-im/dashboard-password.json`，不会写入公开配置；登录会话用 HttpOnly Cookie 标识，服务端有效期与 Cookie `Max-Age` 均为 **60 天**，并持久化到 `~/.oh-my-im/dashboard-sessions.json`，因此重启看板不会掉线。修改密码会清空全部会话（所有设备下线）。若把绑定地址改为 `0.0.0.0` 或 `::`，仍应在前面增加 HTTPS 反向代理或 VPN，不要直接暴露管理页。

## 单聊命令

单聊命令必须由已授权用户发送。Session 相关命令在 Agent 任务运行期间不能执行。

```text
/help
/status
/sessions [pi|codex|opencode]
/use <pi|codex|opencode> <编号或 sessionId>
/current
/new                       # 清空当前会话的 Agent session，下一条消息使用新会话
```

Session 超级管理员额外拥有：

```text
/admin-sessions [pi|codex|opencode]
/admin-cd <目录编号或路径>
/admin-use <pi|codex|opencode> <编号或 sessionId>
/admin-current
/admin-reset
```

用户的私有工作目录按发送人名称隔离，例如 `~/.oh-my-im/users/杜振训`。普通 `/sessions` 和 `/use` 不会展示或切换到其他用户目录中的 Session；管理员切换只影响当前私聊。

## 群消息控制

群控制使用管理页配置的关键词。群内开启/关闭监听时，需要在消息中提及目标成员，且命令发送者必须是配置中的授权人员。暂停命令只暂停当前 Agent 任务；Pi 支持运行中引导，Codex 的后续文本会在当前任务结束后合并处理。

群监听依赖 DWS 事件订阅和本地 DWS 登录状态。事件总线连接成功不等于目标群已生效，实际是否处理还取决于管理页中的群成员规则。

由 AI 发送的群消息不会被 Agent 回复：系统会忽略群内所有机器人成员（如钉钉 AI 助手、其他 AI 机器人）发出的消息，也会忽略带「AI 发送」角标的消息，避免 AI 之间互相触发。机器人成员列表会在启动时和每 5 分钟自动刷新。

## 环境变量

环境变量用于覆盖 CLI 路径、工作目录和部分运行参数；钉钉凭证和业务规则应在管理页中配置。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WORK_DIR` | `~/.oh-my-im/group/<群名>` | 群聊 Agent 工作目录（设置后为固定目录，不再拼接群名） |
| `AGENT_WORK_DIR` | `~/.oh-my-im/users/<发送人名称>` | 私聊 Agent 工作目录（设置后为固定目录，不再拼接人名） |
| `DWS_CLI_PATH` | `dws` | DWS CLI 路径 |
| `CODEX_CLI_PATH` | `codex` | 群侧 Codex CLI 路径 |
| `PI_CLI_PATH` | `pi` | Pi CLI 路径 |
| `OPENCODE_CLI_PATH` | `opencode` | OpenCode CLI 路径 |
| `DWS_CODEX_MODEL` | 不使用 | 不读取；Codex 使用系统 CLI 默认模型 |
| `DWS_CODEX_TIMEOUT_MS` | `300000` | 群侧 Codex 超时，单位毫秒 |
| `CODEX_PROXY` | 未设置 | 传给 Agent 的代理配置 |
| `CODEX_HOME` | `~/.codex` | Codex Session 根目录 |
| `PI_CODING_AGENT_SESSION_DIR` | `~/.pi/agent/sessions` | Pi Session 根目录 |
| `OHMIM_DATA_DIR` | `~/.oh-my-im` | 回复历史目录使用的数据根目录 |

模型来源：Codex 使用 `model_catalog_json` 目录里的模型或 CLI 默认模型，Pi 和 OpenCode 使用 Web 中各自的模型配置；未配置时分别使用对应 CLI 默认模型。OpenCode 模型列表来自 `opencode models`，保存值格式为 `provider/model`。

当前实现默认以 bypass/full approval 方式运行 Agent。请只在可信的本地工作目录中使用，并确保 Agent 运行账号拥有合适的文件权限。

## 本地数据与日志

默认数据目录为 `~/.oh-my-im/`：

```text
~/.oh-my-im/
├── dws-dashboard.json          # 管理页配置，包含敏感凭证
├── dws-dashboard-server.json  # 管理页 host/port
├── dashboard-password.json     # 管理页密码（scrypt 哈希）
├── dashboard-sessions.json     # 已登录设备的会话（60 天有效）
├── omi-state.json              # omi 管理的进程状态
├── omi.log                     # worker 合并日志
├── omi-bot.lock                # 单聊 worker 锁
├── group-worker.lock           # 群 worker 锁
├── omi-bot-status.json         # 单聊连接状态
├── dws-cards.json              # 群卡片状态
├── group-sessions.json         # 群聊 Agent Session 绑定
├── group-agents.json           # 每个群当前选用的 Agent
├── private-sessions.json       # 私聊 Agent Session 绑定
├── private-agents.json         # 每个私聊当前选用的 Agent
├── dws-history-cursor.json     # 个人群历史轮询时间游标和消息去重键
└── replies/YYYY-MM-DD.json     # 单聊和群聊回复历史
```

`dws-dashboard.json` 含 Client Secret，请限制文件权限，不要提交到 Git 或复制到公开日志。管理页返回状态时会隐藏 Client Secret 和 Webhook 地址，仅显示是否已配置。

## 开发与验证

源码目录为 `src/`，编译产物为 `dist/`，TypeScript 配置启用严格模式：

```bash
npm install
npm run build
```

开发时可直接运行单个 worker：

```bash
npm run dev:bot
npm run dev:dws
```

运行日志：

```bash
tail -f ~/.oh-my-im/omi.log
```

`package.json` 提供 `npm test`，会先构建再运行 `tests/*.test.mjs`（Node 内置 test runner，覆盖 Markdown 表格转换、AI 卡片会话收尾/降级、钉钉卡片接口重试、模型名归一化）。提交前至少运行：

```bash
npm test
```

单测不覆盖真实的外部依赖；发版前仍建议结合 DWS、钉钉和 Agent 做一次端到端验证，因为构建不会验证外部账号、权限、事件订阅或卡片发送能力。

## 常见问题

### 管理页打不开

确认已经执行 `npm run build`，再运行 `omi status` 查看 dashboard worker 和日志路径。默认地址是 `127.0.0.1:12525`；端口被占用时，修改 `~/.oh-my-im/dws-dashboard-server.json` 后重启。

### 单聊没有响应

确认管理页已打开单聊开关、已添加发送人白名单、Client ID/Secret 正确，并确认钉钉应用已启用 Stream Mode。无白名单时是预期的 deny-all 行为。

### 群消息没有触发

依次检查 `dws auth status`、DWS 事件订阅、群监听是否以默认模式启动，以及管理页中是否选择了准确的群和发送人。DWS 事件状态只能证明订阅连接，不能替代本地规则匹配。

### 修改代码后没有生效

```bash
npm run build
omi update
omi status
```

### 需要停止残留进程

优先执行：

```bash
omi stop
```

`omi stop` 会根据状态文件和 worker 进程树停止由本项目启动的 worker 及其 Agent/DWS 子进程。

## 项目结构

```text
src/
├── omi.ts                  # omi CLI、worker 生命周期和进程状态
├── dashboard-worker.ts     # 管理页 worker（入口）
├── group-worker.ts         # DWS 群消息监听、队列和群卡片（入口）
├── bot-worker.ts           # 单聊 worker 生命周期（入口）
├── bot-app.ts              # 单聊鉴权、命令、Agent 会话与卡片编排
├── dws-dashboard.ts        # 管理页 HTTP 服务、页面和共享配置模型
├── agents/                 # Codex / Pi / OpenCode 进程适配
│   ├── index.ts            # 统一入口：runAgent / listAgentSessions
│   ├── codex-agent.ts
│   ├── pi-agent.ts
│   ├── opencode-agent.ts
│   └── process-utils.ts
├── dingtalk/               # 钉钉侧：消息、卡片、Markdown
│   ├── dingtalk.ts         # Stream 单聊消息解析与发送
│   ├── dingtalk-card.ts    # 普通互动卡片（StandardCard）
│   ├── dingtalk-ai-card.ts # AI 卡片（流式卡片）API 客户端
│   ├── ai-card.ts          # AI 卡片会话：投放、流式、收尾与降级
│   ├── dingtalk-robot.ts   # 钉钉机器人 OpenAPI / Webhook
│   └── markdown.ts         # 钉钉 Markdown 归一化（表格转列表）
├── dws/                    # DWS CLI 侧
│   ├── dws-client.ts       # DWS CLI 调用与 JSON 适配
│   └── dws-history.ts      # 群消息历史补偿
└── core/                   # 通用基础
    ├── config.ts           # 运行配置与 Agent 模型解析
    ├── logger.ts           # 日志
    ├── version.ts          # 版本号单一来源（读 package.json）
    ├── conversation-log.ts # 回复历史持久化
    └── monitor-command.ts  # 群控制指令解析与配置变更
```

## License

[MIT](LICENSE)
