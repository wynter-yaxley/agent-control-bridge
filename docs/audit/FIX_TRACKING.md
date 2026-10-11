# Agent Control Bridge 修复追踪清单

> 执行者：pi（开发代理）· 审查基线：8841b8d · 修复分支：fix/architecture-security-hardening
> 状态约定：Fixed（已修复+测试证据）/ Blocked（阻塞）/ Not Verified（环境无法验证）/ In Progress

## 基线（阶段 A）
- Node 测试：114 pass / 1 fail（test 12 = node:sqlite ExperimentalWarning 污染 stderr，环境问题）/ 3 skip
- Python 测试：41 pass / 0 fail
- 工作目录：D:\Agent control bridge · 分支 fix/architecture-security-hardening @ 8841b8d

## P1（架构级）

| Issue | 位置 | 状态 |
|---|---|---|
| P1-01 Node↔Python 授权断裂 | desktop_common.py:36-44 / prompts.ts:96 / relay.py | Fixed (capability IPC + worker) |
| P1-02 gpt_read 静默失效 | gpt_read_cdp.py:5-21 | Fixed |
| P1-03 codex_send 提交后无验证 | codex_send_cdp.py:113-119 | Fixed |
| P1-04 WSL/Windows 运行时矛盾 | DEPLOYMENT.md:48 / recovery.py:46 | Fixed (docs + recovery boundary; real link NOT_VERIFIED) |

## P2（安全与设计）

| Issue | 位置 | 状态 |
|---|---|---|
| P2-01 remoteAllowOrigins 默认 * | desktop_common.py:26 / recovery.py:27 / config.example.json:32 | Fixed |
| P2-02 recovery 端口回退 80 | recovery.py:27 | Fixed |
| P2-03 并发无锁 TOCTOU | codex_send_cdp.py:111-121 / gpt_send_cdp.py:94-97 | Fixed |
| P2-04 未证实 DOM identity 契约 | desktop_guards.py:114-141 / prompts.ts:60-84 | Fixed (capability probe; real desktop NOT_VERIFIED) |
| P2-05 路径规范化不解析 junction | desktop_guards.py:14-18 | Fixed |
| P2-06 剪贴板恢复失败滞留 | clipboard_paste.py:158-165 | Fixed |
| P2-07 codex-status 无界读取 | codex-status:20 | Fixed |
| P2-08 无效 symlink 检查 | desktop_common.py:11 | Fixed |

## P3（健壮性与规范）

| Issue | 位置 | 状态 |
|---|---|---|
| P3-01 recovery 状态机卡死 | recovery.py:21-32 | Fixed |
| P3-02 gpt_read 正则吞正文 | gpt_read_cdp.py:14 | Fixed |
| P3-03 gpt_read 时间戳误删 | gpt_read_cdp.py:15 | Fixed |
| P3-04 gpt_send 误点停止发送 | gpt_send_cdp.py:40,97 | Fixed |
| P3-05 --force-clear 吞正文 | codex_send_cdp.py / gpt_send_cdp.py | Fixed |
| P3-06 注释与实现不一致 | codex-status:73 | Fixed |
| P3-07 desktop_rename 死参数 | desktop_rename.py:70,149 | Fixed |
| P3-08 校验文案不一致 | desktop_rename.py:77,164 | Fixed |
| P3-09 无调用方懒加载包装 | desktop_common.py:126-148 | Fixed |
| P3-10 其余死代码 | desktop_guards.py:277 / clipboard_paste.py:102 | Fixed |
| P3-11 魔法数字与超时 | clipboard_paste.py / desktop_rename.py | Fixed |
| P3-12 docstring 与命名 | gpt_read_cdp.py / cdp_messages.py / relay.py 等 | Fixed |
| P3-13 审计文档 [HOST] 脱敏 | desktop-automation-research.md / CODE_AUDIT_REPORT.md | Fixed |
| P3-14 审计材料过量自审 | CODE_AUDIT_REPORT.md / audit 文档 | Fixed (文档治理已达标) |
