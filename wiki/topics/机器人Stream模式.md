---
title: 机器人 Stream Mode
type: topic
created: 2026-08-18
updated: 2026-08-18
tags: [dingtalk, stream, bot]
source_refs: [src/omi-bot.ts, src/index.ts, src/dingtalk.ts, src/config.ts]
status: active
---

# 机器人 Stream Mode

`omi-bot.ts` 从 `~/.oh-my-im/dws-dashboard.json` 读取 DingTalk 应用凭证与 `botAllowedUserIds`，取得单实例锁后调用 `runApp`。`src/index.ts` 只接受单聊和白名单用户，按 `conversationId` 串行化任务。

消息解析由 `DingTalkBot` 处理：注册 `TOPIC_ROBOT`，抽取文本、会话、发送者和附件；图片/语音/视频/文件可根据 `downloadCode` 下载到 Codex 工作目录的 `.oh-my-im/media/`。`/help`、`/status`、`/new` 在进入普通 Codex 请求前处理。

普通任务优先创建并更新互动卡片。没有 `robotCode` 或卡片 API 失败时，代码使用该次入站消息缓存的 `sessionWebhook` 回退为文本回复。会话 ID 由 [[topics/模块边界|Codex runner]] 从 JSONL 输出提取，随后用于同会话 resume。

限制：Stream 连接、媒体下载和卡片调用均为外部依赖；本页仅描述代码路径，不证明凭证、回调订阅或 API 权限当前有效。

相关：[[topics/入口与运行模式|入口与运行模式]]、[[syntheses/消息到回复链路|消息到回复链路]]。
