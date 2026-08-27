# Wiki 维护日志

## [2026-08-18] ingest | oh-my-im 仓库初始图谱
- source_id: `README.md`, `docs/development.md`, `package.json`, `src/`, `tests/`
- created: [[README]], [[index]], [[maps/系统图谱]], [[syntheses/消息到回复链路]], [[topics/入口与运行模式]], [[topics/机器人Stream模式]], [[topics/DWS群监听]], [[topics/配置与状态边界]], [[topics/模块边界]], [[sources/README]], [[sources/开发文档]], [[sources/包配置与源码]]
- summary: 建立项目入口、消息链路、组件边界与配置状态边界图谱；未读取忽略的本地运行数据。

## [2026-08-18] ingest | oh-my-im 项目分析与运行说明
- source_id: `raw/oh-my-im-钉钉与Codex流程说明.md`
- created: [[sources/项目运行说明]]
- updated: [[README]], [[syntheses/消息到回复链路]], [[topics/配置与状态边界]]
- summary: 保存桌面原始文档副本，纳入运行流程、验收条件和安全边界的可追溯来源。

## [2026-08-18] lint | 初始图谱结构巡检
- fixed: 初始页面和新增来源均由索引收录并互链；规范示例不再被当作链接。
- open: 尚未对真实 DingTalk/DWS/Codex 外部链路做端到端验证。

## [2026-08-18] query | 配置机器人如何发送卡片与普通消息
- result: [[syntheses/消息到回复链路]]
- evidence: [[topics/DWS群监听]]、`src/dws-listener.ts`、`src/dingtalk-card.ts`、`src/dingtalk.ts`
- summary: 正常群批次仅通过互动卡片展示进度和结果；AI 启停命令才通过 DWS 以机器人身份发普通文本。单聊机器人会在卡片不可用时使用入站 `sessionWebhook` 回退文本。
