---
title: DWS 群监听
type: topic
created: 2026-08-18
updated: 2026-08-18
tags: [dws, group, listener]
source_refs: [src/dws-listener.ts, src/monitor-command.ts, src/dws-dashboard.ts, docs/development.md]
status: active
---

# DWS 群监听

监听器通过 `dws event consume user_im_message_receive_group_all` 获取个人账号可见的群事件，再只接受配置中同时匹配群 ID 与发送者 ID 的目标。它以消息 ID 去重、为每个群维护队列，并在当前批处理结束后继续处理合并到下一批的消息。

事件流不会覆盖当前 DWS 登录账号自己发送的所有情况，因此实现还会按间隔查询目标群的后续消息；另有独立轮询用于接收控制命令。用户限定的监控命令会把当前群加到或移出目标规则，规则更新通过机器人文本回发确认。

每个群的 Codex session 只保存在监听进程内存中；进程重启后重新建立。处理过程中尝试复用持久化的“处理中”卡片，并在结束时把同一张卡片更新为完成或失败。当前 `sendGroupMessage` 只有定义、没有调用，因此正常 Codex 批次不会额外发送普通 DWS 文本；机器人自身事件在本地过滤，防止回复形成循环。

“打开 AI”或“停止 AI”命令走另一条路径：`sendRobotText` 调用 DWS `chat +messages-send --as bot --robot-code ...`，在目标群发送普通机器人文本确认。

## 运维判断

从实现可推论：监听进程存在、DWS 总线已连接或管理页显示连接，均不足以证明端到端成功。至少应确认收到目标事件、通过规则、完成 Codex 调用，并看到卡片或群文本回复的实际成功结果。

相关：[[topics/配置与状态边界|配置与状态边界]]、[[syntheses/消息到回复链路|消息到回复链路]]、[[topics/模块边界|模块边界]]。
