# Agent Control Bridge 开发交付摘要

## 1. 总体结果

- 交付状态：部分交付，待 Hermes 独立验收。
- GitHub：https://github.com/wynter-yaxley/agent-control-bridge；分支 main。
- 基线 commit：75db1e443c1853f99d642ee0e0f56f6ce5fdce61；当前开发内容待安全门禁后提交与推送。
- 仓库可见性：GitHub 集成及匿名访问已确认 public；该可见性由本轮之外操作改变，本轮未重复修改设置。
- 最終同步、CI 与清理证据将在发布后补记，不以文件生成冒称远端交付。

## 2. 已实现内容

- 项目规范与默认配置：[AGENTS](../../AGENTS.md)、[通用规则](../PROJECT_RULES.md)、[配置样例](../../config.example.json)、src/config.ts。会话成套隔离、GPT 同项目名、SemVer/CHANGELOG、测试卫生、三段式验收、并行资源规则和可配置阻塞上报均有规范；可验证的映射与阻塞机制有代码/测试。
- GitHub 工程化：src/silent-process.ts 非交互、隐藏窗口、预算和安全摘要；最小权限 Windows/Linux CI；公开与远端提交须分别核验。
- README 与架构图：[中文](../../README.md)/[英文](../../README_EN.md)仅面向使用者且内容同步；[SVG](../../assets/architecture.svg)含八节点与类型化流，XML 与本地渲染核验。过程文档移至 [CONTRIBUTING](../../CONTRIBUTING.md)、[DEVELOPMENT](../DEVELOPMENT.md)、audit。
- agent-tools：12 原文件完整迁入 tools/desktop，路径/模块改为配置及相对路径，保留兼容工具名与原输入算法；旧直通 Prompt 与无授权写入安全拒绝。外部持久原始备份 12/12 hash 一致，许可由用户确认 MIT。
- 可移植性：内置 SQLite、统一路径、CLI 错误合约、Schema v2 迁移、CAS/事务、独立验收 SQL gate、可信来源接口、Watcher 事件/持久去重/恢复、干净安装与隔离 Mock E2E；[整改表](REMEDIATION.md)保留 24 项审查追踪。

## 3. 修改文件清单

新增 AGENTS、LICENSE、THIRD_PARTY_NOTICES、CHANGELOG、config.example、.gitattributes、CI、assets/architecture.svg、CONTRIBUTING、docs/PROJECT_RULES、DEPLOYMENT、DEVELOPMENT、WORKSPACE_AND_RECOVERY、ACCEPTANCE_TEMPLATE 和 audit 追踪/清单/验证记录。

核心新增 config/errors/security/migrations/topology/prompts/watcher/demo/review-boundary/silent-process；修改 db/tasks/cli 与各状态 Provider。迁入 tools/desktop 的 12 个文件及 common/recovery/requirements/测试。新增构建、安全检查和干净安装脚本、配置/迁移/来源/拓扑/Watcher/工作流等测试。完整文件差异可从基线 commit 对比。

## 4. 测试结果

