# Agent Control Bridge 综合代码审查报告

## 1. 审查执行摘要

**总体评价：这是一个可用作本地任务台账的早期原型，尚不适合作为相互不信任的多个 Agent 共用的可靠控制边界。** 合法任务流程、禁止直接置成功和租约过期不误报成功已有实现；独立验收身份、任务所有权、并发领取和状态/事件事务仍有实质缺口。当前源码没有实际派发、停止或恢复 Agent 的控制执行器，不能把台账中的 RUNNING/CANCELLED 当作真实执行状态。

- 审查日期：**2026-10-10，Asia/Tokyo**；证据获取和验证均在该日完成。
- 实际项目：`D:\Agent control bridge`。聊天工作目录是另一个目录，所有源代码定位以实际项目为准。
- 全量范围：初始 **16 个文件、160,483 字节**；其中 **11 个 TypeScript 文件（1,237 行）**、`schema.sql`（110 行）、`package.json`、README、开发调研文档和 `data/bridge.db`。
- 业务数据：只读检查 8 张业务表、50 条记录、283 个文本单元格；不展示业务正文、真实凭据或用户会话标识。
- 方法：逐文件审查、调用链与信任边界追踪、参数化查询检查、规则/熵机密扫描、SQLite Schema/完整性/外键检查、Windows ACL 读取、源文件与数据库 SHA-256 基线比较、隔离故障注入及双连接竞争验证、官方公共仓库和公开安全文档对标。
- 项目中**不存在** `.git`、`.gitignore`、`tsconfig.json`、锁文件、`node_modules`、Lint 配置、CI 配置、`*.test.ts`。`package.json` 没有第三方依赖声明；缺少 lockfile 在这个零 npm 依赖原型中不是独立供应链漏洞。
- 检查用运行时：Node **v24.19.0**，内置 SQLite **3.53.3**；只读 Python 检查器使用 SQLite **3.53.1**。这些是本次检查器版本，不能推断实际 Agent/WSL 服务使用相同版本。

| 严重度 | 数量 | 判定说明 |
|---|---:|---|
| P0 / Critical | 0 | 未确认真实机密泄漏、远程未授权 RCE 或高权限控制链 |
| P1 / High | 4 | 身份边界、目录/数据库 ACL、并发领取、关键写入原子性 |
| P2 / Medium | 14 | 导入覆盖、CLI 合约、租约、审批、输入、SQLite 和测试等实际风险 |
| P3 / Low | 4 | 迁移、输出注入、文档可复现性和未来提交防护 |
| P4 / Informational | 2 | 适配抽象与小规模运维改进 |
| **合计** | **24** | 第 10 节是唯一计数来源，其他章节引用相同编号，不重复统计 |

**实际执行：** 原 test 脚本对应的 Node 命令退出 0，但发现 **0 个测试**；现有 `e2e.ts` 的隔离副本保留全部断言，唯一数据库路径与外部文件/进程 Mock 后 **20 通过、0 失败**；16 组审计探针和补充验证确认了缺陷及部分已有防护。测试通过不代表安全验收通过。

**未执行及限制：** 没有安装 TypeScript、ESLint、Gitleaks 或 TruffleHog；未安装工具、未运行自动修复，因此正式类型检查和 Lint 未执行。Git 命令两次均确认目录不是仓库，无法取得原有 Git 修改、跟踪名单或历史提交；历史机密扫描覆盖率为“不可取得”，不是“没有历史泄漏”。未运行原工作区的 start/CLI/e2e、真实 Agent、模型 API、实际 fork/resume/取消命令、CDP 或外部飞书/WSL 工具。外部对标只读取公开资料和源码，未运行其模型或集成测试；未向网络提交本地内容。

## 2. 项目结构与架构分析

### 2.1 目录与模块职责

```text
D:\Agent control bridge
├─ package.json                    ESM、Node 原生 TS 擦除、CLI/自检/测试脚本
├─ README.md                       项目目标、状态机、CLI 和完成度说明
├─ src/
│  ├─ types.ts                     TaskStatus/Executor 类型和转换邻接表
│  ├─ schema.sql                   8 张业务表与 3 个业务索引
│  ├─ db.ts                        可写连接、建目录、WAL/外键、建表、时间/UUID
│  ├─ tasks.ts                     任务、事件、审批、审计、租约告警
│  ├─ cli.ts                       21 个命令分支、手工参数解析和直接 SQL
│  ├─ index.ts                     写默认数据库的演示自检，不是常驻服务
│  ├─ codex.ts                     本地全局元数据读取及项目/会话同步
│  ├─ codex-ops.ts                 构造 fork/resume 参数；没有执行器
│  ├─ pi.ts                        配置/锁文件推测状态
│  ├─ hermes.ts                    包/历史记录与 pgrep 进程匹配
│  ├─ chatgpt.ts                   公共服务状态、桌面元数据、人工导出导入
│  └─ e2e.ts                      顺序自测，固定 /tmp 库，部分依赖真实环境
├─ data/bridge.db                   86,016 字节，8 表，运行台账
└─ docs/[HOST]-research.md  外部桌面自动化方案和声称的实测记录
```

没有 API 服务、网关、IPC 监听端点、消息队列、守护循环、Provider 注册表、派发执行器、进程管理器、配置加载器或数据库迁移模块。没有 `.env` 文件或显式 `process.env` 读取。源码中的执行者联合类型是四个固定名称，增加新执行者需要修改类型和 CLI，而不是注册插件。

### 2.2 架构关系图与信任边界

```text
本地用户 / 外部 Agent / 可能的 Hermes 调用者（外部集成未交付）
                    │ CLI 参数；身份名称可自行指定
                    v
                cli.ts ──────────────────────┐
                  │                          │ 直接 SQL
                  ├─ TaskStore(tasks.ts)      │ projects/deliverables/audit 查询
                  │    ├─ types.ts 规则       │
                  │    └─ db.ts 时间/UUID     │
                  ├─ codex.ts ── 读取外部 JSON ── 同步 projects/sessions
                  ├─ pi.ts ──── 读取外部锁/设置（不执行 Pi）
                  ├─ hermes.ts ─ pgrep（只查询，不启动 Hermes）
                  ├─ chatgpt.ts ─ 文件导入 / 固定 curl / 固定 PowerShell 查询
                  └─ codex-ops.ts ─ 参数对象（无实际 fork/resume 调用）
                                            │
                  db.ts ─ Schema 初始化 ─────┘
                    │ 可写 DatabaseSync；每个 CLI 进程都有独立连接
                    v
    SQLite：projects / sessions / tasks / events / approvals /
            deliverables / audit_log / alerts

SQLite 状态变化 ──X──> 真实 Agent 控制/取消/恢复
                      当前源码没有这条执行链
```

运行时导入图无循环依赖。类型导入不会运行；`tasks.ts`、`codex.ts`、`chatgpt.ts` 依赖 `db.ts` 辅助函数，入口依赖所有具体模块，依赖方向基本清晰。`chatgpt.ts` 同时承担网络查询、桌面探测和导出写文件，职责偏多；CLI 同时承担展示、参数解释和持久化业务，耦合较高。WAL/外键初始化同时写在 `db.ts:24–25` 和 `schema.sql:7–8`，存在少量重复，不构成独立漏洞。

### 2.3 主要执行链路与生命周期

1. `task-create` → `createTask()` → tasks 插入 QUEUED → created event → audit。没有执行调用。
2. `task-claim` → `transition(RUNNING)` → 再写 owner/lease → claimed event。状态改变和领取并非一个原子动作。
3. `task-finish` → WAITING_APPROVAL → executor_finished event。未核验实际工作或所有者。
4. `task-verify --pass/--fail` → 检查字符串 `hermes/user` 和 WAITING_APPROVAL → SUCCEEDED/FAILED → 两条 event 与 audit。验收由显式输入决定，没有自动质量验证器。
5. 失败后只有库 API `transition(QUEUED)`；CLI 没有返工命令。取消只写台账，未向 Agent 发取消信号。
6. `sweep` 查过期 RUNNING，逐任务查未确认告警并写 alert/event；没有定时器、心跳、续约、自动重领或重启恢复执行。

Codex 数据流是外部全局 JSON → 内存映射 → projects/sessions UPSERT；只存元数据，`workspace` 没有持久化，state 固定 unknown，不能得到实际任务进度。Pi/Hermes 状态仅返回对象/打印，未存入事件或 sessions。ChatGPT export → sessions 元数据 + 邻近 Markdown 文件；消息正文不写 SQLite。`markdown-import` 只登记路径与截短 hash，不建立 ChatGPT session，也不复制/保存正文；应避免把它宣传成可查询会话同步。

SQLite 承担本地持久台账、查询和审计；不是协调锁服务，也没有数据库事件消费者。数据库损坏、路径失效、锁竞争会影响所有台账命令，是本地单点。当前 WAL + 单条 SQL 的原子性有价值，但不会自动保证整个业务操作的原子性（DB-001）或读后写的排他性（STATE-001）。

### 2.4 当前设计优点与长期维护判断

优点：零 npm 第三方依赖、ESM 导入简洁、任务状态使用字面量联合类型、值参数化、外键和基础索引、拒绝直接 SUCCEEDED、离线不冒充完成、部分外部读取失败返回未知。代码量小，适合渐进改进。

长期风险：CLI 的“读命令”也可写初始化；身份来自参数；多连接没有 CAS/事务；导入缺少输入契约；外部路径是单用户 WSL 常量；各观察器返回不同形状且没有 freshness/error 统一语义；审批与真实执行分离。应先完善可靠任务台账，再新增一个窄的适配/授权接口。当前无需搬入分布式运行时、完整 DAG 引擎或大型消息总线（ARCH-002）。

## 3. 代码质量与工程规范审查

| 检查项 | 实际证据与结论 |
|---|---|
| any | 11 个 TS 文件字面 `any` 计数为 0；不是主要问题 |
| strict / 编译 | 无 tsconfig、typecheck/build/lint 脚本或 TS 编译器。Node 类型擦除不会做类型检查，官方说明见 [N1] |
| 类型断言 | `Task`/SQL 行断言、CLI Executor/TaskStatus 断言、外部 JSON 断言没有运行时验证；非法 executor 实测可落库 |
| null/undefined | `getTask()` 返回 null；多数操作处理不存在任务；CLI 的缺少 id 可传 undefined 触发底层异常；`JSON.parse(null)` 等结构不合法导入可抛出未处理异常 |
| 数据库绑定类型 | `listTasks()` 用 `unknown[]` 传 SQL 绑定。是否造成 tsc 诊断待正式编译器验证，本报告不把未运行的类型检查写成失败 |
| 同步/异步 | 主要是同步 API，没有复杂 Promise 链或 Promise 泄漏证据。同步文件/网络子进程/SQLite 会阻塞单次 CLI；综合状态依次查询、无法取消 |
| 超时 | curl `--max-time 6` + exec timeout 8s；PowerShell 两次各 10s；pgrep 3s。实际任务没有 timeout/AbortSignal；读取文件与结果大小未限量 |
| 错误处理 | 状态机 `{ok,error}` 与 JSON `{error}` 混合；SQLite/写文件异常向上抛；Pi/Hermes catch 丢弃错误原因；大量 CLI 错误打印 stdout 后 exit 0 |
| CLI 参数 | 手工 indexOf；缺值、重复选项、未知选项、状态/executor 不验；`-k` 帮助与实现不一致；两个验收 flag 同时出现按 pass 执行 |
| Windows | 空格路径在审计中正确使用 LiteralPath/参数数组；项目自身大量 `/mnt/c`、`/home`、`/tmp` 和 `pgrep` 不是原生 Windows 可用配置 |
| 测试/发布 | 原 test 实测 0 个测试；e2e 不是 node:test 测试且没有接入该脚本；无 CI、发布/构建检查；`private:true` 限制 npm 发布，不提供运行保护 |
| 资源关闭 | 入口不显式 db.close；短命 CLI 可由进程退出释放，库初始化失败与未来长运行场景应有 finally/关闭合约，不夸大为当前已证实泄漏 |
| 命名/注释 | “claimed_by 防双写”“唯一入口”“身份校验可安全置成功”均超过实际保证；FAILED 在邻接表可取消，但 cancel() 将其当终态拒绝，需要明确 API 差异 |

正式 TypeScript/Lint 检查未执行，是工具与配置限制。未替项目创建 tsconfig、安装开发依赖或修改 package。Node 可运行并不等价于类型安全。相关问题：CODE-001～005、TEST-001、DB-003、ARCH-001/003。

## 4. 任务状态机专项审查

### 4.1 状态与实际转换表

证据：[types.ts:3](<D:/Agent control bridge/src/types.ts:3>)、[types.ts:82](<D:/Agent control bridge/src/types.ts:82>)、[tasks.ts:66](<D:/Agent control bridge/src/tasks.ts:66>)。此表展示业务 API 行为，不表示 SQLite 直接写入也受限。

| 起点 | transition() 可接受终点 | 特殊 API / 限制 | 实现状态 |
|---|---|---|---|
| QUEUED | RUNNING、CANCELLED | claim 写租约；不派发执行 | 已实现但领取竞态/身份有缺陷 |
| RUNNING | WAITING_APPROVAL、BLOCKED、FAILED、CANCELLED | executorFinished 不检查所有者 | 已实现但有缺陷 |
| WAITING_APPROVAL | RUNNING、FAILED、CANCELLED | SUCCEEDED 虽在邻接表中，transition 一律拒绝；只能 verify(pass) | 已实现但验收身份和并发有缺陷 |
| BLOCKED | RUNNING、FAILED、CANCELLED | claim 也可领取；未限制原 holder | 已实现但有缺陷 |
| SUCCEEDED | 无 | 重复 verify/cancel 被拒绝（顺序调用实测） | 已实现且有顺序验证证据；竞争边界未保障 |
| FAILED | QUEUED、CANCELLED | cancel() 拒绝 FAILED；库 transition 可 CANCELLED；CLI 无 requeue | 已实现但 API 差异/返工残留元数据 |
| CANCELLED | 无 | 无真实停止执行链 | 已实现台账终态；执行取消尚未实现 |
| UNKNOWN | QUEUED、RUNNING、FAILED、CANCELLED | 没有进入 UNKNOWN 的正常创建/转换入口 | 邻接规则已实现；来源/恢复政策尚未实现 |
| 任意合法状态 | SUCCEEDED 直接转换拒绝 | verify 要 WAITING_APPROVAL、verifier=hermes/user | 已实现；不等于身份认证 |
| 不在表内的状态转换 | 拒绝 | 读取非法 DB 状态也会拒绝后续转换 | 已实现 API 拒绝；DB 无 CHECK |

**8 个定义状态中没有 TIMEOUT 状态。** 未实现自动超时、自动重试调度、指数退避、失败原因统一写入；`Task.error` 从未在业务写入中被更新。UNKNOWN 不是断线后的自动状态。

### 4.2 并发、幂等性和所有权

两个独立 Worker/SQLite 连接在同一 QUEUED 快照后同时继续 `claim()`，两者都返回 ok，owner 最终被后写覆盖。测试使用 barrier 只固定线程调度，调用的是未修改的 TaskStore；为避免锁冲突遮蔽竞争，测试连接设置 2 秒 busy_timeout。没有任务版本、`WHERE status=原状态`、rowsAffected 判断、租约 fencing token 或跨进程认领排他机制（STATE-001）。单进程同步代码串行不能代表多 Agent 多进程安全。

