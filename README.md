# Agent Control Bridge

[English](README_EN.md) · [综合代码审查](docs/audit/CODE_AUDIT_REPORT.md) · [修复与待验收记录](docs/audit/REPAIR_STATUS.md)

一个 TypeScript / Node.js / SQLite 本地控制桥。目标是让部署在飞书上的智能体 **Hermes** 实时查看 **Codex** 和 **ChatGPT（Windows 桌面 UWP 应用）** 的工作流，让三者协同开发，并向用户汇报进度。当前版本提供任务台账、安全状态转换、本地状态快照和手动交付物导入；完整实时协作仍是目标。

## 需求背景与角色

用户在不同窗口、会话和智能体之间工作，容易丢失任务进度、下一步提示词和验收责任。控制桥需要把“观察到的状态”“执行者报告完成”和“独立验收通过”分开记录。

| 参与者 | 目标职责 | 当前边界 |
|---|---|---|
| ChatGPT | 查看项目进度，生成、输出 prompt；提示词经桥接中转给 Codex 继续开发 | 支持官方 JSON 导出和手动 Markdown 交付；尚无自动读取云端对话、发送 prompt 的通道 |
| Codex | 按 prompt 开发代码，提供可审查的交付物 | 可读取本地项目、会话元数据；后台执行过程不可见 |
| Hermes | 中枢与桥，读取双方状态、双向中转提示词，实时向飞书用户汇报进度，并独立验收 | 当前有状态读取和任务 API；飞书消息发送、持续订阅和自动双向中转尚未实现 |
| 用户 | 决定授权范围，检查交付，批准后续 GitHub 同步 | 授权不会由模型文本或 `--by` 字符串产生 |

## 架构

```text
飞书用户 <----目标：进度汇报/指令----> Hermes（中枢、独立验收）
                                      |
                             可信宿主 / 本机授权策略
                                      |
ChatGPT Windows UWP --手动导出--> CLI / Agent Control Bridge <--本地元数据-- Codex
           ^                          |                              ^
           +----目标：双向 prompt 中转（尚未实现）----------------------+
                                      |
                    CallerContext → TaskStore → SQLite
                       身份/实例      CAS/事务    任务/事件/审批/审计
```

`caller.ts` 产生绑定可信身份的不可序列化 context；CLI 从操作系统身份和固定部署策略加载它。`tasks.ts` 执行业务校验、租约和状态转换。`db.ts` 管理短事务、版本迁移、WAL、外键及权限；`permissions.ts/.ps1` 收窄 NTFS ACL。其他读取模块提供快照，不能把 Agent 输出变成命令或授权。

SQLite 是本地持久化台账，不负责启动模型或调度真实 Agent。事件和审计与任务写入一起提交。它仍是单机单文件依赖，不提供分布式一致性。

## 任务状态机与铁律

**执行者不能自封 `SUCCEEDED`；独立验收是唯一入口。** 验收者必须拥有受信任的 reviewer capability，且操作系统 principal 与本次 attempt executor 不同。Hermes 自己执行的任务也不能由 Hermes 自验。

```text
QUEUED --原子 claim--> RUNNING --finish--> WAITING_APPROVAL
                         |                    | verify(独立身份)
                         |                    +----通过----> SUCCEEDED
                         |                    +----不通过--> FAILED
                         +----block----> BLOCKED --resume--> RUNNING
                         +----fail-------------------------> FAILED
FAILED / UNKNOWN --授权 reviewer 重新排队--> QUEUED
WAITING_APPROVAL --同一 holder resume--> RUNNING
QUEUED / RUNNING / BLOCKED / WAITING_APPROVAL / FAILED --授权 cancel--> CANCELLED
```

领取同时写入状态、holder、instance、attempt 和租约。变更必须携带当前 `version`；SQL 条件同时匹配状态、版本、所有者、实例及 attempt，且影响行数必须是 1。旧版本、重复回调、其他实例的 finish/cancel/renew 都会拒绝。领取失败没有部分 owner 写入。

租约过期只产生告警，不推断成功。finish、renew、resume 要求有效租约；holder 可取消自己的过期任务。verify 不依赖执行者仍在线。自动接管、执行中断和超时强制终止尚未实现。`SUCCEEDED` 和 `CANCELLED` 不再转出。

## 运行环境与 CLI

需要 **Node.js >= 24.19.0**；本轮验证环境为 Windows、Node 24.19.0。使用 Node 内置 SQLite、TypeScript stripping 和测试框架，无第三方运行依赖，不需要安装依赖。类型剥离不等于 TypeScript 类型检查。

```powershell
Set-Location 'D:\Agent control bridge'
node --experimental-strip-types src/cli.ts help
# init 仅初始化/迁移 Schema，不启动 Agent，不创建演示任务
node --experimental-strip-types src/cli.ts init
node --experimental-strip-types src/cli.ts task-create -t '实现提示词交付' -k dev -e pi
node --experimental-strip-types src/cli.ts task-list --status QUEUED
# 将 <taskId> 和版本替换为真实查询结果
node --experimental-strip-types src/cli.ts task-claim <taskId> --version 0 -e pi
node --experimental-strip-types src/cli.ts task-renew <taskId> --version 1 --lease 600
node --experimental-strip-types src/cli.ts task-finish <taskId> --version 2 -e pi
node --experimental-strip-types src/cli.ts task-show <taskId>
# 只能由已经配置的独立 reviewer 身份调用；普通 pi CLI 会拒绝
node --experimental-strip-types src/cli.ts task-verify <taskId> --version 3 --pass
node --experimental-strip-types src/cli.ts chatgpt-import 'D:\exports\conversations.JSON'
node --experimental-strip-types src/cli.ts markdown-import 'D:\handoff\prompt.md' --task <taskId>
```

