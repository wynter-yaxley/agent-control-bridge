# 贡献指南

开始前阅读 [项目规范](AGENTS.md) 与 [项目规则](docs/PROJECT_RULES.md)。本项目只维护 Prompt 转发；新增功能先提出并获批准。

## 开发与验证

使用满足 package.json 的 Node 与 npm，运行 `npm ci`、`npm run typecheck`、`npm run build` 和 `npm test`（见 [README](README.md#开发)）。测试不得使用真实对话、业务数据或登录会话；真实发送结果单独报告，未验证不计通过。

## 提交与版本

不要提交凭据、日志、个人配置或运行数据。变更聚焦实际问题，面向用户的行为变化写入 [CHANGELOG](CHANGELOG.md)。不强推、不重写他人历史，不把提交或推送当作实机验证。