重复成功 verify 在顺序场景被拒绝，这属于重复拒绝，不是“返回同一结果”的幂等合约。events 没有幂等键；审批可以重决；告警去重是 SELECT 后 INSERT，竞争时可重复。`claimed_by` 只存 provider 名称，无法区分同一 provider 的两个实例，也没有校验 finish 的调用者（SEC-001、STATE-003）。

### 4.3 原子性、故障恢复和一致性

故障注入只发生在临时数据库：事件 INSERT 被触发器拒绝后 claim 抛异常，但 task 已 RUNNING、claimed_by=null、没有状态事件（DB-001）。进程在同一窗口退出也可能留下类似半完成操作；本次未杀死任何真实进程。没有 outbox、补偿、恢复扫描器或将业务更新/审计统一提交的事务。

租约过期仅告警并维持 RUNNING 是正确的保守原则；但没有续租、显式恢复、过期重领和审批等待超时，RUNNING 过期后再 claim 被拒绝，可能长期卡住（STATE-002）。失败返工保留旧 started_at/owner/lease，没有 attempt 边界。task 查询从 DB 读取当下台账；它不是实际 Agent 的实时状态，外部同步缺少删除/归档和 freshness（CODE-005）。取消台账并不停止工作（控制能力尚未实现）。

审计 records 有 actor/action/detail 和事件时间；关键 transition 不都写 audit，审计不是防篡改存储，持有可写 DB 的人可修改。没有基于事实的自动验收，只存在调用者明确指定 pass；验收身份伪造会将未独立验证的任务报告为成功，本次仅用合成任务确认。

## 5. SQLite 数据层专项审查

| 范围 | 检查结果 |
|---|---|
| 实际 Schema | 8 表、3 个显式业务索引；与 schema.sql 定义一致；另有 SQLite 自动主键索引/sequence |
| 主键 | 多数 `TEXT PRIMARY KEY` 未显式 NOT NULL、未 STRICT/WITHOUT ROWID；隔离实测可插入 NULL project id（DB-003） |
| 外键 | projects/sessions/tasks/events/approvals/deliverables 有部分 FK；alerts.task_id 没有 FK。只读 foreign_key_check 为 0 条违规 |
| CHECK / 唯一性 | status、executor、source、decision、severity 无 CHECK；无 (source,external_id) unique；Session id 跨 Provider 冲突实测（DB-004） |
| 索引 | tasks(status)、tasks(project_id)、events(task_id)；没有 source/last_observed/租约或未确认告警索引。当前 50 条数据未观察到性能故障，额外索引是后续建议（DB-006） |
| SQL 注入 | 用户值通过 ? 参数；动态 WHERE 由固定字符串组成。合成 SQL 样文本按字面存储，任务表仍存在；未发现可达 SQL 注入 |
| 事务 | 无 BEGIN/COMMIT/ROLLBACK 业务包裹。单 SQL 原子，完整 create/claim/verify/导入/同步不原子（DB-001） |
| 并发锁 | WAL 不提供多 writer 并行。createDb 未设 busy_timeout；临时连接实测 0ms，另一个 writer 锁下约 1ms 报 locked（DB-002） |
| WAL 与外键 | db.ts 和 schema.sql 设置 WAL/foreign_keys ON。原 DB 头 read/write version=[2,2] 支持 WAL 格式；无 wal/shm sidecar |
| 审计连接解释 | immutable 只读连接报告 journal_mode=delete、foreign_keys=0，**不能据此判定应用没有启用 WAL/外键**；这些是审计连接行为/连接级设置 |
| 持久性/损坏 | 只读 integrity_check=ok、page_count=21、freelist_count=0。未做真实断电、损坏注入或写恢复，不宣称已验证崩溃安全 |
| 版本/迁移 | user_version=0，只有 CREATE IF NOT EXISTS；不改变已有表结构，没有版本兼容检查（DB-005） |
| 连接生命周期 | 默认路径固定在项目 data；每条 CLI 先开可写连接且建表；没有 readOnly 选项/显式关闭路径（ARCH-001） |
| 敏感存储 | 无 token/password 专用列；title/note/reason/payload/detail 会保存任意文本，且未脱敏（SEC-003） |
| 文件权限 | 数据库继承 Authenticated Users 的 Modify，Users 的 ReadAndExecute（SEC-002）。未修改 ACL |
| 保留/恢复 | 无日志轮转、retention、备份/恢复程序；无 schema 版本档案。没有运行 VACUUM/checkpoint/backup 等生产写操作（DB-006） |
| Windows 多进程 | 双连接领取竞争、writer 锁已在原生 Windows 的带空格隔离路径复现；没有在原 DB 并发写入 |

官方 SQLite WAL 文档描述的多连接 WAL-reset 缺陷已在 3.51.3 及后续修复；本次 Node 内置 3.53.3 不应被误报为该已修复问题。[S1]、[S4] 这不能证明未检查的 WSL Node/SQLite 版本安全。`>=22.5.0` 还接受早期版本，需在部署清单确定真实版本；禁止自动升级的要求已遵守。

## 6. 安全漏洞审查

### 6.1 分类覆盖与可利用性

| 安全类别 | 结论、攻击前提与保护边界 |
|---|---|
| 命令注入 / shell 拼接 / 任意命令执行 | execSync 使用固定 curl/pgrep/PowerShell 字符串；未找到 CLI/Agent 文本拼接到 shell 的链。CodexOp 的用户 thread/prompt 是数组值且未执行。没有确认 RCE |
| 参数注入 | buildFork/buildResume 无 thread-id 校验，未来执行器应防以 `-` 开头的参数；当前无执行 sink，列为待验证扩展风险，非已确认命令注入 |
| SQL 注入 | 有参数化保护；只执行合成输入验证，未发现注入 |
| 路径遍历 / 文件读写 | CLI 接受用户显式文件路径，不具有网络沙箱声明；本地操作任意授权文件不自动构成越权。ChatGPT 输出路径错误可覆盖输入/已有输出（CODE-002） |
| TOCTOU / Windows 路径 | exists/read 与 write 分开；可被可写目录中的重解析点/替换影响。未实测攻击，不列为确认漏洞；权限缺陷和安全写入策略分别见 SEC-002/CODE-002 |
| IPC / 本地接口 | 无监听 socket/HTTP/MCP/IPC；没有接口鉴权实现可审。外部飞书/CDP 组件不在源码，不能推断其授权 |
| 身份与权限 | verifier/actor/provider 名称可自行指定，finish 不校验 owner；ACL 允许本地认证用户改源码/DB（SEC-001/002）。不需要管理员权限，不等于远程无需授权 |
| 日志注入 | title/reason/外部名字未经控制字符转义写/打印，可伪造行或终端显示；不代表执行 shell（SEC-005） |
| 反序列化 / 原型污染 | 使用 JSON.parse，没有 eval/VM/不安全对象反序列化或递归合并。`countThreadsByProject` 使用普通对象作 id 字典，特殊键风险待验证；未确认全局原型污染 |
| 资源耗尽 / DoS | 同步无限量文件读取、JSON parse、全文 Markdown 拼接、查询 .all，缺大小/条数界限（SEC-004）；未运行大文件攻击 |
| 配置注入 | 无环境配置合并；DbOptions.schemaPath 是可信调用者的 SQL 文件选择，不通过 CLI 暴露，不按未授权 SQL 注入计 |
| 敏感泄漏 | 本次未找到真实 key；标题/note/reason/导出/错误/CLI 缺少脱敏和内容最小化（SEC-003）。见第 7 节 |
| 子进程环境 | 生产 execSync 默认继承 process.env、依赖 PATH/shell，有扩散与可执行文件替换前提；未检查进程真实环境，未确认凭据泄漏，需未来适配器收窄 env。[N3] |
| 依赖漏洞 | 无 npm 依赖需上传 lockfile 审计；检查公开 Node/SQLite 公告，不等于全量 CVE 证明。所查 Node 2026-07 公告修复线包含 v24.18.1，本次 v24.19.0 在其后；SQLTagStore 漏洞相关 API 本项目未使用。[N4] |
| 不可信 Agent 输出 / Prompt Injection | 当前只将名字、文本存 SQL/Markdown/打印；没有 LLM/自动解析任务指令/外部输出→shell 链，不能确认 prompt injection 控制执行。未来 relay 必须在工具边界验证身份和动作，不能靠提示词或字符串角色名授权。[O3] |
| 状态读取与执行授权 | 观察文件/进程不授予控制权；当前 API 不区分可信 caller 与 untrusted agent，直接按 actor 入库（SEC-001）。台账状态与真实运行状态混淆风险见 CODE-005 |

### 6.2 漏洞清单与优先处理

已确认重点为 SEC-001、SEC-002、STATE-001、DB-001、CODE-002；高可信风险为文本敏感落盘/输出和无输入资源上限。所有攻击路径、影响、保护缺口、修复和安全验收均逐条列在第 10 节。未执行真实越权、破坏性利用或外部认证探测。

文档建议 `--remote-allow-origins=*`、CDP 和 relay，且声称“零凭据泄漏”（开发文档:74–97）。项目没有这些脚本/端口配置，不确认实际开放端口。调试接口可控制已登录界面的风险必须另行审查，不能以“不读取 Cookie”直接推出安全；列入 ARCH-003 的外部集成待验证范围，**不把文档中的 P0 字样当作本次严重度**。

## 7. 机密信息泄漏专项审计

**在本次已覆盖的检查范围内，未发现能够确认的真实机密泄漏。** 这是有范围的检查结论，不是项目绝对安全或历史无泄漏的保证。

### 7.1 覆盖范围、方法与结果

| 范围 | 实际检查 | 结果与限制 |
|---|---|---|
| A. 源代码 | 11 TS + SQL 全量扫描与逐行审查；provider token、JWT、私钥头、Bearer、带凭据 URL、命名赋值、泛化 secret/token/password/pwd 字段和高熵串 | 未确认硬编码秘密。高熵候选仅 src/codex-ops.ts:8，为可执行文件安装路径/构建目录标识，人工确认不是凭据；未使用任何候选 |
| B. 配置 | package.json、所有隐藏/可见项目文件清单；不存在 .env/JSON/YAML/TOML 配置或示例秘密 | 15 个项目文本文件全部覆盖；外部 /home 和 .codex 设置未读取，避免越出范围 |
| C. Git | 初始/最终 git status 和 rev-parse；检查项目目录与父路径 | 非仓库，无法扫描任何提交/refs/删除内容；历史覆盖不可取得。`.gitignore` 缺失（SEC-006），没有已跟踪敏感文件证据 |
| D. 日志 | 无项目日志文件；审查 console、recordEvent、recordAudit、error 的所有写/读位置；audit_log/events 所有文本只读规则扫描 | 未发现真实凭据；合成 marker 可原样存事件/审计，短 malformed JSON marker 可进入错误字符串（SEC-003）。没有完整 header dump/环境 dump 代码 |
| E. SQLite | mode=ro&immutable=1；8 表/50 行/283 文本单元格 + 原文件字节模式扫描；仅元数据和统计输出 | 命名/格式规则未命中；无认证专用列。未做删除记录恢复、页面 carving、外部备份或历史 wal 恢复；原目录无 sidecar |
| F. 运行时 | 静态检查所有 child_process 调用、参数和默认 env 继承；未读取真实进程命令行、进程环境、系统凭据 | 不使用发现的秘密；未执行 Agent。实际父进程是否含敏感 env 待验证；三个观察器固定命令默认继承完整 env |
| G. CLI / JSON 输出 | task-show、audit、projects、status 和导入诊断的输出代码；隔离 CLI 合成数据验证 | 不存在统一 redactor；task JSON 可包含 title/error，audit 输出 detail；当前数据无确认秘密，防护缺口已确认 |
| H. 网络/第三方 | 唯一实际网络代码为固定公共状态页 GET，未带本地 payload/header/key；外部研究文档只作引用 | 未见本地秘密上传实现；没有执行真实状态页模块或付费调用。公共对标请求仅固定公共 URL，不含项目内容 |

扫描器为本地 Python 规则扫描，不输出命中值；高熵扫描只输出位置/长度。没有已安装 Gitleaks/TruffleHog，未安装。泛化扫描可识别常见赋值形式，但不提供厂商有效性校验，也不能保证识别短任意密码、编码/加密秘密、无标签随机 token 或已删除数据。数据库字段没有全量正文输出，报告没有复制含密钥配置。

### 7.2 泄漏问题与防护缺口登记

**确认真实泄漏清单：0 条。** 以下是保护缺口而非已泄漏凭据；不会给不存在的 key 编造类型、权限范围或有效期。

| 关联编号 | 位置 / 凭据类型 | 途径 / Git 历史 | 可能暴露范围 | 风险 / 优先级 | 轮换与清理 / 验收 |
|---|---|---|---|---|---|
| SEC-003 | tasks.ts:39、46、98、121–122、143、165；chatgpt.ts:159–161、199–206；cli.ts:80、266。任意被粘贴 token/key/password；**当前未确认存在** | 文本直接进 events/audit/标题/Markdown/错误；历史不可取得 | 能读 DB/导出/CLI 日志的人；SEC-002 扩大本地范围 | P2，短期优先 | 当前无凭据可轮换；若后续发现，先限制暴露并撤销/轮换，再清理当前库/导出/日志及备份。虚构 marker 多渠道验收必须不出现 |
| SEC-002 | 项目根目录与 data/bridge.db NTFS ACL；将来任意已存敏感文本 | 本地 Users 可读、Authenticated Users 可改；Git 不适用/不可取得 | 其他本地用户或其进程；不推断外网可读 | P1，立即 | 无密钥值需要轮换；收窄应用目录/DB权限，若确认其他用户曾接触真实 key 则轮换。普通非授权账号读取/修改应拒绝 |
| SEC-006 | 缺少 .gitignore；README:24 的“不入 git”没有规则保障 | 将来 init Git 后 .env/DB/log/export 易被提交；当前无已知提交 | 将来的仓库成员/公共 fork/镜像 | P3，首个 Git 提交前 | 不能用当前无 Git 宣称历史安全。后续取得仓库后扫描全部 refs；若泄漏则撤销/轮换、规划历史重写并复扫当前/历史/镜像 |

### 7.3 凭据处置与残余风险

本次没有秘密值被删除、撤销、测试或轮换。若未来确认真实凭据：记录脱敏位置与受影响时间；先撤销/轮换，核对 scope/有效期/调用记录；更新授权消费者；在有备份与明确授权后清理数据库、导出、日志和 Git 全 refs，协调 fork/镜像；设置提交前和 CI 的离线秘密扫描。仅从当前文件删除不解决历史暴露。处置必须由凭据所有者执行，本报告不授权修改账号。

残余风险包括外部 Hermes/Pi/Codex 配置、进程环境、WSL/飞书/relay 脚本、项目外 deliverable 正文、系统日志/备份、不可取得的 Git 历史、DB 删除残留、未标记随机密码。这些内容未读取也未上传；不将其标记为已确认泄漏。

## 8. GitHub 开源项目对标

### 8.1 仓库、维护状态和检查基准

