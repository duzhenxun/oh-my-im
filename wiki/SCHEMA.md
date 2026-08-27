# oh-my-im Wiki 规范

## 范围与边界

- 知识库根目录：`/Users/dds/data/git/oh-my-im`
- Wiki 层：`wiki/`
- 原始资料：仓库中受版本控制的 `README.md`、`docs/`、`package.json`、`src/`、`tests/` 与 Git 历史。
- 忽略的 `.oh-my-im/` 和 `.playwright-cli/` 是本机运行状态/测试产物，不是本图谱的正式来源；不读取或记录其中可能存在的凭证、会话和消息内容。

## 页面与证据

- Wiki 页面使用 Obsidian 风格的“目录/页面 + 别名”内部链接，采用中文标题和 YAML frontmatter。
- `source_refs` 只列出可在仓库中回查的文件；页面正文中的“推论”必须明确标注。
- 源码说明描述当前检出的实现，不宣称运行中服务、DingTalk 凭证或 DWS 订阅处于可用状态。
- `wiki/index.md` 是导航入口，`wiki/log.md` 只追加；稳定结论先更新主题或综合页，再更新索引和日志。

## 维护与验证

1. 摄取前检查 `wiki/index.md`、`wiki/log.md` 和 `wiki/sources/`，用仓库相对路径作为 `source_id`。
2. 不修改原始资料；新增结论须回查源码或文档并保留来源链接。
3. 运行 `python3 /Users/dds/.agents/skills/depp-wiki/scripts/wiki_lint.py .`，再检查 `git diff -- wiki`。
4. 对无法从静态源码确认的行为、外部 API 语义或当前运行状态，标记为待验证而非补全。
