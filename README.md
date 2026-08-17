# oh-my-im

独立版钉钉机器人到 Codex CLI 桥接程序。

## 使用

```bash
npm install
npm run build
npm link
omi
```

首次运行会在 `~/.oh-my-im` 创建本地配置；在管理页填写钉钉应用凭证、钉钉规则和机器人单聊授权人员即可。`omi` 的状态、日志和全部运行配置都固定保存在此目录，因此可在任意目录执行 `omi status`、`omi stop` 或 `omi update`。

详见 [docs/development.md](docs/development.md)。