检查日期 **2026-10-10（Asia/Tokyo）**。公开 GitHub API 无认证 GET 获取 metadata、HEAD 和完整文件树，下载选定公开源码至项目外目录；没有克隆/安装/执行项目。时间栏使用 API 原始 UTC，避免把 pushed_at 混同默认分支最后提交。所有仓库当时 archived=false、disabled=false。

| 仓库及理由 | 精确 HEAD | API pushed_at（UTC） / HEAD commit（UTC） | 状态判断 |
|---|---|---|---|
| [Microsoft AutoGen](https://github.com/microsoft/autogen)：Agent runtime、取消、团队状态 API | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` | 2026-04-15 11:59:09 / 2026-04-06 22:35:32 | README 明确**维护模式、社区维护**，不再新增功能；作为设计参考，不推荐因历史知名度直接选为新底座 [A1] |
| [CrewAI](https://github.com/crewAIInc/crewAI)：Flow、SQLite、AgentAdapter、事件总线 | `6b93fa0e25a926215ca7bb52a95d4db7d9d7262d` | 2026-10-09 22:33:43 / 2026-10-09 22:33:27 | 当日附近存在更新，未归档；具体维护承诺不从星数推断 |
| [LangGraph](https://github.com/langchain-ai/langgraph)：显式图状态、checkpoint、恢复 | `6aa0afba682b0308fbcace31f66fb532978d4dca` | 2026-10-10 03:23:57 / 2026-10-10 00:59:20 | 当日更新、未归档；检查 Python 仓库，未自动把能力映射到 TS 包 |
| [OpenHands](https://github.com/OpenHands/OpenHands)：补充对标 TS 控制服务/Windows/Docker 边界 | `03f356c5c81aefed7afad926c54e53f75230f5f6` | 2026-10-10 03:16:22 / 2026-10-09 20:50:35 | 当日更新、未归档；该快照含 Agent Canvas UI/服务适配层，未套用旧版本后台架构印象 |

标记：**代码**=本次读过对应源码；**文档**=官方描述或配置存在；**待验证**=未运行或未找到足够实现证据。读取测试源码只能证明有对应断言，不能证明其最新测试通过。没有把框架状态保存功能等同于本项目任务领取租约。

### 8.2 功能对标矩阵

| 评估维度 | 当前项目 | AutoGen A | CrewAI B | LangGraph C | 差距 | 是否值得引入 |
|---|---|---|---|---|---|---|
| Agent 适配层 | 四个具体模块、固定 Executor | BaseAgent/runtime，扩展分层（代码 A2） | BaseAgentAdapter 抽象（代码 C1） | 图节点/checkpointer 契约（代码 L1/L2），非桌面适配器 | 缺统一能力/观察合约 | 借鉴窄接口，值得 |
| 任务状态 | 八状态台账/手工转换 | 团队运行/暂停状态（代码 A3） | Task Pydantic 字段和 Flow 状态（代码 C2/C3） | 节点/通道 checkpoint（代码 L2） | 上述均不是本项目业务状态机直接替代 | 保留自己的状态模型 |
| 多 Agent 编排 | 无派发和执行闭环 | GroupChat（代码 A3） | Crew/Flow、listeners（代码 C3） | graph superstep/Pregel（代码 L2） | 需落实最小受控派发 | 暂不引入完整引擎 |
| 持久化 | SQLite task/event/audit | save/load state；基类默认未实现（代码 A2/A3） | SQLiteFlowPersistence（代码 C4） | SqliteSaver checkpoints/writes（代码 L1） | 状态/事件事务与版本不足 | 借鉴明确持久接口 |
| 故障恢复 | 保留 DB；无执行恢复 | team load_state；非自动 crash recovery（代码 A3） | checkpoint restore、pending feedback（代码 C3/C4） | checkpoint + pending writes（代码 L1/L2） | 缺恢复动作与 attempt | 借鉴恢复协议，不迁引擎 |
| 取消/超时 | 台账 cancel；任务无 timeout | CancellationToken；Docker timeout；强取消有一致性警告（代码 A3/A4/A5） | runtime task.cancel/resume；全局 timeout 合约待验证（代码 C3） | interrupt/durability；SDK cancel tests；部署端执行合约未运行（代码 L2/L3） | 取消请求与实际确认需分离 | 值得实现 AbortSignal/ack |
| 并发控制 | 无 CAS；busy_timeout=0 | _is_running 阻止同 team 重入，token 加锁；不是 DB lease（代码 A3/A4） | SQLite lock/30s busy timeout、async gather（代码 C3/C4） | Saver thread lock/事务；不证明跨进程同 thread 排他（代码 L1） | 必须先修原子 claim | 借鉴事务和限并发 |
| 事件/日志 | events/audit，多个提交 | message/runtime/team stream（代码 A2/A3） | EventBus 的 handlers/emit（代码 C5） | checkpoint/writes/interrupt（代码 L1/L2） | 缺去重与结构化错码 | 值得，先不加总线 |
| 可观测性 | CLI 快照，无 freshness | team 流状态（代码 A3）；指标集成未深审 | EventBus（代码 C5），完整 tracing 未运行 | checkpoint 查询（代码 L1）；托管 tracing 文档不作本地保证 | 先加 freshness/错误/attempt | 值得最小指标 |
| 安全隔离 | OS 同账户权限；未执行 Agent | Docker executor 可选（代码 A5），不提供通用授权保证 | MCP 安全指南（文档 C7），不把指南视为自动隔离 | checkpoint 引擎本身不提供工具沙箱 | 此项依执行器边界决定 | 实际控制上线前必要 |
| 凭据管理 | 无专用字段；自由文本不脱敏 | README env 示例（文档 A1）；未证明自动加密/脱敏 | MCP 指南要求保护（文档 C7）；本次未深审 secret manager | Saver 持久任意 state（代码 L1）；不视为 secret manager | 引入框架不会自动解决泄漏 | 自建最小输入/日志政策 |
| 插件扩展 | 固定 provider 名称 | Components/extensions（代码 A2/A5） | Adapter（代码 C1） | checkpointer/node（代码 L1/L2） | 能力声明/注册缺失 | 后续窄注册表即可 |
| 测试体系 | test=0；隔离 e2e20项 | cancellation 测试（源码 A6） | persistence 测试（源码 C6） | cancellation 与 Pregel 测试（源码 L3/L4） | 缺故障/竞争/CLI测试接入 | 优先引入测试方法 |
| Windows 支持 | WSL 常量；原生错路径/pgrep | 本次原生 Windows 运行待验证 | 本次 Windows 运行待验证 | 本次 Windows 运行待验证 | 不凭 Python 跨平台推断支持 | 参考补充 OpenHands W1/W2 |
| CLI | 21命令、手工flag、错码不足 | 框架/Studio 文档，不同定位（文档 A1） | 独立 CLI 源码/测试树存在，未执行 | SDK/框架核心，不直接比较台账 CLI | 需建立脚本可用 CLI 合约 | 保留轻量 CLI |
| 运维复杂度 | 1 个本地 DB、零 npm 依赖 | Python/模型/可选 Docker | Python/模型/Flow配置/可选 MCP | graph/checkpointer/可选服务器 | 大框架会扩大运行和依赖面 | 现在不整体迁移 |

补充 OpenHands：本次读过服务 API/runtime adapter，有 timeout、session API key 边界和 paused/waiting_for_confirmation 状态处理 [W3]、[W4]；Windows README 与 windows-latest 打包 workflow 存在 [W1]、[W2]，多 conversation Docker 路线文档要求 WSL2。Docker boundary 测试源码存在 [W5]，未运行。因此“有 Windows 文档/构建配置”可确认，“当前所有 Windows 部署均通过”不能确认。

### 8.3 适合本项目体量的借鉴

最值得借鉴：明确 Adapter 能力与可信 caller；原子持久化、schema version、busy timeout；取消请求和完成确认分离；checkpoint/attempt 的恢复含义；事件幂等键；带 Mock 的竞争/故障测试。先把这些落实在现有 1,237 行 TS 中，无需替换业务状态机。

不建议照搬：分布式 Actor runtime、完整图 DSL、多数据库 backend、托管观测平台、多租户云服务、自动启动 Docker/浏览器，或为审计新增模型 guardrail API。大框架也有可选配置与取消一致性限制，不把文档能力视为本项目应全部具备的缺陷清单。

## 9. 测试与质量保障评估

### 9.1 实际执行与隔离说明

源文件与 package 复制到聊天工作目录的 `work\isolated bridge`，未复制原数据库。CLI 默认库因此落在隔离副本的 data。自有探针创建独立临时库、合成 JSON 和事件故障触发器；所有 Node 子进程 shell=false，仅执行隔离 CLI，不触发 status/fork/真实 Agent。双连接 Worker 只是审计进程。

现有 e2e 副本仅将 `/tmp/bridge-e2e.db` 及 -wal/-shm 路径替换为唯一 UUID 测试路径；外部 `/mnt`、`/home` 文件与 execSync 均用合成 fixture 替代。**全部原 check() 断言未修改**，20/20、exit0。它验证逻辑和 fixture 读取，不验证真实 Hermes/Pi/Codex 在线或真实 ChatGPT 外部服务。原始固定路径删除和真实进程查询不安全，未原样运行。

审计探针首轮 16 组：15 组证据验证成立，1 组对“长合成 marker 必须完整出现在 JSON 错误中”的审计断言失败；Node 错误只保留短片段，不等于实现有脱敏器。补充改用短合成 marker 后，事件、审计、JSON 诊断均保留 marker；另用 Mock 验证 Pi 陈旧锁被报告 running、Hermes 查询异常被报告 degraded。此断言修正只发生在审计辅助文件。没有把探针 exit0 当作所有断言通过。

### 9.2 用户指定场景覆盖表

| 场景 | 现有测试状态 | 本次验证与结论 |
|---|---|---|
| 1 合法转换 | 已存在且隔离通过 | QUEUED→RUNNING→WAITING_APPROVAL→SUCCEEDED；20项套件的一部分 |
| 2 非法转换 | 已存在且隔离通过 | 直接 SUCCEEDED、QUEUED→BLOCKED 被拒；没有穷举所有状态对 |
| 3 任务失败 | 已存在且隔离通过 | verify(false)→FAILED，再排 QUEUED；未执行真实 Agent 失败 |
| 4 任务超时 | 未覆盖 | 当前无任务 deadline，不能把租约过期测试算作超时 |
| 5 Agent 离线 | 未覆盖真实场景 | 既有租约测试通过；Mock 暴露观察状态误判；未停止 Agent |
| 6 并发更新 | 未覆盖 | 审计双连接竞争确认两次 claim 成功（缺陷） |
| 7 SQLite 锁 | 未覆盖 | 审计 writer lock 下即时 locked（缺陷） |
| 8 任务恢复 | 未覆盖 | 持久字段有；自动恢复未实现；过期无法 claim 已复现 |
| 9 CLI 参数错 | 未覆盖 | 审计错命令/任务/缺验收参数 exit0；冲突 flag pass；-k无效 |
| 10 不可信输出 | 未覆盖 | 结构错误导入抛异常；所有者伪称、合成 marker 落盘已验证 |
| 11 命令注入 | 未覆盖 | 静态无输入→shell 链；未执行 exploit，不能写“安全测试全通过” |
| 12 SQL 注入 | 未覆盖 | 审计 SQL 样字符串按字面绑定，表存在，查询注入未生效 |
| 13 日志脱敏 | 未覆盖 | 合成 marker 原样存 audit/event，缺防护 |
| 14 密钥泄漏防护 | 未覆盖 | 当前文件/库扫描无真实 key；合成敏感内容不脱敏 |
| 15 Windows 空格路径 | 未覆盖 | 本次源副本/临时库的带空格路径可运行；固定 WSL 数据路径仍不兼容 |
| 16 多 Agent 同跑 | 未覆盖 | 双 Worker/独立连接竞争，不代表真实多 Agent 集成通过 |
| 17 控制幂等 | 顺序 verify 拒重复已存在且通过 | 原 test不发现e2e；真实控制执行不存在，无控制幂等通过证据 |
| 18 重复事件 | 未覆盖 | 顺序 sweep 单告警；并发告警/事件无 unique/key，不保证去重 |
| 19 子进程异常退出 | 未覆盖 | Mock 查询错误映射已验证；无实际执行器，未杀子进程 |
| 20 迁移兼容 | 未覆盖 | user_version0/无迁移；只做 Schema 静态比较 |

无“现有测试失败”可据原生产环境确认：原 test 是空跑，e2e 是明确 Mock 后通过；原环境集成测试标为**无法安全执行**。补充建议按第 10 节各条回归用例实施，优先竞争、失败回滚、caller 授权、导入不覆盖和 CLI 错码；测试不应只验证相同状态常量。

## 10. 完整问题清单

以下按 P0→P1→P2→P3→P4 排序；**P0 无确认发现**。风险等级针对当前本地控制桥目标，不将需要本地访问权限的缺陷说成无前提远程漏洞。每条列出已有保护，避免把建议当作现成功能。

### 10.1 P1 / High

#### SEC-001：验收角色字符串不是身份认证，任务所有权未被执行

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-001 |
| 2. 问题标题 | 验收角色可自行声明，其他执行者可完成任务 |
| 3. 严重度 | P1 / High |
| 4. 问题类别 | 认证/授权、Agent 身份与独立验收 |
| 5. 发现状态 | 已确认；外部飞书调用者是否另有身份验证待验证 |
| 6. 受影响文件 | src/tasks.ts、src/cli.ts、src/types.ts |
| 7. 准确定位 | tasks.ts:86–98、103–123、127–135、156–160；cli.ts:87–120；types.ts:16–17 |
| 8. 问题描述 | verify 只接受名为 hermes/user 的字符串，但不绑定可信 caller；CLI 默认 hermes，调用者可以传 --by user。executorFinished 不匹配 claimed_by，claim 不检查任务指定 executor。hermes 本身也可领取后使用同名验收，不保证职责分离 |
| 9. 证据/复现 | 合成 task 被 pi 领取后，codex finish 返回 ok；随后使用调用者指定 user 验收到 SUCCEEDED。未读取真实任务/凭据；README 所说“执行者不能自己标成功”只是字符串条件保护 |
| 10. 触发条件 | 不应具有验收权限的 Agent/用户能调用同一 CLI/TaskStore；当前同账号执行是可信边界内，若全部 caller 真正可信影响较低 |
| 11. 实际影响 | 可伪造独立验收、替其他 holder 完成/取消、污染 source/actor 审计；不提供管理员或远程访问能力 |
| 12. 根本原因 | 业务角色、Provider 名与真实执行主体混用，没有认证上下文和每动作授权/所有者校验 |
| 13. 建议修复 | 由可信入口提供不可由业务参数覆盖的 caller context；验收 require reviewer capability 且 reviewer!=attempt executor；finish/heartbeat 校验 instance id 和 fencing token。若共享 OS 账号无法隔离，明确部署为可信台账，敏感验收经独立受控入口 |
| 14. 修复优先级 | 第一批；真实跨 Agent 写权限开放前 |
| 15. 验收标准 | 执行者改 --by/字符串不得获得 reviewer 权限；非 holder finish/cancel/renew 拒绝且状态不变；默认 CLI 缺授权 context 不执行验收；审计记录可信主体与宣称角色分开 |
| 16. 推荐回归测试 | pi 调 user/hermes 验收、codex finish pi 任务、同 provider 不同实例、执行者自审、伪造 actor、缺 caller context |
| 17. CWE/OWASP | CWE-287、CWE-862、CWE-863；OWASP 访问控制/身份认证原则 |
| 已有保护/缺口 | transition 禁 SUCCEEDED，verify 拒 pi 字符串；缺真实身份及独立验收主体校验 |

#### SEC-002：项目与数据库权限允许其他本地认证用户修改

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-002 |
| 2. 问题标题 | 继承的 NTFS ACL 破坏任务/源码的本地完整性边界 |
| 3. 严重度 | P1 / High |
| 4. 问题类别 | Windows 文件权限、授权、供应链/数据完整性 |
| 5. 发现状态 | 已确认 ACL；未切换其他账号或实际写入验证 |
| 6. 受影响文件 | 项目根目录及 data/bridge.db，继承权限的源代码/配置 |
| 7. 准确定位 | D:\Agent control bridge 与 data\bridge.db 的 Get-Acl Access 项；文件系统权限没有源码行号；db.ts:21–23 未收窄创建权限 |
| 8. 问题描述 | 根目录和 DB 均有继承 Allow：Authenticated Users 的 Modify/Synchronize；Users 的 ReadAndExecute/Synchronize。源码和数据库不是仅应用所有者可访问 |
| 9. 证据/复现 | 只读 Get-Acl 输出上述权限，未输出机密、未修改 ACL。Admins/SYSTEM FullControl 属正常系统条目，不按缺陷计 |
| 10. 触发条件 | 其他本地普通账号或相应权限进程能访问 D: 路径；不推断网络共享开放或企业策略绕过 |
| 11. 实际影响 | 可读取业务文本、修改任务成功状态/审批/审计；可篡改后续由所有者运行的源码。后者是代码完整性风险，未实测代码执行 |
| 12. 根本原因 | 项目落在继承广泛读写权限的目录，数据与可执行源代码共用该边界 |
| 13. 建议修复 | 由维护者以其允许的用户级权限使用受限目录/ACL；分开只读代码、只允许控制入口写的 DB；对 WAL/SHM/导出/备份继承同样受限策略。不要把 SQL状态校验当作文件级安全 |
| 14. 修复优先级 | 第一批；先保护目录，审计本次不执行权限变更 |
| 15. 验收标准 | 普通非授权本地账号读取敏感库/修改源码或 DB 均拒绝；授权业务账号正常读写；新建 sidecar/备份不恢复宽权限；列出允许主体 |
| 16. 推荐回归测试 | 专用非授权测试账号的 read/write-denied；新库/导出 ACL 检查；合法账号 WAL并发操作 |
| 17. CWE/OWASP | CWE-732、CWE-276；最小权限原则 |
| 已有保护/缺口 | OS 文件权限可作为边界，但当前授权面过宽；不要求管理员操作作为唯一修复路线 |

#### STATE-001：读后写没有条件更新，双领取和终态竞争可覆盖状态

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | STATE-001 |
| 2. 问题标题 | 两个独立连接可同时领取同一任务 |
| 3. 严重度 | P1 / High |
| 4. 问题类别 | 任务状态机、并发正确性、所有权 |
| 5. 发现状态 | 双领取已确认；verify/cancel 相同读后写结构的覆盖为高可信风险，未实测全部交错 |
| 6. 受影响文件 | src/tasks.ts、src/types.ts |
| 7. 准确定位 | tasks.ts:66–92、108–123、128–134；types.ts:82–91 |
| 8. 问题描述 | 先 SELECT 校验，再 UPDATE WHERE id，无原状态/版本/holder 条件。claim 的 RUNNING 更新和 owner 更新又是两条语句；跨进程可读到同一 QUEUED 后各自成功 |
| 9. 证据/复现 | 两 Worker 独立 DB 连接先同时读 QUEUED，barrier 后调用原 claim；pi/codex 都 ok，最终 owner=codex（该次后写者）。只在临时库固定调度，未修改 TaskStore源码 |
| 10. 触发条件 | 两进程/线程对同任务交错读写。Node 同步 API 只保证单线程顺序，SQLite WAL 不锁整个业务方法 |
| 11. 实际影响 | 多消费者依据两次领取执行可重复工作，owner覆盖、审计失真；若 verify与cancel竞争，后写可能覆盖已变终态。当前无实际派发器，所以重复真实模型执行尚未发生于本次测试 |
| 12. 根本原因 | 没有 CAS、原子 claim、changes 检查或 attempt/fencing；把 claimed_by 字段当作协调机制 |
| 13. 建议修复 | 用事务中条件 UPDATE WHERE status/version/owner 与 changes=1 实现领取；同时写新 lease/instance/attempt，审计同事务；所有转换也 CAS。必要时短 BEGIN IMMEDIATE，避免跨耗时 Agent 操作持锁 |
| 14. 修复优先级 | 第一批；与 DB-001 一起处理 |
| 15. 验收标准 | 两/多连接同 QUEUED 领取恰有1成功；后续 late finish/verify/cancel 不覆写新版；最终事件对应真实唯一合法转换；终态不能被竞争复活 |
| 16. 推荐回归测试 | barrier 双领、verify/cancel、retry/旧回调、同provider不同instance；忙锁下 CAS一致性 |
| 17. CWE/OWASP | CWE-362、CWE-367（检查/使用竞争）；数据完整性 |
| 已有保护/缺口 | 顺序非法转换拒绝；缺跨连接原子校验 |

#### DB-001：状态、租约、事件和审计分开提交

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-001 |
| 2. 问题标题 | 后续写入失败不会回滚已提交业务状态 |
| 3. 严重度 | P1 / High |
| 4. 问题类别 | SQLite 事务、状态完整性、故障恢复 |
| 5. 发现状态 | 已确认 |
| 6. 受影响文件 | src/tasks.ts、src/codex.ts、src/chatgpt.ts、src/cli.ts |
| 7. 准确定位 | tasks.ts:29–47、78–92、117–123、131–135、149–160、185–187；codex.ts:68–83；chatgpt.ts:172–206；cli.ts:40–47、241–243 |
| 8. 问题描述 | 所有业务序列是多个自动提交语句。event/audit/租约/导出失败或进程退出后，调用失败与已存状态不一致；批量同步也可能部分写入 |
| 9. 证据/复现 | 临时触发器令 events INSERT 失败，claim 抛异常但任务 RUNNING、claimed_by=null、状态事件0条。ChatGPT 第二个null项失败后第一个session仍存在；Codex外键失败后项目已提交 |
| 10. 触发条件 | 锁、约束、磁盘/权限错误、不可序列化 payload、进程在多次提交间退出、导入中途不合法项 |
| 11. 实际影响 | 任务卡住或状态无审计、错误重试产生重复/部分数据；无法可靠判断操作到底生效。未做生产磁盘故障或进程杀死验证 |
| 12. 根本原因 | 缺以业务命令为单位的事务和失败回滚，文件写入与 DB 提交没有协调策略 |
| 13. 建议修复 | create/claim/finish/verify/cancel/approval 写入在短事务内整体提交；批量先验证再单事务。导出先安全暂存、成功后登记；明确文件/DB补偿协议，不把长网络操作放数据库事务 |
| 14. 修复优先级 | 第一批；依赖/配合 STATE-001 |
| 15. 验收标准 | 任一SQL/序列化/导出写入失败后无半完成任务/事件/审计；异常回滚，连接回到非事务状态；重试有明确结果并不重复写入 |
| 16. 推荐回归测试 | 逐写入点触发器故障、约束异常、导出只读目录、模拟进程退出后的隔离库恢复、重新执行同command id |
| 17. CWE/OWASP | CWE-703、CWE-754；并发时另见 CWE-362 |
| 已有保护/缺口 | SQLite 保证单语句原子性/外键，缺完整业务事务 |

### 10.2 P2 / Medium

#### CODE-002：ChatGPT 导入会覆盖输入或已有导出

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | CODE-002 |
| 2. 问题标题 | 输出路径推导不安全，非小写 .json 输入被原位覆盖 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 文件安全、数据丢失、Windows 扩展名 |
| 5. 发现状态 | 已确认 |
| 6. 受影响文件 | src/chatgpt.ts、src/cli.ts |
| 7. 准确定位 | chatgpt.ts:155–164、203–206；cli.ts:191–198 |
| 8. 问题描述 | replace(/\.json$/, '.conversations.md') 大小写敏感。允许 .JSON/无扩展名等有效JSON输入时 mdPath==filePath；writeFileSync 默认截断覆盖。正常 .json 也覆盖已有同名 Markdown |
| 9. 证据/复现 | 在临时 synthetic-export.JSON 写合成合法数组，import 返回 markdownPath==input；文件开头变为 # ChatGPT。未覆盖任何用户文件 |
| 10. 触发条件 | 用户导入可读写的合法 JSON，名字不是小写 .json；或目标 Markdown 已存在 |
| 11. 实际影响 | 原导出/已有笔记被损毁；成功返回且没有冲突提示，可能无法恢复 |
| 12. 根本原因 | 字符串替换代替独立输出路径设计，无同路径/存在检查或排他写入 |
| 13. 建议修复 | 明确解析扩展名和独立 output；大小写不敏感但必须不同于input；默认排他新建/不覆盖，覆盖需显式选项；临时文件安全创建后提交；处理重解析点及文件身份 |
| 14. 修复优先级 | 第一批可并行的小修；再次使用导入前 |
| 15. 验收标准 | .JSON/.Json/无后缀输入字节hash不变；已有输出保留且命令非0失败；同输入输出及替换竞争拒绝；正常导入得到完整独立文件 |
| 16. 推荐回归测试 | 扩展名矩阵、已有同名md、只读输出目录、带空格Unicode路径、显式同路径、重解析点fixture |
| 17. CWE/OWASP | CWE-73、CWE-664；竞争场景 CWE-367 |
| 已有保护/缺口 | 检查存在与JSON顶层数组；没有写保护 |

#### CODE-001：CLI 参数和退出码不可靠，冲突验收默认通过

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | CODE-001 |
| 2. 问题标题 | 参数错误返回成功码、--pass --fail 按通过执行 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | CLI 合约、运行时校验、误导成功 |
| 5. 发现状态 | 已确认 |
| 6. 受影响文件 | src/cli.ts、package.json、README.md |
| 7. 准确定位 | cli.ts:20–25、58–70、87–121、270–289、276；README.md:68；package.json:7–14 |
| 8. 问题描述 | 手动flag取下一字符串，不验缺值/未知参数/枚举；帮助中的 -k 不被读取；任务操作 `{ok:false}` 打 stdout后正常 exit0；同时传pass/fail时 hasFlag(pass) 决定成功；无 -by 默认hermes |
| 9. 证据/复现 | 隔离CLI未知命令、缺task/不存在task均exit0；-k review落库kind=dev；-e not-a-provider被接受；同一验收传两个flag到SUCCEEDED。身份风险独立计SEC-001 |
| 10. 触发条件 | 自动脚本只判断exit code、调用拼错/缺参数/互斥flag同时出现、非可信输入 |
| 11. 实际影响 | 自动化继续执行、错误被当成功；拒绝验收意图被通过优先覆盖；类型非法值进入台账 |
| 12. 根本原因 | 解析和执行业务耦合、无runtime schema/统一命令结果合约 |
| 13. 建议修复 | 先解析并验证完整命令；互斥flag恰有一个、显式验收角色；统一参数error/业务conflict退出码与stderr；实现或删去-k；拒未知Executor/Status；补typecheck流程（本次不创建配置） |
| 14. 修复优先级 | 第二批前列；验收冲突flag随第一批身份修复 |
| 15. 验收标准 | 错参数/失败操作非0且stderr，成功才0；双方flag拒绝且DB不变；文档别名逐条匹配；非法enum不入库；帮助不产生DB写入（ARCH-001） |
| 16. 推荐回归测试 | 未知cmd/option、缺值、重复option、无id、双方验收flag、-k、非法status/provider、JSON错误输出合约 |
| 17. CWE/OWASP | CWE-20、CWE-754 |
| 已有保护/缺口 | task-verify 拒绝两个flag都缺；没有互斥/身份来源/正确退出码 |

#### STATE-002：租约没有续约/恢复路径，返工沿用旧执行元数据

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | STATE-002 |
| 2. 问题标题 | 过期任务可能永久 RUNNING，返工没有 attempt 重置 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 状态机、故障恢复、生命周期 |
| 5. 发现状态 | 已确认已有API行为；实际运行是否由外部系统恢复待验证 |
| 6. 受影响文件 | src/tasks.ts、src/types.ts、src/cli.ts |
| 7. 准确定位 | tasks.ts:79–90、175–190；types.ts:83–90；cli.ts:87–128 |
| 8. 问题描述 | 租约只在claim写一次，默认600秒，无续约；sweep只告警。RUNNING→RUNNING不允许，过期不能重claim；无明确人工recover/heartbeat CLI。FAILED→QUEUED未清owner/lease/started_at，没有attempt；WAITING/BLOCKED无deadline |
| 9. 证据/复现 | 临时-1秒租约经sweep仍RUNNING且codex重claim失败；转FAILED再QUEUED，claimed_by仍pi，started_at非null，旧租约留存 |
| 10. 触发条件 | 工作超过10分钟/进程退出/断线；失败返工；审批或阻塞长期无人处理 |
| 11. 实际影响 | 过期无法继续协调、告警无法区分长任务/失联、旧执行回调可混淆新轮次；不要求自动将失联判失败 |
| 12. 根本原因 | 只有租约字段而无lease协议、attempt和恢复状态动作 |
| 13. 建议修复 | 加可信holder续约、唯一attempt和fencing；显式有授权的recover/requeue；各状态deadline/人工处置政策；重试重置或分attempt保存时间/owner/错误，不误判成功 |
| 14. 修复优先级 | 第二批；依赖SEC-001、STATE-001、DB-001 |
| 15. 验收标准 | 正常长任务可续租；旧holder/旧attempt回调拒绝；过期可显式恢复一次且审计；返工时间/owner可区分；无无限静默等待 |
| 16. 推荐回归测试 | 长任务续约、租约过期恢复、进程重启、旧finish回调、审批deadline、失败重复返工 |
| 17. CWE/OWASP | CWE-672、CWE-703；并发边界 CWE-362 |
| 已有保护/缺口 | 过期不标成功、顺序未确认告警去重；缺续约和安全恢复 |

#### STATE-003：审批可重决，缺失审批也留下成功审计

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | STATE-003 |
| 2. 问题标题 | decideApproval 不限制 pending、不检查命中行 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 审批生命周期、幂等、审计可信性 |
| 5. 发现状态 | 已确认；当前无真实执行消费审批链 |
| 6. 受影响文件 | src/tasks.ts、src/cli.ts |
| 7. 准确定位 | tasks.ts:147–160；cli.ts:248–254 |
| 8. 问题描述 | UPDATE仅WHERE id，不限制decision=pending；忽略changes；不存在id也recordAudit且正常返回void。重复request无幂等键；审批与Task/动作执行不绑定 |
| 9. 证据/复现 | 临时审批approved→rejected成功；对missing调用不报错，audit_log共3条decision。没有启动fork/resume |
| 10. 触发条件 | API caller重复/竞争决策、拼错id、未来执行器消费错误或撤回记录 |
| 11. 实际影响 | 无法以审批记录确认最终一次性授权；虚假审计与决策覆盖；当前仅台账受影响，不宣称已绕过真实控制审批 |
| 12. 根本原因 | 审批不是带版本/终态的实体，无条件更新和结果合约 |
| 13. 建议修复 | caller授权后对pending条件决策，命中1行；绑定task、action和参数hash/attempt，consume一次；重复相同决定返回已决结果，反向修改明确拒绝或独立撤销流程 |
| 14. 修复优先级 | 第二批，任何实际执行器启用前 |
| 15. 验收标准 | missing非0/错误且不写成功审计；两个并发决定仅1生效；approved不可默默变rejected；执行同approval不可重复或跨参数复用 |
| 16. 推荐回归测试 | missing、重复同决定、反向重决、竞争决定、task/动作/参数不匹配、一次消费 |
| 17. CWE/OWASP | CWE-841、CWE-362、CWE-754 |
| 已有保护/缺口 | FK约束task、审计时间；缺生命周期条件和授权绑定 |

#### DB-002：零等待锁冲突和无重试令并发命令直接失败

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-002 |
| 2. 问题标题 | createDb 无 busy_timeout/锁冲突处理 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | SQLite 可用性、Windows 多进程 |
| 5. 发现状态 | 已确认本次Node运行时；其他部署版本默认值待核实 |
| 6. 受影响文件 | src/db.ts、src/cli.ts、src/tasks.ts |
| 7. 准确定位 | db.ts:23–28；cli.ts:13–14、289；tasks.ts各run调用（例79–81） |
| 8. 问题描述 | 开库只设WAL/FK，没有busy_timeout。多个CLI连接写同文件时，已有writer导致SQLITE_BUSY，且未区分错误/有限重试；初始化也会争锁 |
| 9. 证据/复现 | 原createDb临时连接PRAGMA busy_timeout=0；另连接BEGIN IMMEDIATE时cancel约1ms报database locked；最后rollback/close只操作临时库 |
| 10. 触发条件 | 多Agent同时提交、外部合法事务未完成、初始化/检查点锁竞争 |
| 11. 实际影响 | 短暂锁被当不可恢复故障；若业务前几步已提交进一步造成DB-001半完成 |
| 12. 根本原因 | 将WAL误当writer排他/等待策略，缺明确busy预算和错误处理 |
| 13. 建议修复 | 配置有限busy_timeout、短事务、针对BUSY的受限退避与总deadline；重试必须与事务/CAS/幂等一起设计，不能逐语句盲重试 |
| 14. 修复优先级 | 第二批，配合第一批事务/CAS |
| 15. 验收标准 | 测试writer短锁释放后命令一次生效；超预算返回明确忙错误且无半提交；不重试权限/约束错误；时限有上界 |
| 16. 推荐回归测试 | 双进程短锁/长锁、init竞争、BUSY重试、错误分类、最终事务一致性 |
| 17. CWE/OWASP | CWE-703、CWE-754 |
| 已有保护/缺口 | WAL可改善读写并行；同一时刻仍只有一个writer [S1]、[S2] |

#### DB-003：数据库不约束状态/Provider，文本主键允许 NULL

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-003 |
| 2. 问题标题 | SQLite Schema 与 TypeScript 联合类型约束不一致 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 数据完整性、运行时类型 |
| 5. 发现状态 | 已确认 |
| 6. 受影响文件 | src/schema.sql、src/tasks.ts、src/types.ts |
| 7. 准确定位 | schema.sql:11–17、21–29、34–51、69–79、103–109；tasks.ts:34–43、51–62；types.ts:3–17 |
| 8. 问题描述 | status/executor/source/decision/severity无CHECK，priority非STRICT INTEGER可存real；TEXT PK没显式NOT NULL；alerts.task_id没FK；SQL行仅断言为Task，错误状态可能堵住业务 |
| 9. 证据/复现 | 临时createTask存invalid executor和priority1.25；直接UPDATE可写NOT_A_STATE；NULL project主键插入成功。原库只读非法任务数0、FK违规0，不声称现有数据已损坏 |
| 10. 触发条件 | CLI非法输入、JS caller、旧schema或有DB写权限的其他程序；SQL约束不是对恶意DB所有者的安全边界 |
| 11. 实际影响 | 无效任务、聚合统计错误、状态机无法恢复、孤立告警，类型安全假象 |
| 12. 根本原因 | 仅TS静态类型和注释表达数据约束，无输入/DB双重校验 |
| 13. 建议修复 | 输入校验+CHECK/NOT NULL/适当FK/唯一约束；需要时STRICT；迁移前统计旧数据并定义修复政策；避免无限级联删除审计 |
| 14. 修复优先级 | 第二批；Schema修复依赖DB-005迁移方案 |
| 15. 验收标准 | 非法枚举、null主键、非法priority拒绝；合法NULL可选字段保持可用；alerts不存在task拒绝或明确无task告警语义；旧库升级不丢记录 |
| 16. 推荐回归测试 | 每个enum边界、空/NULL主键、real/NaN priority、孤立FK、旧schema迁移 |
| 17. CWE/OWASP | CWE-20、CWE-704 |
| 已有保护/缺口 | tasks.status NOT NULL及部分FK存在；没有值域校验；SQLite文本PK的NULL行为官方说明见[S3] |

#### DB-004：会话 ID 没有 Provider 命名空间，导入可覆盖另一个来源

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-004 |
| 2. 问题标题 | sessions.id 与外部ID直接共用引起跨来源冲突 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 多Agent数据建模、同步完整性 |
| 5. 发现状态 | 已确认冲突路径；当前真实ID是否冲突未观察 |
| 6. 受影响文件 | src/schema.sql、src/codex.ts、src/chatgpt.ts |
| 7. 准确定位 | schema.sql:21–29；codex.ts:75–81；chatgpt.ts:173、178–182 |
| 8. 问题描述 | Codex thread id与ChatGPT conversation_id直接用作同表PK；ChatGPT缺IDfallback是chatgpt-0等位置索引。ON CONFLICT(id)只改部分字段，保留原source/project/state，制造来源混合 |
| 9. 证据/复现 | 临时Codex session id=shared，再导入ChatGPT同id；row.source仍codex、title成ChatGPT标题，ChatGPT count=0。是合成碰撞，不假定真实UUID已碰撞 |
| 10. 触发条件 | 导入修改/非官方JSON声明相同id，跨来源ID重复，多个缺ID的导出文件 |
| 11. 实际影响 | 元数据被覆写、同步数和查询不符、关联任务指向错误会话；不是SQL注入 |
| 12. 根本原因 | 全局主键直接等于第三方不可信标识，没有(source,external_id)身份域 |
| 13. 建议修复 | 独立本地id+UNIQUE(source,external_id)，或安全编码的provider命名空间；缺ID拒绝或用稳定内容来源键，明确冲突返回，不按数组位置混并 |
| 14. 修复优先级 | 第二批；依赖DB-005迁移和CODE-003输入契约 |
| 15. 验收标准 | 同外部id不同source独立保存；重复同来源导入幂等；fallback跨文件不覆盖；既有task FK迁移一致 |
| 16. 推荐回归测试 | 同ID跨provider、重复导入、无ID不同文件、旧库会话FK迁移 |
| 17. CWE/OWASP | CWE-20、CWE-706 |
| 已有保护/缺口 | 同id UPSERT有顺序幂等性；不具备跨source隔离 |

#### CODE-003：外部 JSON 只做类型断言，没有完整运行时契约

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | CODE-003 |
| 2. 问题标题 | 结构正确的JSON仍可触发未捕获异常或返回错误类型 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 输入校验、TypeScript类型安全、异常隔离 |
| 5. 发现状态 | ChatGPT invalid item异常已确认；其他输入形状按调用链为高可信风险 |
| 6. 受影响文件 | src/chatgpt.ts、src/codex.ts、src/pi.ts、src/hermes.ts、src/cli.ts |
| 7. 准确定位 | chatgpt.ts:35–47、155–201；codex.ts:35–52、66–83；pi.ts:29–43；hermes.ts:28、37–38；cli.ts:132–184 |
| 8. 问题描述 | ChatGPT仅顶层Array检查，null/错误mapping/非数组parts/错误timestamp随后直接访问或sort/filter；Codex等对JSON as类型没有校验字段值。catch解析段没有覆盖导入全过程 |
| 9. 证据/复现 | 临时合法JSON数组[firstConversation,null]在第二项TypeError，不是JSON语法错误；first已提交的事务问题另计DB-001。`as`不会校验rootPaths/version等类型 |
| 10. 触发条件 | 恶意/损坏/格式变化的导出、Agent配置/锁文件、公开状态接口变更 |
| 11. 实际影响 | CLI崩溃、误导输出或同步失败；批量半完成在DB-001处理；不能把JSON输入解释为代码执行 |
| 12. 根本原因 | 混淆类型断言与运行时验证；未建立每个Provider的版本化输入契约 |
| 13. 建议修复 | 手写小型校验器或经评估schema校验；先全量校验item/id/date/mapping/parts再写；有界错误码、不回显原敏感输入；未知版本明确拒绝/降级 |
| 14. 修复优先级 | 第二批；配合DB-001和SEC-003/004 |
| 15. 验收标准 | 各非法结构都得到结构化错误，不崩溃/不部分写入；返回字段满足声明类型；错误日志不包含输入秘密；合法版本fixture可用 |
| 16. 推荐回归测试 | null项、对象mapping错误、parts对象、非法create_time、rootPaths字符串、空/变更版本、状态响应null数组 |
| 17. CWE/OWASP | CWE-20、CWE-704、CWE-248 |
| 已有保护/缺口 | JSON语法try/catch、顶层Array；不足以校验后续结构 |

#### CODE-004：Node 最低版本声明及硬编码 WSL 路径与 Windows 不一致

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | CODE-004 |
| 2. 问题标题 | 固定用户/版本/Linux路径使原生Windows状态功能失效 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 环境配置、Windows兼容、运行版本 |
| 5. 发现状态 | 路径/命令配置已确认；未运行真实状态查询；22.5兼容性由官方版本史确认 |
| 6. 受影响文件 | package.json、README.md、src/codex.ts、src/codex-ops.ts、src/pi.ts、src/hermes.ts、src/chatgpt.ts、src/e2e.ts |
| 7. 准确定位 | package.json:8–14；README:9–11；codex.ts:7–8；codex-ops.ts:7–8；pi.ts:4–6；hermes.ts:5–6、17；chatgpt.ts:67–69；e2e.ts:12–16 |
| 8. 问题描述 | /mnt/c和/home固定到特定用户/安装hash、pgrep依赖Linux；原生Windows Node不会把这些变成相应C:目录。最低>=22.5满足SQLite但TS stripping直到22.6才引入 [N1] |
| 9. 证据/复现 | 全量源码路径常量及node scripts；隔离在Windows Node24可运行核心，但使用Mock绕开外部路径。未声称已验证所有WSL失败情形 |
| 10. 触发条件 | 按文档在Windows或另用户/安装版本运行；使用合法engine范围内Node22.5 |
| 11. 实际影响 | 状态不可读/错误降级、误报未安装，最低版本无法启动TS；部署依赖不可复现 |
| 12. 根本原因 | 环境探测与业务逻辑混写，没有路径/命令注入接口或支持矩阵 |
| 13. 建议修复 | 明确Windows/WSL分别支持的运行配置；用户级可配置路径与provider发现，启动只验证所选适配器依赖；将engine/文档改为经测试的受支持版本，记录实际SQLite安全版本 |
| 14. 修复优先级 | 第二批；无需本次安装/升级任何依赖 |
| 15. 验收标准 | Windows和WSL配置fixture分别正确解析路径；不同用户/安装目录不改源码；最低声明版本能执行start/cli/test；失败区分unsupported与offline |
| 16. 推荐回归测试 | WindowsUnicode/空格路径、不同homedir、缺pgrep、WSL路径映射、最低/当前支持Node版本矩阵 |
| 17. CWE/OWASP | CWE-703；兼容性问题主要非安全CWE |
| 已有保护/缺口 | db自身使用fileURLToPath/join是跨平台写法；外部状态路径缺相同设计 |

#### CODE-005：观察状态缺少 freshness，陈旧锁可被报告为正在运行

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | CODE-005 |
| 2. 问题标题 | 历史配置/创建时间与实时在线/同步时间混淆 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 可观测性、状态真实性、故障隔离 |
| 5. 发现状态 | Mock状态语义已确认；当前真实Agent是否误报待验证 |
| 6. 受影响文件 | src/pi.ts、src/hermes.ts、src/codex.ts、src/chatgpt.ts、src/cli.ts |
| 7. 准确定位 | pi.ts:29–49；hermes.ts:15–21、44–45；codex.ts:75–83；chatgpt.ts:123–125、175、182；cli.ts:156–160、168、203–205、218–225 |
| 8. 问题描述 | Pi仅凭locks.status=connected就running，无进程/时间校验；Hermes probe错误也映射alive=false/degraded而非unknown；Codex只UPSERT不处理消失thread；ChatGPT把会话create_time写last_observed_at，再称last_sync_at |
| 9. 证据/复现 | 合成locks含无真实进程的pid，Pi返回running；Mock execSync错误时Hermes返回degraded；导入时间与MAX(created)链由代码确认 |
| 10. 触发条件 | 陈旧锁、不可用进程查询、会话删除/归档、旧导出今天导入 |
| 11. 实际影响 | 操作者误判Agent在线/离线和同步新鲜度，任务协调依过时元数据；没有已确认真实自动派发后果 |
| 12. 根本原因 | 观察结果没有来源时间/置信度/error/freshness契约，历史数据被升格为当前事实 |
| 13. 建议修复 | 统一观测结果observedAt/sourceTimestamp/freshness/error；探测失败=unknown；锁只作hint并核对进程/lease；同步用snapshot/tombstone或仅scope内归档；created_at与imported_at/observed_at分开 |
| 14. 修复优先级 | 第二批；状态将参与自动调度前 |
| 15. 验收标准 | 陈旧锁不显示confirmed running；探测错误明确unknown；已移除会话不永久活跃；旧会话今天导入显示今天import时间且保留原创建时间 |
| 16. 推荐回归测试 | 陈旧/复用pid锁、探测超时、旧export导入、source删除snapshot、不完整snapshot不能误归档 |
| 17. CWE/OWASP | CWE-754；状态完整性主要可靠性问题 |
| 已有保护/缺口 | Codex session state=unknown不冒充具体进度；部分ChatGPT查询失败unknown；各适配器不一致 |

#### SEC-003：自由文本未经脱敏进入持久化、导出与输出

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-003 |
| 2. 问题标题 | 粘贴的凭据可原样保存在事件/审计/Markdown或诊断中 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 机密信息保护、日志/输出最小化 |
| 5. 发现状态 | 缺脱敏已确认；真实秘密泄漏未发现（风险触发需敏感输入） |
| 6. 受影响文件 | src/tasks.ts、src/chatgpt.ts、src/cli.ts、src/schema.sql |
| 7. 准确定位 | tasks.ts:39、46、98、121–122、140–165；chatgpt.ts:159–161、193–206；cli.ts:80、244、265–266；schema.sql:45、61、78、99 |
| 8. 问题描述 | title/note/reason/任意payload直接序列化，audit detail含title/reason；导出完整对话Markdown；JSON异常message可能含输入短片段；无redactor、敏感标记、保留政策或明确导出授权范围 |
| 9. 证据/复现 | 仅使用无任何认证能力的合成marker，事件payload和audit detail保留marker；短非法JSON marker进入error。初次长marker断言失败已在第9节披露，不用于夸大完整秘密回显 |
| 10. 触发条件 | 用户或Agent把真实key/token/password放自由文本/导出；其他人可读库/日志/导出/共享终端 |
| 11. 实际影响 | 凭据持久扩散至低保护介质；受SEC-002权限放大。当前没有秘密能据此撤销/轮换，也未测试其有效性 |
| 12. 根本原因 | 把任意文本当普通数据存/打印，缺内容最小化与敏感数据政策 |
| 13. 建议修复 | 入口禁收认证材料；日志结构化allowlist、对常见秘密值脱敏但不声称regex完整防护；任务metadata不保存认证参数；原始导出明确敏感artifact权限/保留与用户选择，错误只给路径/码不回显原文 |
| 14. 修复优先级 | 第二批前列；生产前；若发现真实key立即升级处置优先级 |
| 15. 验收标准 | 合成凭据marker在DB事件/审计、CLI、诊断和非原始授权导出中不出现；必要原始导出权限受限、显式保留；当前与历史扫描无真实凭据或有已轮换记录 |
| 16. 推荐回归测试 | title/note/reason嵌套payload、Authorization/URL/短密码fixture、解析错误、异常对象、CLI JSON、导出/备份敏感级别 |
| 17. CWE/OWASP | CWE-532、CWE-200、CWE-209；OWASP Secrets/Logging [O1]、[O2] |
| 已有保护/缺口 | 当前不主动读Cookie/token，网络GET不传本地payload；并不防用户文本含秘密 |

#### SEC-004：文件导入与列表查询没有资源上限

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-004 |
| 2. 问题标题 | 无限量同步读取/JSON解析/输出可能耗尽桥进程资源 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 资源耗尽、可用性、输入边界 |
| 5. 发现状态 | 高可信风险；未运行大文件/DoS攻击或资源耗尽测试 |
| 6. 受影响文件 | src/chatgpt.ts、src/codex.ts、src/cli.ts、src/tasks.ts |
| 7. 准确定位 | chatgpt.ts:159、170–206；codex.ts:35；cli.ts:239–244；tasks.ts:55–62、140–143 |
| 8. 问题描述 | readFileSync整文件、JSON.parse整结构、parts/markdownLines全文积累、多份字符串复制、task-list .all无分页；无大小/消息数/字段长/预算限制 |
| 9. 证据/复现 | 静态可达CLI import/list路径，未找到stat大小检查/limits；curl timeout与execSync默认maxBuffer属于部分子进程保护，不涵盖文件导入 |
| 10. 触发条件 | 已获本地CLI调用能力的用户/上游Agent提供超大导出或积累大量任务；不提供外网DoS入口 |
| 11. 实际影响 | 单次CLI高内存/阻塞/OOM；未来同进程服务可能影响全部观察与控制；当前短命CLI影响范围有限 |
| 12. 根本原因 | 未把外部内容作为有预算输入；同步API全量处理 |
| 13. 建议修复 | 最大文件/会话/消息/字段/总输出限制和受控分页；大导出采用有界增量导入/流式写出；不可读特殊文件拒绝；超预算在写DB前结束；取消/超时合约 |
| 14. 修复优先级 | 第二批；大文件/服务化前 |
| 15. 验收标准 | 预设大小边界以内成功，超过边界非0且无写入；内存/时间预算可测；列表分页上界；中止后不遗留半成数据 |
| 16. 推荐回归测试 | 小型边界fixture、超过限制1字节、超消息数/字段长度、分页稳定排序、取消import；不要生产DoS |
| 17. CWE/OWASP | CWE-400、CWE-770 |
| 已有保护/缺口 | curl/PowerShell/pgrep有时间限制；导入和DB全量读不受此限制 |

#### ARCH-001：查询、帮助和错误命令都先开可写库并执行 Schema

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | ARCH-001 |
| 2. 问题标题 | CLI未区分只读查询与初始化写操作 |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 架构边界、只读操作安全、CLI耦合 |
| 5. 发现状态 | 已确认代码和隔离运行；未在原库执行CLI |
| 6. 受影响文件 | src/cli.ts、src/db.ts、src/index.ts、package.json |
| 7. 准确定位 | cli.ts:13–18、270–289；db.ts:14–28；index.ts:5–17、37–44；package.json:8–9 |
| 8. 问题描述 | 解析命令前createDb，mkdir+可写打开+PRAGMA WAL+schema；help/unknown/status/audit都可创建库或建表。start是往默认业务库写演示任务的自检，非只读健康检查 |
| 9. 证据/复现 | 隔离副本无原生产库，CLI命令执行后data/bridge.db建立；源码初始化发生在分支之前。原index从未执行 |
| 10. 触发条件 | 对未初始化/旧Schema目录执行帮助或查询；只读操作员无法写目录；误把npm start当健康检查 |
| 11. 实际影响 | 观察命令也需要写权/可能锁库和改schema；读写权限无法分工；自检污染业务台账 |
| 12. 根本原因 | 持久化初始化是入口import副作用，演示/生产路径共用，没有lazy readonly/显式init |
| 13. 建议修复 | 先解析；help/usage不打开库；查询readOnly且不运行schema；init/migrate显式写；demo selftest使用唯一临时库且检查失败exit非0；入口关闭资源 |
| 14. 修复优先级 | 第二批；配合SEC-002和CODE-001 |
| 15. 验收标准 | help/错误命令不新建任何data文件；查询在只读权限下成功且DB/hash/sidecar不变；只有init/migrate建schema；start语义文档一致、演示不入真实库 |
| 16. 推荐回归测试 | 空目录help/status、只读DB查询、未知命令无文件差异、旧schema提示、演示隔离、初始化失败关闭 |
| 17. CWE/OWASP | CWE-703；读写分工是架构/可靠性问题，未据此确认独立越权漏洞 |
| 已有保护/缺口 | DbOptions可选择其他路径，方便隔离；CLI未暴露路径/只读选择并在帮助前写初始化 |

#### TEST-001：默认测试零覆盖，现有 e2e 的隔离路径不安全

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | TEST-001 |
| 2. 问题标题 | test空跑可形成误导性绿灯，e2e删除固定文件且依赖真实Agent |
| 3. 严重度 | P2 / Medium |
| 4. 问题类别 | 测试有效性、安全隔离、工程保障 |
| 5. 发现状态 | 已确认本次Node24脚本行为；其他Node对空glob行为未运行 |
| 6. 受影响文件 | package.json、src/e2e.ts、src/index.ts、README.md |
| 7. 准确定位 | package.json:10；e2e.ts:11–16、89–108；index.ts:25–44；README.md:88、96–97 |
| 8. 问题描述 | test指向不存在的*.test.ts，未接入e2e；Node24发现0tests仍exit0。e2e强制删固定/tmp主库+wal+shm，可与其他测试/文件冲突；读取真实配置并要求Hermes running。README声称18项，实际20；index无断言失败也打印约束成立 |
| 9. 证据/复现 | 原test对应命令输出tests0/pass0/exit0；隔离e2e保留断言20通过。未执行原固定删除路径或查询真实Hermes |
| 10. 触发条件 | CI/开发者执行test期待有效回归；两e2e并行或/tmp同名文件已有；将index输出当验收 |
| 11. 实际影响 | 核心竞争/安全缺陷不被发现；测试串扰或删除非本轮临时数据；README保证不可据现环境直接复核 |
| 12. 根本原因 | 未建立标准runner接入和唯一临时资源/Mock fixtures/覆盖门槛 |
| 13. 建议修复 | 既有逻辑接入node:test或等效runner；0测试失败；每次mkdtemp/唯一DB并finally清理本轮文件；外部依赖Mock/可选集成标记；明确测试成功/失败退出码 |
| 14. 修复优先级 | 第二批；第一批整改至少同步建立有效回归 |
| 15. 验收标准 | test实际运行非0断言、无测试时非0；本报告核心回归可稳定执行；两套测试并行不交叉；原库/Agent/付费API不触碰；文档数量与命令一致 |
| 16. 推荐回归测试 | 测试发现门槛、临时目录并行、故障清理、Mock缺失拒绝、故意断言失败验证exitCode |
| 17. CWE/OWASP | CWE-754；测试设计大部分不适用漏洞编号 |
| 已有保护/缺口 | e2e负例和exit(fail>0)有价值；固定路径与默认test未连接 |

### 10.3 P3 / Low

#### DB-005：没有 Schema 版本与迁移机制

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-005 |
| 2. 问题标题 | CREATE IF NOT EXISTS不能升级已有库 |
| 3. 严重度 | P3 / Low |
| 4. 问题类别 | 数据版本兼容、工程维护 |
| 5. 发现状态 | 机制缺失已确认；当前Schema不兼容故障未发现 |
| 6. 受影响文件 | src/db.ts、src/schema.sql |
| 7. 准确定位 | db.ts:27–28；schema.sql:11–110的IF NOT EXISTS；只读PRAGMA user_version=0 |
| 8. 问题描述 | 无migration表/user_version更新/版本断言，旧库升级不会自动获得新增列/约束；每次重跑schema无法判断版本差异 |
| 9. 证据/复现 | 原库schema与本次源码相符且user_version0；未构造不存在的现有升级故障，也未升级原库 |
| 10. 触发条件 | 后续修改字段/约束、混用新旧应用版本或恢复旧备份 |
| 11. 实际影响 | 新代码运行SQL失败、约束缺失或不兼容回滚；当前是低优先结构性风险 |
| 12. 根本原因 | 初始建表被当成完整初始化/升级策略 |
| 13. 建议修复 | 加小型线性迁移、版本校验、事务、备份/失败回滚设计；read命令只报告版本，不自动迁移；不必引入完整ORM |
| 14. 修复优先级 | 第三批，但DB-003/004 Schema整改前必须提前实施 |
| 15. 验收标准 | 从现0版本到目标版保留数据/FK/索引；重复迁移无变化；中途失败回滚；新应用拒绝未知未来版，旧应用不会静默破坏新版 |
| 16. 推荐回归测试 | 0→新版本、重复升级、缺列旧版、断点失败、未知未来版、备份恢复版本检查 |
| 17. CWE/OWASP | 不适用当前已确认安全漏洞编号；主要工程/版本兼容问题 |
| 已有保护/缺口 | IF NOT EXISTS可重复初始化；不能改变既有表 |

#### SEC-005：日志与终端打印未转义不可信控制字符

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-005 |
| 2. 问题标题 | 外部文本可伪造日志行或改变终端显示 |
| 3. 严重度 | P3 / Low |
| 4. 问题类别 | 日志注入、输出完整性 |
| 5. 发现状态 | 不转义代码路径已确认；未在用户真实终端发送控制序列 |
| 6. 受影响文件 | src/cli.ts、src/tasks.ts |
| 7. 准确定位 | cli.ts:29、54、141、160、172、182–184、266；tasks.ts:46、122、134、164–165 |
| 8. 问题描述 | title/reason/name/扩展/网络incident直接拼日志或stdout，允许换行、ESC/ANSI等；普通表格显示可被外部内容伪造 |
| 9. 证据/复现 | 插值输出及字符串audit detail路径逐行确认，无编码/控制字符过滤；不执行终端payload，故不声称任意命令执行 |
| 10. 触发条件 | 输入包含换行/控制字符并被人/自动解析器读stdout日志 |
| 11. 实际影响 | 混淆actor/成功提示、隐藏或覆盖显示内容，降低审计可读性；影响终端/消费者，不变成shell命令 |
| 12. 根本原因 | 人类显示字符串和原始外部内容未分离 |
| 13. 建议修复 | 结构化日志，显示层转义换行/ANSI/C0控制字符；明确每条事件单行；原始文本若必要存受限artifact，输出hash/引用 |
| 14. 修复优先级 | 第三批；与SEC-003日志policy一起 |
| 15. 验收标准 | 合成换行/ESC字符串只显示可见转义，无新增伪造audit行、无屏幕控制；JSON输出正确escape，日志主体字段固定 |
| 16. 推荐回归测试 | 控制字符/CRLF/Unicode方向字符fixture，捕获stdout字节验证，禁止向真实用户终端发攻击串 |
| 17. CWE/OWASP | CWE-117、CWE-150；OWASP Logging [O2] |
| 已有保护/缺口 | JSON.stringify可转义task-show部分内容；普通console插值不受其保护 |

#### ARCH-003：文档声称的外部集成缺少可审查交付边界

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | ARCH-003 |
| 2. 问题标题 | 已完成能力说明无法从本项目源码与部署清单复核 |
| 3. 严重度 | P3 / Low |
| 4. 问题类别 | 架构/文档一致性、部署可复现性 |
| 5. 发现状态 | 项目内无所列外部脚本已确认；脚本可能在别处/实际部署待验证 |
| 6. 受影响文件 | README.md、docs/[HOST]-research.md、src/codex-ops.ts、src/cli.ts |
| 7. 准确定位 | README.md:79–88；开发文档:74–117、121–159；codex-ops.ts:21–40；cli.ts:248–254 |
| 8. 问题描述 | 文档声称CDP/relay/codex-send闭环实测、零凭据泄漏；源码没有relay.py/codex_send_cdp.py/cdp_messages.py、来源版本/路径/调用合约、CDP授权设计；fork仅审批申请，build函数不执行。不能据README复选框推断完整控制桥 |
| 9. 证据/复现 | 全16文件目录及21命令分支；没有exec CodexOp或外部relay模块。未搜索无关目录/重启应用复测；未否定过去文档中的实测是否曾发生 |
| 10. 触发条件 | 新维护者按仓库交付部署、认为安全/控制闭环已验证、用CDP方案接自动派发 |
| 11. 实际影响 | 依赖/授权边界缺失、能力误解和验收不可复现；实际CDP端口/日志安全不能判定 |
| 12. 根本原因 | 外部环境实测记录与可交付产品能力混写，缺集成清单/版本/入口与安全验收证据 |
| 13. 建议修复 | 区分仓库实现、外部工具、历史实测、未实现；交付可复核依赖清单/授权入口/接口版本，不纳入秘密；CDP仅受控本地访问、生命周期与授权另审，不凭不读Cookie宣称零泄漏 |
| 14. 修复优先级 | 第三批；真实控制/CDP上线前提前 |
| 15. 验收标准 | 每项完成声明可定位代码/外部版本和安全fixture；不存在工具时文档明确可降级；CDP/relay授权、数据边界、端口暴露另有审查记录；没有无证据绝对安全说法 |
| 16. 推荐回归测试 | 干净隔离环境按文档部署、外部工具缺失、Mock relay输入不可信/空/mismatch、授权拒绝；实Agent操作需单独授权 |
| 17. CWE/OWASP | 主要文档/架构问题，无确认CWE漏洞；未来调试接口授权参照CWE-306 |
| 已有保护/缺口 | fork-request明确不自动执行；研究文档记录一些负例。缺当前交付范围/可复核证明 |

#### SEC-006：没有敏感运行文件的 Git 忽略/提交前防护

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | SEC-006 |
| 2. 问题标题 | README“不入git”没有规则保障 |
| 3. 严重度 | P3 / Low |
| 4. 问题类别 | 预防性秘密/运行数据提交保护 |
| 5. 发现状态 | 规则缺失已确认；未来误提交为高可信风险，当前Git泄漏未确认 |
| 6. 受影响文件 | 项目根目录缺 .gitignore/.git；README.md、data/bridge.db |
| 7. 准确定位 | 文件清单/隐藏项检查；缺文件无源码行号；README.md:24 |
| 8. 问题描述 | 实际业务DB在源码目录，README称不入git但无.ignore；将来init/拷贝入仓库时数据库、wal/shm、日志、导出和.env容易进入提交。当前非Git仓库不能称“已误提交” |
| 9. 证据/复现 | 初始git status/rev-parse非仓库；文件清单16项含DB且无.ignore；未init Git或试验提交 |
| 10. 触发条件 | 后续建立Git、批量add、把项目放入父仓库、发布归档 |
| 11. 实际影响 | 将来业务数据/凭据可能进入持久历史，删除当前文件无法修复历史；现阶段无确认真实秘密 |
| 12. 根本原因 | 防护停留在文档约定，没有可执行提交防护和离线扫描 |
| 13. 建议修复 | 在首提交前建立针对DB/sidecar/env/log/cache/export的ignore，保留无秘密示例；提交前/CI扫描。取得真实仓库后检查tracked/全部refs，已跟踪文件忽略不够，需要另行历史处置 |
| 14. 修复优先级 | 第三批；首次Git提交/公开发布前必须 |
| 15. 验收标准 | git check-ignore核实各敏感fixture；git ls-files无真实运行文件；全部refs离线扫描结果可追踪；真实key若曾入史有撤销/轮换证据，而非仅删文件 |
| 16. 推荐回归测试 | .env.local/production、DB-wal/shm、日志/导出fixture、误跟踪负例、扫描注入的无效合成key |
| 17. CWE/OWASP | CWE-200、CWE-540（若未来含secret文件提交）；当前为预防性缺口 |
| 已有保护/缺口 | private:true限制npm发布；不影响Git/文件归档 |

### 10.4 P4 / Informational

#### ARCH-002：统一观察/执行合约值得补充，CLI业务SQL可渐进收敛

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | ARCH-002 |
| 2. 问题标题 | 缺统一Provider能力、观察结果和受控执行接口 |
| 3. 严重度 | P4 / Informational |
| 4. 问题类别 | 可维护性、扩展、依赖设计 |
| 5. 发现状态 | 结构已确认；设计建议不是已实现能力或当前漏洞 |
| 6. 受影响文件 | src/types.ts、src/cli.ts、src/chatgpt.ts、src/codex.ts、src/pi.ts、src/hermes.ts、src/codex-ops.ts |
| 7. 准确定位 | types.ts:16–17；cli.ts:2–11、40–54、241–266；chatgpt.ts:13–209；各status返回类型；codex-ops.ts:10–15 |
| 8. 问题描述 | 所有具体模块和直接SQL集中入口；ChatGPT多职责；没有统一capability、observedAt/freshness或dispatch/cancel/observe/recover合约。增Provider要修改多处类型/CLI |
| 9. 证据/复现 | 运行时import图无循环，固定Executor联合类型、不同status接口、21分支直接SQL；目前规模小，没有据此宣称架构必须重构 |
| 10. 触发条件 | 新增Agent、服务化、增加真实控制/取消或复用核心API |
| 11. 实际影响 | 维护成本与跨provider语义漂移增加；当前可继续轻量开发 |
| 12. 根本原因 | 原型围绕单次CLI功能增量构建，无受控适配契约 |
| 13. 建议修复 | 窄Adapter接口+能力声明；观察与执行分开；TaskStore保留台账边界，可信控制服务提供授权/审批；把业务SQL移服务方法；按功能演进，不引入复杂DI框架 |
| 14. 修复优先级 | 第三/四批；安全和数据正确性之后 |
| 15. 验收标准 | 以Mock新增第五provider不改核心状态机；不支持控制能力明确拒绝；CLI不负责业务SQL；观察只能返回事实不会自动授权 |
| 16. 推荐回归测试 | Provider contract fixtures、unsupported capability、观察→控制边界、核心服务无CLI复用测试 |
| 17. CWE/OWASP | 不适用；架构建议 |
| 已有保护/缺口 | 具体模块已拆分且无循环；统一层尚缺 |

#### DB-006：备份、保留、索引和连接管理需要最小运维合约

| 字段 | 内容 |
|---|---|
| 1. 问题编号 | DB-006 |
| 2. 问题标题 | 缺少明确恢复/保留/规模与连接生命周期政策 |
| 3. 严重度 | P4 / Informational |
| 4. 问题类别 | SQLite运维、长期可靠性 |
| 5. 发现状态 | 政策/代码缺失已确认；未确认当前性能/磁盘/资源泄漏故障 |
| 6. 受影响文件 | src/db.ts、src/schema.sql、src/tasks.ts、src/cli.ts |
| 7. 准确定位 | db.ts:14–30；schema.sql:53–54、66、93–109；tasks.ts:55–62、177–187；cli.ts:13–14、289 |
| 8. 问题描述 | 无备份/恢复/retention/审计归档、事件去重索引政策、连接close/failure-cleanup合约；有限索引和全量列表将来可能不适配大台账。UUID用Math.random但不是凭据，不独立算认证漏洞 |
| 9. 证据/复现 | 全量源码无相关模块/脚本；当前库仅50条记录、完整性ok，不臆测实际锁死/泄漏/性能故障 |
| 10. 触发条件 | 长期持续写入、数据库损坏、迁移失败、作为长期嵌入库使用或任务量增加 |
| 11. 实际影响 | 恢复目标不明确、敏感数据保留过久、未来查询成本/句柄管理问题；当前属运维准备 |
| 12. 根本原因 | 面向短命原型CLI设计，缺运行SLO与数据生命周期约束 |
| 13. 建议修复 | 文档化RPO/RTO与受限备份、恢复演练；保留审计但归档/脱敏过期payload；仅基于查询计划/规模加source/lease/alert索引；finally关闭连接，初始化失败清理；可改用crypto.randomUUID作质量改进 |
| 14. 修复优先级 | 第四批；长期运行前完成备份/恢复部分 |
| 15. 验收标准 | 隔离恢复演练满足选定RPO/RTO、保留/FK一致；备份ACL受限；重复调用无连接数增长；代表性规模查询预算记录；清理策略不会删待执行任务/关键审计 |
| 16. 推荐回归测试 | 备份→恢复到临时库、旧备份版本、retention边界、连接初始化失败、规模fixture查询计划 |
| 17. CWE/OWASP | 不适用当前漏洞；潜在资源/数据生命周期另参CWE-664 |
| 已有保护/缺口 | WAL/外键/基础索引和完整性检查良好起点；不能替代运维策略 |

## 11. 修复路线图

路线图是后续整改建议，**本次没有实施任何修复**。可以拆成小任务，先建立约束与验证，再加真实控制能力。不能仅修CLI身份参数而仍让不可信Agent任意写SQLite。

| 批次 / 推荐顺序 | 问题编号 | 依赖关系 | 修复目标与收益 | 验收条件 |
|---|---|---|---|---|
| 第一批：立即，1 | SEC-002 | 明确允许的OS主体/可信控制入口 | 收窄源码、DB、导出/备份的本地读写边界；防绕过所有状态机校验 | 非授权本地主体不能读敏感数据/改源码及DB；授权操作正常；不依赖本次管理员变更 |
| 第一批：立即，2 | SEC-001、CODE-001的验收冲突部分 | caller信任模型；与SEC-002协调 | 验收权限与角色文本分离、强制holder/instance、拒冲突flags | 改--by不能自审；异owner拒绝；缺/冲突决策不改变状态 |
| 第一批：立即，3 | STATE-001、DB-001 | 原子命令结果与可信caller | CAS原子claim、短事务、事件/审计同提交；避免双领和半完成 | barrier测试恰1成功；逐写入故障全回滚；终态竞争不覆写 |
| 第一批：可并行，4 | CODE-002 | 安全独立输出路径、失败合约 | 立即阻止输入/已有md覆盖；保护人工导出数据 | 大小写扩展名/已有输出/同路径负例保留原hash |
| 第二批：短期，1 | TEST-001、CODE-001其余 | 第一批修复定义明确可验证合约 | 标准runner、错误退出码、参数与enum校验；让回归有效 | tests>0，故意失败exit非0；各CLI错误无业务变更；并行测试隔离 |
| 第二批：短期，2 | DB-002、STATE-003 | DB-001/STATE-001；可信approval caller | 有限busy策略、一次性审批/CAS结果 | 短锁正常重试、长锁明确错误；missing不写成功审计；同approval一次消费 |
| 第二批：短期，3 | CODE-003、SEC-003、SEC-004 | 稳定错误码与事务 | 验证JSON契约、资源预算、内容最小化/脱敏；把外部数据约束在入口 | malformed/超界输入无partial write；敏感marker不进日志/诊断；正常导出可控 |
| 第二批：短期，4 | DB-003、DB-004；提前DB-005 | 先版本迁移、旧数据统计；输入契约 | 增DB约束、source命名空间、迁移保留FK | 0版升级/重复升级/失败回滚通过；非法值拒绝；跨provider同ID独立 |
| 第二批：短期，5 | STATE-002、CODE-005、CODE-004 | 身份/attempt/CAS、可配置观察 | 续约/显式恢复、freshness、Windows配置和真实运行版本 | 旧回调拒绝；长任务可续约；失败unknown；双平台fixtures及最低版本检查 |
| 第二批：短期，6 | ARCH-001 | CLI解析/命令分类；读写权限规划 | help/query不写库，演示自检临时化 | 只读运行成功且文件不变；help不建库；明确init/migrate才写schema |
| 第三批：结构性，1 | DB-005剩余、ARCH-002 | 首两批正确性和测试 | 小型迁移制度、统一Provider观察/控制合约，收敛直接SQL | 插件fixture不改状态机；unknown未来schema拒绝；能力未支持明确错误 |
| 第三批：结构性，2 | SEC-005、SEC-006、ARCH-003 | 日志/凭据policy、可取得真实Git仓库/外部交付 | 输出转义、提交保护、集成能力/授权证据可追踪 | 控制字符fixture安全；ignore/全refs扫描；完成声明可定位实现与版本 |
| 第四批：长期 | DB-006、ARCH-002持续演进 | 明确数据量/RPO/RTO，已有安全边界 | 恢复演练、retention、需要时索引/连接管理，避免过度架构 | 隔离恢复达标、备份受限、规模预算记录、长期句柄稳定 |

推荐最先修复的三个单项：**SEC-002（本地文件边界）、SEC-001（真实验收身份）、STATE-001（原子领取）**；STATE-001 必须同步实施 DB-001 事务，否则只防双领仍会产生半完成状态。导入覆盖 CODE-002 可同时快速封堵。

## 12. 最终验收清单

以下是**后续整改验收**，本次审计未修复，因此不勾选；不能把当前问题描述当作已经整改。

- [ ] 明确可调用CLI/控制入口的主体，执行者改--by user/hermes不能获取独立验收权限。
- [ ] 非holder/旧attempt对finish/heartbeat/cancel返回授权或冲突错误，DB/event/audit无误写。
- [ ] 非授权本地账号不能读取敏感DB/导出、修改源码/DB；新wal/shm/备份同样受限。
- [ ] 至少两个独立连接同snapshot claim只有1个成功，任务owner和对应事件一致。
- [ ] verify/cancel/retry竞争不复活终态，旧状态版本update命中0时明确失败。
- [ ] 对create/claim/finish/verify/cancel各持久化步骤注入失败后事务全部回滚，无无owner的RUNNING。
- [ ] approvals只允许pending决策一次；missing审批返回错误且没有成功审计；参数不同不可复用批准。
- [ ] 配置busy总预算；短writer锁释放后一次生效，超预算明确失败且无partial commit。
- [ ] 任务可由真实holder续约，过期任务有显式带审计恢复流程；旧attempt回调不能污染新任务轮次。
- [ ] 返工轮次有独立开始/结束/owner/error，不能沿用旧租约和旧started_at作为新轮时间。
- [ ] .JSON/.Json/无后缀输入及已有输出不被导入覆盖，安全输出采用独立路径/排他创建。
- [ ] malformed导出先完整校验，null项/错误parts/date/source返回结构化非0错误且无写入。
- [ ] 文件大小/项数/字段长/总输出及列表页大小有限，超预算拒绝且不产生半成记录。
- [ ] 合成机密marker不出现在事件/审计/普通CLI/解析诊断；必要原始导出有明确敏感权限/保留规则。
- [ ] 日志/表格输出换行、ANSI和C0控制字符被可见转义，不能伪造actor或屏幕成功行。
- [ ] DB拒绝非法status/provider/decision/空主键；允许的nullable字段与FK逻辑正常。
- [ ] 同external_id不同source可独立保存；重复同source导入幂等；原task.session_id迁移后有效。
- [ ] Schema迁移从现0版本保留全部有效记录；中途失败回滚；未知未来版本拒绝；读命令不自动升级。
- [ ] help/unknown命令不创建DB，查询以readOnly打开、不初始化schema；演示自检不写业务库。
- [ ] CLI错误使用stderr与非0码，--pass/--fail恰一项，所有已文档参数与实现一致。
- [ ] test命令实际发现和执行测试，0测试失败；故意断言失败能阻断；两套并行测试不访问同库。
- [ ] 陈旧Pi锁和探测异常不误报confirmed running/offline；状态明确来源、observedAt、freshness和error。
- [ ] Windows/WSL所选provider分别有配置fixture，最低声明Node版本可以运行TS/SQLite与测试。
- [ ] 取得真实Git仓库后检查tracked文件与全部refs；敏感运行文件忽略规则生效；历史漏密若有先轮换再清理。
- [ ] 外部CDP/relay/飞书工具有明确路径/版本/授权合约和独立安全测试；没有本仓库证据的功能不标已实现。
- [ ] 在隔离库完成备份恢复演练、retention边界测试，明确RPO/RTO并保持审计/任务关联有效。

## 13. 总体结论

当前项目可以在**只有可信本地操作者、串行人工更新、受限目录权限、状态仅作台账参考**的条件下继续试用。即使在这些条件下，也应先避免会覆盖原文件的导入操作。不要把它当作可靠授权层、并发执行调度器或真实Agent实时运行事实来源。

上线或长期运行前，必须解决文件权限与真实caller、原子领取/事务、CLI明确决策与失败码、导入不覆盖；使有效测试成为发布条件。将跨Agent控制接入之前，还必须定义审批一次消费、任务attempt/lease、取消请求与真实确认、崩溃恢复、输入与凭据边界。当前没有真实控制执行器，不能以台账cancel证明Agent已停止。

主要技术债是**事务/CAS/attempt缺失、观察语义与环境配置硬编码、测试空跑、Schema无版本和CLI直接SQL**。主要安全风险是**调用者自报验收身份与宽文件权限**；本次未确认真实机密泄漏，但自由文本持久化/输出会让未来粘贴的秘密扩散。没有发现可达命令注入/SQL注入/RCE，不用理论上的“多Agent风险”夸大为Critical。

建议沿当前小规模架构渐进补齐窄契约和可靠持久层。借鉴CrewAI/LangGraph的持久化、恢复、测试方式，AutoGen取消/团队状态API可以作参考，但它已处于维护模式；不必为了对标把本项目改成完整大型框架。OpenHands的Windows文档与服务边界有直接参考意义，实际集成与安全配置仍需要单独验证。

## 14. 证据与参考资料

### 14.1 本地证据与范围

每条第10节定位均基于2026-10-10读取的原文件行号，未基于生成副本的行号。关键入口可点击：

- [任务API与事务边界](<D:/Agent control bridge/src/tasks.ts:19>)；[状态转换/领取](<D:/Agent control bridge/src/tasks.ts:66>)；[验收](<D:/Agent control bridge/src/tasks.ts:103>)；[审批](<D:/Agent control bridge/src/tasks.ts:147>)；[租约扫描](<D:/Agent control bridge/src/tasks.ts:175>)。
- [Schema](<D:/Agent control bridge/src/schema.sql:11>)；[数据库初始化](<D:/Agent control bridge/src/db.ts:14>)；[类型/转换表](<D:/Agent control bridge/src/types.ts:82>)。
- [CLI参数与业务入口](<D:/Agent control bridge/src/cli.ts:13>)；[CLI导入登记](<D:/Agent control bridge/src/cli.ts:233>)；[ChatGPT导入与输出](<D:/Agent control bridge/src/chatgpt.ts:155>)。
- [Codex观察/同步](<D:/Agent control bridge/src/codex.ts:30>)；[仅参数构造的Codex操作](<D:/Agent control bridge/src/codex-ops.ts:22>)；[Pi观察](<D:/Agent control bridge/src/pi.ts:16>)；[Hermes观察](<D:/Agent control bridge/src/hermes.ts:15>)。
- [自检写默认库](<D:/Agent control bridge/src/index.ts:5>)；[e2e固定删除/测试库](<D:/Agent control bridge/src/e2e.ts:11>)；[运行脚本](<D:/Agent control bridge/package.json:7>)；[README声明](<D:/Agent control bridge/README.md:79>)；[外部调研记录](<D:/Agent control bridge/docs/[HOST]-research.md:74>)。

DB证据是Schema、统计、integrity_check/foreign_key_check与文件头，不包含原任务标题、ID、会话正文、审计detail或秘密值。8张表统计：projects=3、sessions=14、tasks=5、events=17、approvals=1、deliverables=1、audit_log=8、alerts=1。

### 14.2 执行的检查与命令摘要

原工作区只读命令采用Windows路径引号/`-LiteralPath`，Git使用`--no-optional-locks`。PowerShell/python输出统一UTF-8。未使用管理员、RunAs、安装、自动修复或修改lockfile。

```powershell
Get-ChildItem -LiteralPath 'D:\Agent control bridge' -Force
rg --files --hidden -g '!node_modules/**' -g '!dist/**' -g '!.git/**' 'D:\Agent control bridge'
git --no-optional-locks -C 'D:\Agent control bridge' status --porcelain=v1 -uall
git --no-optional-locks -C 'D:\Agent control bridge' rev-parse --show-toplevel
Get-Acl -LiteralPath 'D:\Agent control bridge\data\bridge.db'
Get-Acl -LiteralPath 'D:\Agent control bridge'
node --version
```

使用聊天工作目录下的Python审计辅助文件执行baseline、scan、read、db、verify和扩展机密/字段/导入图检查。具体辅助位置：`C:\Users\[USER]\Documents\Codex\2026-10-10\typescript-node-js-agent-agent-code\work`。只读SQLite打开字符串为 `file:///D:/Agent%20control%20bridge/data/bridge.db?mode=ro&immutable=1`，未调用createDb打开生产文件。检查数据库时无WAL/SHM旁文件且hash复核稳定；immutable不读取未来新写入，因此结论限定这一稳定快照，不用于实时状态观察。

隔离目录为该work下的 `isolated bridge`，以下命令仅在副本执行：

```powershell
node --experimental-strip-types --experimental-sqlite audit-probes.mjs
node --experimental-strip-types --experimental-sqlite supplemental.mjs
node --experimental-strip-types --experimental-sqlite --test 'src/**/*.test.ts'
node --experimental-strip-types --experimental-sqlite --import './mock-runtime.mjs' 'src/e2e-isolated.ts'
```

第三条是package test脚本的等效直接Node执行，而非通过npm执行；没有npm install/audit。第一条内部包含带shell=false的隔离CLI命令：unknown-command、task-claim missing、task-verify（缺id）、task-create（合成标题/非法provider/-k）、合成任务的--pass --fail验收。所有控制只改副本台账，不调用真实Agent。双Worker连接与临时触发器等条件详见第9和第10节。

检查器曾遇到两类辅助环境错误：初次Python中文输出编码失败后改为UTF-8重新完整读取；扩展扫描辅助模块首次import缺mode参数后改为可导入再次完成。它们不涉及项目源码/数据库变更，不计为产品缺陷。外部一个猜测的Node公告URL未取得内容，最终使用官方漏洞索引实际链接确认，不将该失败URL作为参考或漏洞证据。

### 14.3 公开源码证据索引

下列参考链接固定到本次HEAD或官方页面。括号行号是本次下载源码对应位置；未执行公开仓库测试，不给“全通过”结论。

| 标识 | 本次核实内容 |
|---|---|
| A1 | AutoGen README维护模式/分层设计（20–25及相关章节） |
| A2 | BaseAgent（60–158），消息/取消参数、默认save/load警告 |
| A3 | BaseGroupChat：_is_running（483–485），pause/resume（657/703），save/load（748/798），取消一致性警告（260–261、370–371） |
| A4 | CancellationToken（6–46），lock/callback/link_future |
| A5 | DockerCommandLineCodeExecutor（85起），timeout>=1（182–183），可选Docker执行能力 |
| A6 | test_cancellation.py（65起），含nested取消断言；没有运行 |
| C1 | BaseAgentAdapter（15–46），tools/structured output契约 |
| C2 | Task（171–173、252起），async_execution、guardrail配置，不将guardrail视为授权边界 |
| C3 | Flow runtime（741、1345、1398、1606、2077、2142、2409、3554），checkpoint恢复、resume、async执行；flow.py是兼容重导出，追到了runtime真实实现 |
| C4 | SQLiteFlowPersistence（26、86–106、193–215、249起），锁/忙预算/状态和pending feedback保存 |
| C5 | CrewAIEventsBus（95、179、245、572），事件注册与emit |
| C6 | Flow persistence测试源码；有测试不是测试运行证据 |
| C7 | 官方MCP安全文档；属于文档声明，未证明所有默认配置自动安全 |
| L1 | SqliteSaver（100、147–166、200–207、400/458），锁/表/事务/写入契约；线程锁不等于跨进程租约 |
| L2 | Pregel loop（446、698–702、782–786、1460起），checkpoint写、interrupt与durability |
| L3 | SDK integration test_cancel源码，未运行后端/SDK取消测试 |
| L4 | Pregel测试源码，未运行模型/框架测试 |
| W1 | Windows PowerShell quickstart、Docker与WSL2差异（1–38） |
| W2 | [HOST] workflow（38–39），windows-latest打包配置，未查看/运行通过记录 |
| W3 | agent-server conversation API（86–87、371–372、459），timeout/paused/confirmation/session key边界 |
| W4 | runtime adapter（29–56），command timeout和HTTP timeout区分 |
| W5 | docker-conversation-boundaries测试（54–55、159起），隔离conversation边界断言，未运行 |

### 14.4 官方技术与安全资料

- [N1]：Node TypeScript stripping在v22.6引入、只擦除不检查类型、不读取tsconfig。
- [N2]：本次v24.19.0 DatabaseSync/只读/同步/timeout文档。
- [N3]：child_process 默认env继承和shell执行语义，仅作静态信任边界依据。
- [N4]：Node 2026-07-29安全发布；已查SQLiteTagStore等相关条件，没有把所有公告漏洞映射成本项目可达风险。
- [S1]：WAL并发、单writer与WAL-reset bug修复说明。
- [S2]：PRAGMA busy_timeout/foreign_keys/user_version语义。
- [S3]：SQLite文本PK NOT NULL/CHECK行为；与隔离实测一致。
- [S4]：SQLite 3.53.3官方release说明。
- [O1]、[O2]：OWASP秘密管理/日志保护；支持内容最小化、权限与轮换建议。
- [O3]：OWASP Prompt Injection，工具边界授权必须独立于不可信文字；本项目当前没有模型执行链。

### 14.5 最终完整性复核及未验证事项

**完整性复核：** 以审计开始前16文件的字节大小与SHA-256清单为基准，最终逐文件比对。未发现原16文件删除或内容变化；数据库hash不变。项目内本次唯一新增文件为 `docs/audit/CODE_AUDIT_REPORT.md`，以及容纳它的目录。聊天工作目录仅有隔离源码副本、辅助脚本/临时库/公开资料和同内容报告副本；这些不是原项目文件变更。

初始和最终 `git status` 均为“not a git repository”，所以不能区分原有Git未提交修改/已跟踪文件；没有人为初始化Git。**用可核实的文件基线替代Git diff证明内容未改，不冒充Git历史检查完成。** 不改变Agent运行状态、业务SQLite、源代码、配置或Git历史；未自动修复任何问题。

仍待验证：实际WSL/Agent Node与SQLite版本及权限；外部飞书/relay/CDP源码与调用授权；真实Agent实时状态、取消/恢复/异常退出；Git全历史/备份秘密；正式TS与Lint；长时并发/断电恢复/规模性能；公开框架Windows实际测试与安全配置。不会因这些未验证项整体中止其他已完成审查，也不将推测写为已确认漏洞。

### 14.6 原文件SHA-256基线（最终逐项相同）

| 项目内文件 | 字节 | SHA-256 |
|---|---:|---|
| data/bridge.db | 86016 | 6812204dac8ba4763b1f7e2997ae21183c523b8885402e8501a57e353a4245e9 |
| docs/[HOST]-research.md | 12703 | 64c72fd77c30816e5204762d95ccb3f822666ed6ca1b0aa6b82d7a6ade65a632 |
| package.json | 484 | 13ca292ba3358740e77ee9c2e16a2c8fb3e505e9a0cdf1646356e8abe2f03e44 |
| README.md | 4042 | 1c8072d14aaa3d0a48aa40d8987ebf590319683d1d3ae58a517872d887fc8185 |
| src/chatgpt.ts | 9807 | 91647ddf09fad5b399ab8924a284a81be8b2d31a9c66abde5abe4a672c3bee4d |
| src/cli.ts | 13426 | 937993989960b98e9fc57914340a80f4aff5827b5d20d65bea9326f14fc628dc |
| src/codex-ops.ts | 2299 | 5d1a1c31546a72fb22815e6e1c7353377224a1e2cd87ffdbbf21dce453af744c |
| src/codex.ts | 3594 | 2173f3a4cdf60fd5041f1623ca213ea724f836cb05ac44607cd4557c1d9e3c12 |
| src/db.ts | 1260 | e65359d85c9498238171a60932bc03ec84003ee2a6c73fdb98d0f840a9e56065 |
| src/e2e.ts | 5134 | 7f0e7034cc1e8cf1463a6cafd4b74356252eaf0bbc2761bb95132daab0648c99 |
| src/hermes.ts | 1369 | eec127fc7f0d5b71d082884926e12c43b7903c8343943716837717790b45952f |
| src/index.ts | 2165 | 8d27f8d00894c3539537b9a41df4963d9f4d83ee99b607c31878970dee24f6ed |
| src/pi.ts | 1603 | 243147ec2ab284bab8bee4ef76b2d16b746a02a4c07b7d31d1f87742a1dae871 |
| src/schema.sql | 4373 | 7ab1f50d91b1889fe4926d35b7de33310dfd89871ab606e7812683031c94d456 |
| src/tasks.ts | 9629 | 56318693a2363f11afc0b0f59b5442af1a2438c465409a037dbd39d9be3f98b4 |
| src/types.ts | 2579 | c294a86eae712799ea9fb2a6c52ecf7cabc911e196fb779e0e18a753896821e1 |

[A1]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md
[A2]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_base_agent.py
[A3]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py
[A4]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_cancellation_token.py
[A5]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-ext/src/autogen_ext/code_executors/docker/_docker_code_executor.py
[A6]: https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/tests/test_cancellation.py
[C1]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/src/crewai/agents/agent_adapters/base_agent_adapter.py
[C2]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/src/crewai/task.py
[C3]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/src/crewai/flow/runtime/__init__.py
[C4]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/src/crewai/flow/persistence/sqlite.py
[C5]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/src/crewai/events/event_bus.py
[C6]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/lib/crewai/tests/test_flow_persistence.py
[C7]: https://github.com/crewAIInc/crewAI/blob/6b93fa0e25a926215ca7bb52a95d4db7d9d7262d/docs/edge/en/mcp/security.mdx
[L1]: https://github.com/langchain-ai/langgraph/blob/6aa0afba682b0308fbcace31f66fb532978d4dca/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py
[L2]: https://github.com/langchain-ai/langgraph/blob/6aa0afba682b0308fbcace31f66fb532978d4dca/libs/langgraph/langgraph/pregel/_loop.py
[L3]: https://github.com/langchain-ai/langgraph/blob/6aa0afba682b0308fbcace31f66fb532978d4dca/libs/sdk-py/tests/integration/test_cancel.py
[L4]: https://github.com/langchain-ai/langgraph/blob/6aa0afba682b0308fbcace31f66fb532978d4dca/libs/langgraph/tests/test_pregel.py
[W1]: https://github.com/OpenHands/OpenHands/blob/03f356c5c81aefed7afad926c54e53f75230f5f6/README.windows.md
[W2]: https://github.com/OpenHands/OpenHands/blob/03f356c5c81aefed7afad926c54e53f75230f5f6/.github/workflows/[HOST].yml
[W3]: https://github.com/OpenHands/OpenHands/blob/03f356c5c81aefed7afad926c54e53f75230f5f6/src/api/conversation-service/agent-server-conversation-service.api.ts
[W4]: https://github.com/OpenHands/OpenHands/blob/03f356c5c81aefed7afad926c54e53f75230f5f6/src/api/runtime-service/agent-server-runtime-service.ts
[W5]: https://github.com/OpenHands/OpenHands/blob/03f356c5c81aefed7afad926c54e53f75230f5f6/__tests__/api/docker-conversation-boundaries.test.ts
[N1]: https://nodejs.org/api/typescript.html
[N2]: https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html
[N3]: https://nodejs.org/download/release/v24.19.0/docs/api/child_process.html
[N4]: https://nodejs.org/en/blog/vulnerability/july-2026-security-releases
[S1]: https://www.sqlite.org/wal.html
[S2]: https://www.sqlite.org/pragma.html#pragma_busy_timeout
[S3]: https://www.sqlite.org/lang_createtable.html
[S4]: https://www.sqlite.org/releaselog/3_53_3.html
[O1]: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
[O2]: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
[O3]: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
