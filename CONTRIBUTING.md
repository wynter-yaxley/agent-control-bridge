# 贡献指南

开始前请阅读 [开发规范](AGENTS.md)。新增功能请先提 Issue 讨论。

1. `npm ci`，然后运行 `npm run lint`、`npm run typecheck`、`npm test`。测试不得使用真实对话或登录会话。
2. 桌面行为的改动需要在 Windows 上运行 `npm run smoke`，并在 PR 中如实写明结果；未实测的请标注。
3. 不要提交凭据、日志、个人配置、本机路径或运行数据。面向用户的变化写进 [CHANGELOG](CHANGELOG.md)。
4. 通过功能分支和 Pull Request 提交，不直接推送 main，不强推，不重写他人历史。
