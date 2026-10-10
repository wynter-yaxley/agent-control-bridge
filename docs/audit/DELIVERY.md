# Agent Control Bridge 开发交付摘要

## 1. 总体结果

- 交付状态：部分交付，已实现内容待 Hermes 独立验收；执行者未设置最终成功状态。
- 仓库：[wynter-yaxley/agent-control-bridge](https://github.com/wynter-yaxley/agent-control-bridge)，分支 `main`。
- 基线：`75db1e443c1853f99d642ee0e0f56f6ce5fdce61`；经核验实现 commit：`6fd49a6c05b2600d8fcf54d04a4ffdb57d5e7e9f`。最终证据文档 commit 从 main HEAD 查询，避免文档自引用 hash。
- 可见性：GitHub 集成与匿名 REST/网页分别确认 **public**。可见性由本轮之外操作改变，本轮未重复修改设置；本轮正常推送交付内容，无强推或历史改写。
- 远端完整 Git 树与本地实现逐项比较，**104 文件一致**，包括 12 个原桌面工具的迁移版本。公开、文件一致和 CI 分别验证。

## 2. 已实现内容

| 目标 | 已实现及文件证据 | 验证边界 |
|---|---|---|
| 项目规范与默认配置 | [AGENTS](../../AGENTS.md)、[通用规则](../PROJECT_RULES.md)、[会话与恢复规则](../WORKSPACE_AND_RECOVERY.md)、[配置样例](../../config.example.json)、src/config.ts/topology.ts/watcher.ts | 规范环境无关；具体部署值在配置/部署说明。映射、GPT 同项目名、阻塞阈值有测试；实际用户通知由 Hermes 消费台账 |
| GitHub 仓库公开 | src/silent-process.ts、[CI](../../.github/workflows/ci.yml)、scripts/check.mjs；已有 Git/GCM 正常推送及匿名核验 | 非交互、隐藏、预算与脱敏摘要；未提取凭据。实际 CI 见下表 |
| README 与架构图 | [中文](../../README.md)/[英文](../../README_EN.md)、[SVG](../../assets/architecture.svg) | 六个主要使用者章节实质同步；过程记录移至 CONTRIBUTING、DEVELOPMENT、audit。SVG 是独立矢量，八节点、类型化数据流，XML 与渲染已检查 |
| agent-tools 迁移 | [工具说明](../../tools/desktop/README.md)、12 原文件、desktop_common.py/recovery.py/tests | 保留读写算法和兼容工具名；默认禁写，焦点风险需单次宿主授权。无已授权前台/真实模型实测 |
| 可移植性与工程化 | src/config.ts/errors.ts/migrations.ts/prompts.ts/review-boundary.ts、scripts、test、[MIT](../../LICENSE) | 内置 SQLite、配置及路径、CAS/事务、独立验收 SQL gate、Schema v2、隔离 Mock 与干净安装；生产自动生成/投递适配器尚缺 |

新增通用规范包括 SemVer/CHANGELOG/验收后 Release tag、隔离测试卫生、结论/证据/遗留三段验收、多项目优先级与资源隔离、可配置阻塞上报。Watcher 默认 60000ms，阻塞上报阈值默认 600000ms；检测采用事件加周期兜底，持久去重及重启恢复，不宣称无条件 60 秒 SLA。

## 3. 修改文件清单

- 规范与文档：AGENTS.md、README.md、README_EN.md、CONTRIBUTING.md、CHANGELOG.md、LICENSE、THIRD_PARTY_NOTICES.md、assets/architecture.svg、docs/PROJECT_RULES.md、DEPLOYMENT.md、WORKSPACE_AND_RECOVERY.md、DEVELOPMENT.md、ACCEPTANCE_TEMPLATE.md、audit/REMEDIATION.md、DESKTOP_MIGRATION.json、VALIDATION.json、本报告。
- 核心实现：config、errors、security、caller、db、permissions、migrations、tasks、topology、prompts、watcher、demo、review-boundary、silent-process、CLI 和状态 Provider。
- 桌面迁移：tools/desktop 的 12 原文件，加公共配置、安全、恢复、依赖说明及三份测试。
- 工程与测试：package/lock、tsconfig、.gitignore/.gitattributes、CI、build/check/test/clean-install 脚本、17 份 Node 测试及 fixture/并发 worker。

准确差异可用 `git diff --name-status 75db1e443c1853f99d642ee0e0f56f6ce5fdce61 HEAD` 查询。原审查报告未改写；不会抹掉原风险或历史失败。

## 4. 测试结果

| 检查 | 结果 | 实际证据 |
|---|---|---|
| npm test | PASS | 17 文件，111 tests/pass，0 fail/skipped/cancelled |
| npm run build | PASS | 退出 0；编译输出含 Schema 与 ACL 助手 |
| TypeScript 检查 | PASS | npm run typecheck，退出 0 |
| CLI Contract Tests | PASS | 别名入口、参数/枚举、pass/fail、stderr/非零、只读查询、37 help；旧库 init 拒绝 |
| SQLite Migration Tests | PASS | 新建、0/1→2、重复、未来/陌生/缺表拒绝、原数据及文件字节保留、失败回滚；真实隔离 ACL 建库 |
| Watcher Tests | PASS | 6 测试：默认/覆盖、事件与轮询、慢检测/取消、持久去重/重启、阻塞起点不被续租重置 |
| Prompt Provenance / topology | PASS | 可信 Mock、伪造/篡改/未知模型与强度、跨项目/名称错配、重复/不确定投递、环境不能授权 Mock |
| Desktop Safety / recovery / senders | PASS | 19 Python Mock tests；未授权写入拒绝、单次授权、来源、逐字/空白不符拒绝、缺编辑器不得新建会话、finally close |
| E2E Workflow | PASS | 隔离安装中 4 tests/pass，0 fail/skipped；与 npm test 有重叠，不相加 |
| 干净安装 | PASS | 全新临时目录 npm ci、typecheck、build、111 tests、4 E2E、样例配置与 compiled Demo；不接触真实 Agent，结束清理 |
| 基础安全/规范 | PASS | 工作树及全部 refs 历史模式扫描；忽略正负例、链接、SVG/XML、79 打包文件，私密路径 0 |
| npm audit | PASS | 声明的 3 个开发依赖，0 已知漏洞；不代表穷尽供应链风险 |
| 远端 CI | PASS | [运行 38038222861](https://github.com/wynter-yaxley/agent-control-bridge/actions/runs/38038222861)，commit `6fd49a6c05b2600d8fcf54d04a4ffdb57d5e7e9f`；core (ubuntu-latest)=success；core (windows-latest)=success |
| 真实桌面/模型/飞书/MSIX 恢复 | NOT_VERIFIED | 本轮不启动或重启真实 Agent、不接管输入、不调用付费模型 |
| Lint | SKIPPED | 未配置 Lint，不算 PASS |

本机第一次直接运行 check 因 PATH 无可用 Python 失败；指定已安装解释器后重跑 PASS，不安装系统依赖或改全局 PATH。最新云端 Windows 为 111 pass/0 fail/0 skip；Linux 为 108 pass/0 fail/3 skip（总数 111），两平台 19 项桌面 Mock 和 4 项隔离 E2E 均通过。Linux 的 3 项 Windows 专属身份/ACL 探针明确 SKIPPED，不计通过。详见 [机器可读结果](VALIDATION.json)。

历史 CI 失败保留：

- [38035627311](https://github.com/wynter-yaxley/agent-control-bridge/actions/runs/38035627311)：当时 106 Node 测试；Ubuntu 103 pass/3 skip，全流程通过；Windows 除干净安装外通过，安装探针超时且清理 EPERM。已修复目录别名 CLI 空输出、流式诊断及仅自建子树的有界清理。
- [38036563133](https://github.com/wynter-yaxley/agent-control-bridge/actions/runs/38036563133)：当时 107 测试；Ubuntu 全流程通过，Windows 普通测试通过，隔离安装 ACL 助手超时。保留必要 OS 环境并新增受控建库探针。
- [38037360296](https://github.com/wynter-yaxley/agent-control-bridge/actions/runs/38037360296)：111 测试；Ubuntu 全流程通过，Windows 110 pass/1 fail（新增隔离 ACL 探针），后续步骤 SKIPPED。已改纯 .NET/SID ACL 路径、去掉隐式模块/账户名解析，增加固定阶段诊断；最新运行独立列于表内，不把失败算通过。

## 5. 安全检查

在本次已覆盖的当前公开文本与所有 Git refs 历史模式检查范围内，未发现能够确认的真实机密泄漏。仅基础模式扫描，不能排除未知秘密、私密业务文本或外部应用内部数据。未读取浏览器 Profile/Cookie/Token、无关进程或系统凭据，认证只交由已有合法工具内部复用。

业务 SQLite/WAL/SHM、日志、个人配置、缓存、Profile 和会话文件不跟踪、不打包；原审查保持不变。12 个桌面原文件经用户确认具原创 MIT 发布权，未把来源未知第三方代码重新授权。

桌面默认不写、不接管物理输入；编辑焦点风险须宿主单次批准。Prompt 内容逐字匹配，原始要求/自报来源/手工文件不能授权生产 Codex。普通执行者不能独立验收或写最终成功；holder/instance/attempt/version CAS 和事务故障回归通过。同一 OS 身份可修改宿主代码/策略/数据库的恶意代码属于可信宿主边界，不宣称沙箱隔离。

真实业务 DB SHA-256 仍为 `320fb10bf1961a7af329292961b9cd77184fb91b84cf3fcb91f3d1f344ab5360`，与开发基线一致，未迁移或写业务数据；仅临时库验证。Windows ACL 失败只输出固定阶段/错误分类，不输出原始异常或身份。

## 6. 迁移清理结果

12/12 原文件完整清点、迁移变换与目标 hash 核验；12/12 原始 hash 一致的外部持久私有备份已保留，未入 Git。远端源码完整比对后，仅逐个删除已确认归属的原文件，再删除空目录；旧 `D:\agent-tools` 已不存在。删除后原 16 项 Mock 已通过，本次新增保护后在新路径 19 项再次通过，无旧目录运行依赖，Python 缓存已清理。

根目录 `codex-audit-chat-full.txt` 的归属及归档许可仍待用户确认，保留原位，不读取内容、不移动/删除、不入 Git。其他无关目录及系统文件不删除。因此不能宣称 D 盘所有残余已清空。此为开发收尾事项，不写入使用者规范。

## 7. 遗留问题

1. **生产链路边界**：尚缺可靠验证真实 ChatGPT 模型/强度/会话及安全投递的适配器，自动生产链路默认拒绝。真实 GPT-6/High、桌面焦点、双向投递、飞书送达、MSIX 恢复 NOT_VERIFIED；不靠文字声明伪造完成。
2. **CI**：按第 4 节实际查询结果判断；若最新 Windows 未通过，仍是交付门禁未通过，不能用本地通过替代。
3. **数据与部署**：真实库迁移、备份恢复/RPO/RTO/保留策略未演练；Linux 跨 uid 可写独立验收部署未提供，当前仅单用户核心 CLI 与 Demo。
4. **清理**：根目录聊天导出归属未确认；不能无条件删除。多项目资源规范已有，但自动资源调度器未实现。
5. **通知与版本**：本地去重记录不是用户送达证明或无条件时延 SLA；正式版本 tag/GitHub Release 留待独立验收，package.private 只防意外 npm 发布。

## 8. Hermes 独立验收建议

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:desktop
npm run check
npm run test:install
```

重点对抗：pi `--by user` 冒充、双领取恰一成功、事件故障全回滚、旧 holder/instance 拒绝、执行者直接 SQL 成功拒绝、来源/模型/会话伪造、跨项目投递、空白篡改、投递不确定不重发、无授权前台操作拒绝、导出覆盖保留原 hash。检查 tasks/caller/review-boundary/prompts/topology/watcher/migrations/permissions 与 desktop_common/senders；核对独立 CI、main/tree、DB hash 和原始备份。

真实桌面、模型、外部消息单列授权验证，不在 Mock PASS 范围内。独立报告采用 [结论 / 证据 / 遗留模板](../ACCEPTANCE_TEMPLATE.md)。完整 24 项原问题整改见 [REMEDIATION](REMEDIATION.md)。

## 9. 最终状态

**PARTIALLY_DELIVERED**。已实现内容待 Hermes 独立验收；Codex 未将任务设为 SUCCEEDED。公开源码与开发测试不等于生产外部链路验收。