示例中的 `<taskId>` 是占位符，执行前必须替换；不应把带尖括号的占位符直接交给 PowerShell。`--pass` / `--fail` 必须恰好一个；executor、status、租约和版本均校验。`-e` 是任务分配/身份一致性断言，不能改变 caller。`--by` 仅作身份断言，不能授权，建议省略。错误输出到 stderr，退出码：1=I/O，2=参数，3=授权/所有者，4=状态/版本冲突。

查询、help 不迁移或写入数据库。`status` / `chatgpt-status` 会访问公开服务状态页；其他核心任务命令不调用模型。导入接受大小写 `.json`，生成新的 `.conversations.md`，拒绝同路径、别名及任何已有输出；没有覆盖开关。Markdown 内容是数据，不会执行其中的 prompt 或 shell 文本。`codex-fork-request` 只记任务与审批，不执行 fork；审批也不执行真实控制操作。

## 安全模型与部署授权

默认 CLI principal 来自 Windows SID（非 Windows 为 UID），instance 为 `local-cli`，executor 为 `pi`，**无验收权限**。不接受 CLI 或环境变量提供角色、SID、实例或 reviewer 权限。可信宿主可以持有自己的 `CallerAuthority` 并注入 context；普通字符串、JSON 对象或其他 authority 的 context 一律无效。

部署时由目录所有者维护固定路径 `config/caller-policy.json`，格式见 [示例](config/caller-policy.example.json)。示例未启用，须填写实际 SID，且执行者与验收者使用不同 OS principal。策略是授权配置，不含 Token 或密码；未列入已启用策略的 principal 拒绝调用。目录所有者还需为这些明确授权的 SID 配置项目目录 ACL。不要给普通执行者 reviewer 权限。

Windows ACL 仅保留当前主体、既有所有者、SYSTEM、Administrators 及明确授权 SID；拒绝 Everyone、Authenticated Users、Users 等宽泛主体。数据库目录在创建 DB/WAL/SHM 之前收窄权限，数据库文件也显式收窄；权限失败则拒绝打开。Unix 使用目录 0700、文件 0600。没有管理员提权，不修改系统执行策略。身份及权限辅助调用使用固定 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，PATH 不能替换它；非标准 Windows 系统目录暂不支持并拒绝继续。

桥不主动读取、存储或使用 API Key、Cookie、Token、密码、浏览器认证数据库或 Agent 凭据，不调用付费模型 API。只查询元数据和用户主动提供的交付物。手动导出的会话可能本身包含秘密，导入前必须脱敏；当前没有完整内容脱敏或数据库加密保证。审计和导入文件应保持私有。

**边界：同一 Windows 账户中的任意代码和直接数据库写权限属于同一信任域。** `CallerContext` 不是 OS 沙箱；拥有项目所有者或管理员权限的进程能修改策略、代码和 SQLite，无法靠 CLI 参数校验隔离。需要强隔离时使用独立 OS 账户、受控宿主及明确 ACL；当前没有独立 IPC 认证服务。实例区分由可信宿主/策略提供，同一个 `local-cli` 不是多个独立 Agent 实例。

## 诚实边界

- Codex 项目/thread 元数据不是实时执行进度，不能看到后台工具执行或完整会话内容。
- ChatGPT 进程、窗口、版本或缓存修改时间不能证明某个任务正在运行；不读取缓存中的认证内容。
- 原有观察模块仍含固定 Windows/WSL 路径，通用路径配置和状态新鲜度仍待改进；查询失败或旧快照不能当成真实在线状态。
- 尚无飞书机器人消息适配器、自动 prompt 投递、持续监控、真实 Agent 启停、可靠超时终止或分布式调度。
- 会话导入的数据库事务与输出文件不能跨进程崩溃形成完全原子提交；普通失败会回滚 DB 并清理本次新文件，已有文件永不覆盖。
- 旧 Schema 会在下一次写入入口自动升级到 v1，不改变旧业务字段。旧活动任务没有可信 holder/attempt，finish/cancel/verify 会拒绝；须由独立人员审查后安排恢复，当前不自动认领历史身份。

## 测试、审查与交付状态

```powershell
npm test
npm run test:e2e
# 没有 npm 时直接执行相同脚本，无需安装包
node scripts/test.mjs
node --experimental-strip-types src/e2e.ts
```

测试使用 `node:test`，发现 `test/*.test.ts`，测试数为 0 会失败。核心测试使用内存数据库；并发、迁移、权限和 CLI e2e 使用独立临时目录、合成数据，绝不使用原始 `data/bridge.db` 或真实 Agent。e2e 中的成功状态只属于合成测试任务。

本次本地回归结果、修复编号、文件清单和验收项见 [REPAIR_STATUS](docs/audit/REPAIR_STATUS.md)。[原审查报告](docs/audit/CODE_AUDIT_REPORT.md) 保留历史结论，不表示所有审查问题已关闭。当前交付状态是 **待 Hermes 验收**。验收前不初始化 Git、不 commit、不 push；收到 Hermes 验收和单独 GitHub 同步指令后再执行同步。项目尚未指定开源许可证，发布前需明确。