| 检查 | 结果 | 实际证据 |
|---|---|---|
| npm test | PASS | 17 文件，106 tests/pass，0 fail/skipped |
| npm run build / typecheck | PASS | 实际退出 0；编译输出带 Schema 与权限脚本 |
| CLI Contract | PASS | cli/e2e 负例；37 子命令 help；stderr/非零 |
| SQLite Migration | PASS | v0/v1→v2、重复、回滚、数据保留、未来版本拒绝 |
| Watcher | PASS | 6 测试：默认/覆盖、事件、轮询、慢检测/取消、重启去重、持续阻塞；不宣称严格 SLA |
| Prompt Provenance / topology | PASS | 可信 Mock、伪造/篡改/未知能力/会话名错配/重复投递拒绝 |
| Desktop Safety / recovery / sender Mock | PASS | 16 tests；无网络/真实输入，默认拒绝、单次授权、来源、submit mismatch、finally close |
| E2E Workflow | PASS | 单独运行 4 tests，0 fail/skipped |
| Clean install | PASS | 全新临时目录 npm ci、编译、106 tests、4 E2E、配置、compiled Demo，无真实 Agent |
| 基础安全/规范 | PASS | 当前+全 refs 模式扫描、忽略、链接、XML、package 79 文件且私密路径 0 |
| npm audit | PASS | 已声明 3 个开发依赖，0 已知漏洞；不代表穷尽供应链风险 |
| CI 实际运行 | NOT_VERIFIED | 尚未推送本轮 workflow |
| 真实桌面/模型/飞书/MSIX 恢复 | NOT_VERIFIED | 不启动 Agent、不接管输入、不调用付费模型 |
| Lint | SKIPPED | 项目未引入 Lint；不假造通过 |

完整本地摘要见 [VALIDATION.json](VALIDATION.json)。Node/E2E 计数有重叠，不能相加成独立测试总数。

## 5. 安全检查

在已覆盖的当前公开内容与基线全部 Git refs 检查范围内，未发现能够确认的真实机密泄漏。基础模式扫描不能排除未知秘密及私密业务文本。业务库、WAL/SHM、日志、个人配置和 Profile 不跟踪/不打包；历史审查不删改。

桌面默认不写/不抢焦点，不存在未授权 OS 物理输入入口；有焦点风险的 CDP 写入受单次宿主批准。模型与来源未知拒绝。独立验收、holder/instance/attempt/version CAS、事务故障与双领取回归通过；同 OS 任意恶意宿主代码不是沙箱隔离对象。

生产数据库 SHA-256 与开发基线一致，未迁移业务数据。本次未获取/输出/修改凭据，未启动或重启真实 Agent。发布前历史与当前内容扫描、许可、构建和隔离演示已执行，远端提交与 CI 仍待核验。

## 6. 迁移清理结果

12/12 迁移、原始可恢复外部备份及源 hash 核验完成；新路径 help 与 Mock 发送算法回归通过，无旧路径运行依赖。源目录清理须待推送形成源码副本及最终清点通过，本记录暂不宣称已删除。未知归属或其他用户项目不删除。

## 7. 遗留问题

1. 尚缺可独立验证真实 GPT-6/High 与应用会话、无抢焦点的生产生成/投递适配器；默认拒绝真实自动链路。真实双向发送、飞书送达及 MSIX 恢复须显式授权单列验证。
2. 真实业务库升级、备份/保留/RPO/RTO 演练未执行；不擅自变更业务台账。
3. GitHub 当前交付提交与实际 CI 待推送核验，迁移源目录按安全条件收尾。
4. 多项目自动资源调度器未实现，控制者执行资源分配规范。通知记录不是用户送达证明；时延不具无条件 SLA。
5. 正式版本 tag/GitHub Release 留待独立验收后执行；package.private 仅防意外 npm 发布，不影响 GitHub 公开。

## 8. Hermes 独立验收建议

运行 npm ci、typecheck、build、test、test:e2e、test:desktop、check、test:install。重点对抗：pi --by user、伪造 caller/来源/同名声明、双领取、事件故障回滚、跨 workspace 投递、执行者 SQL 置成功、导出覆盖原 hash、不确定投递重复发送、未授权前台输入。

检查 src/tasks、caller、review-boundary、migrations、prompts、topology、watcher、desktop_common 与各对应测试；核对配置周期/阻塞阈值、原始 DB hash、完整源码清单、GitHub main commit 与实际 CI。真实模型、焦点及外部通知另外授权验证。独立报告使用 [结论 / 证据 / 遗留](../ACCEPTANCE_TEMPLATE.md)。

## 9. 最终状态

PARTIALLY_DELIVERED。已实现内容待 Hermes 独立验收；Codex 不设置 SUCCEEDED。
