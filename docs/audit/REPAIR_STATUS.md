# Agent Control Bridge 修复交付记录：待验收

日期：2026-10-10（Asia/Tokyo）。项目：`D:\Agent control bridge`。依据：[综合代码审查报告第 11 节](CODE_AUDIT_REPORT.md)。

**状态：修复实现与本地回归已完成，待 Hermes 独立验收。本文不宣布任务成功，不代表 Hermes 已验收，不将真实任务置为 SUCCEEDED。** 原审查报告保留原文及历史严重度；这里只描述本轮修复，不关闭其余发现。

## 1. 修复对照表

| 编号 | 本轮改动与准确定位 | 对抗回归与结果 | 交付状态 |
|---|---|---|---|
| SEC-002 / P1 | `src/permissions.ps1:27` 关闭继承并移除宽泛 ACE；`src/permissions.ts:9` 使用固定 OS 可执行文件及数据编码，失败拒绝继续；`src/db.ts:26` 在 SQLite 打开前收窄目录、DB 和既有 WAL/SHM。实际项目根、原 DB 及现有子项 ACL 已收窄 | 实测根目录和原 DB 只有当前所有者、SYSTEM、Administrators；扫描项目全部路径没有 Everyone/AU/Users ACE。临时 DB/WAL/SHM ACL 与宽泛 SID 拒绝测试通过 | 已实现；本机 ACL 已应用；待验收 |
| SEC-001 / P1 | `src/caller.ts:19,33,44` WeakMap context、OS 身份和固定受保护策略；`src/tasks.ts:34,105,116,129,139` holder/instance、reviewer capability、reviewer principal != attempt executor；`src/cli.ts:103` 禁止 `--by/-e` 覆盖 caller。未配置 reviewer 默认拒绝 | 字符串、JSON、缺失/其他 authority context、自验、错误 holder/instance 均拒绝；实际 CLI `pi --by user` 非 0、stderr，任务保持 WAITING_APPROVAL；PATH 替身无法伪造 OS 身份；独立合成 reviewer 路径通过 | 已实现；真实独立 OS reviewer 部署待验收 |
| STATE-001 / P1 | `src/tasks.ts:51,92` 短事务内 `UPDATE ... WHERE id/status/version/claimed_by/claimed_instance/attempt`，`changes===1`；claim 状态、owner、instance、attempt、租约一次写入；所有状态变更及 renew 使用 CAS，调用者必须给出期望 version | 两个独立连接 barrier 双领取 10 轮，每轮恰 1 成功、1 claimed event；finish/cancel 同版本竞争恰 1 提交；旧版本、旧 attempt 回调及重复领取拒绝 | 已实现；待验收 |
| DB-001 / P1 | `src/db.ts:11` BEGIN IMMEDIATE/COMMIT/ROLLBACK，嵌套 SAVEPOINT；`src/tasks.ts:60,67,175,187,202,206` create/claim/finish/verify/cancel/renew/审批/组合创建/告警中的台账、event、audit 同事务；审批 UPDATE 限定 pending 且影响行数必须为 1 | 13 类操作分别注入 events 和 audit_log 写入故障，26 个测试逐表快照完全一致、事务释放；Schema 失败回滚、嵌套事务回滚、锁冲突可重试均通过 | 已实现；待验收 |
| CODE-002 / P2 | `src/chatgpt.ts:158` 大小写扩展名、同路径校验、`openSync(...,'wx')` 禁止覆盖；先完整解析再短事务导入，失败回滚并只清理本次新文件；CLI 支持指定新输出路径 | .json/.JSON/.JsOn、同路径、大小写别名、已有输出、hard-link 负例均保留输入/输出 SHA-256；真实 CLI 覆盖负例非 0；SQL 写故障没有残留 sessions 或新输出 | 已实现；待验收 |
| CODE-001 / P2 | `src/cli.ts:75,94,179` 严格参数解析、enum/lease/version 校验、恰一项 pass/fail、stderr/非 0、连接 finally 关闭；help 与 -k 路由一致，查询不迁移数据库 | CLI 参数负例与缺任务、无验收权限、双 pass/fail、enum 错误均拒绝；stdout 无误导成功输出，合法可信宿主验收路径通过 | 已实现；待验收 |
| TEST-001 / P2 | `package.json:10` 对接 `scripts/test.mjs`；发现 `test/*.test.ts`，空发现或总测试数 0 非 0；原 `src/e2e.ts` 改为独立临时环境的真实 node:test；`src/index.ts` 默认只显示 help | 实际发现 8 个测试文件，执行 66 个测试，66 pass / 0 fail / 0 skip；空测试发现负例通过；e2e 两项通过 | 已实现；npm 字面命令环境项待验证 |

定位以当前交付文件为准。核心 API 与旧版本不兼容：原 actor/executor 字符串参数改为 CallerContext，状态写入必须传当前 version。未授权调用不会兼容放行。

## 2. 测试实况

环境：Windows，Node **v24.19.0**，内置 SQLite，未添加第三方依赖。测试数据均合成，fixture 名称不是实际身份或秘密。

| 测试文件 | 实际 tests | 结果 | 覆盖 |
|---|---:|---|---|
| test/caller.test.ts | 3 | 全通过 | OS 策略默认拒绝验收、策略校验、PATH 伪装 |
| test/cli.test.ts | 7 | 全通过 | 参数、错误退出、冒充验收、可信宿主调用 |
| test/concurrency.test.ts | 3 | 全通过 | barrier 10 轮双领取、finish/cancel 竞争、锁冲突 |
| test/database.test.ts | 6 | 全通过 | v0→v1、Schema 回滚、新版本拒绝、嵌套回滚、NTFS/WAL/SHM 权限 |
| test/e2e.test.ts | 2 | 全通过 | 真实 CLI 子进程完整链路与文件哈希负例 |
| test/import.test.ts | 7 | 全通过 | 大小写、覆盖、别名、格式异常、导入回滚、不可信文本 |
| test/runner.test.ts | 1 | 全通过 | 空套件不能报告通过 |
| test/tasks.test.ts | 37 | 全通过 | 独立验收、fencing、所有非法转换、审批 CAS、26 种 event/audit 故障注入 |
| **总计** | **66** | **66 pass / 0 fail / 0 skipped** | **真实执行数 > 0** |

实际执行：

```powershell
# 最终全套（退出 0，66/66，35.30 秒）
node scripts/test.mjs
# 单独 e2e（退出 0，2/2，29.36 秒）
node --experimental-strip-types src/e2e.ts
# 最终将 UNKNOWN 的出边收紧为 reviewer 重新排队后，状态专项再执行（退出 0，37/37）
node --experimental-strip-types --test test/tasks.test.ts
# 22 个 src/test TypeScript 文件逐一 node --check，全部通过
```

原始日志：[全套测试 TAP](TEST_RESULTS.tap)、[最终状态专项](STATE_TEST_RESULTS.txt)、[单独 e2e](E2E_TEST_RESULTS.txt)。全套包含 e2e；测试计数不可把各次重复运行相加。

**npm 限制：** 本机 PATH、常见 Node 安装目录和现有运行时中未找到 npm。没有安装 npm。因此不能声称实际运行了 `npm test` 或 `npm run test:e2e`；已直接执行 package.json 对应的相同 Node 脚本，且全部通过。Hermes 在具有 npm 的环境中仍需执行字面命令验收。现有 TypeScript 编译器、tsconfig 和 Lint 配置缺失，没有运行 tsc/Lint；`node --check` 和运行时剥离不等价于静态类型检查。

**测试运行副作用记录：** 尝试现有 pnpm 11.25.0 时，其默认依赖核对行为触发一次空依赖安装流程，产生 `pnpm-lock.yaml` 和 node_modules 中两份元数据。这是本轮可避免的副作用；确认 lockfile 的 importer 为 `{}`、无依赖包后，已将仅本次产生的目录和锁文件移到项目外的审计临时目录留证。最终项目没有 node_modules 或 lockfile，也没有新增第三方依赖。后续使用直接 Node 调用，未升级包管理器、未自动修复依赖。

## 3. 权限、数据和 Git 核查

- 根目录和原始数据库的 ACL 已实际修改，Authenticated Users / Users 的权限已移除；继承被禁用，当前目录所有者、SYSTEM、Administrators 保留 FullControl。未添加真实 Hermes 账户，不提升权限，不修改系统执行策略。
- `db.ts` 新建文件会显式设置权限；已有 WAL/SHM 也会在连接前收窄。SQLite schema v1 增加 version、attempt、owner instance 和 creator/attempt principal，事务迁移已在真实旧 Schema 的临时 fixture 验证。
- **原始 `data/bridge.db` 未打开为写连接，未执行迁移或业务操作，内容 SHA-256 与修复前相同：** `6812204dac8ba4763b1f7e2997ae21183c523b8885402e8501a57e353a4245e9`。只改变了其 ACL。
- 原审查报告 SHA-256 保持 `b2e52a1a82d3d01e96ce9e8689892e73ca7a7aa9ce05adf249e9b488d96525bf`，未篡改既有发现。
- 基线不存在 `.git`；最终仍不存在。只读 Git 状态命令报告 not a git repository。**没有 git init / commit / push，没有修改 Git 历史或发出 GitHub 同步。** 变更通过修复前后文件哈希清单区分。
- 未启动、停止、重启或控制真实 Agent/网关/守护进程；测试子进程仅 Node 测试、SQLite fixture 和本机身份/ACL辅助查询。没有付费模型 API、真实凭据调用或本地内容网络上传。
- 本轮新增源代码、配置示例和文档扫描未发现能够确认的真实凭据。示例只含 SID 占位符，没有实际 Token。手动导入内容的全量脱敏/加密仍未解决，不能把“桥不主动读取凭据”理解为任意输入都没有秘密。

## 4. 完整文件变更清单

内容修改（10 个既有文件）：

- `README.md`
- `package.json`
- `src/chatgpt.ts`
- `src/cli.ts`
- `src/db.ts`
- `src/e2e.ts`
- `src/index.ts`
- `src/schema.sql`
- `src/tasks.ts`
- `src/types.ts`

新增（22 个文件）：

- `.gitignore`
- `README_EN.md`
- `config/caller-policy.example.json`
- `docs/audit/E2E_TEST_RESULTS.txt`
- `docs/audit/REPAIR_STATUS.md`
- `docs/audit/STATE_TEST_RESULTS.txt`
- `docs/audit/TEST_RESULTS.tap`
- `scripts/test.mjs`
- `src/caller.ts`
- `src/permissions.ps1`
- `src/permissions.ts`
- `test/caller.test.ts`
- `test/claim-worker.mjs`
- `test/cli.test.ts`
- `test/concurrency.test.ts`
- `test/database.test.ts`
- `test/e2e.test.ts`
- `test/fixtures/schema-v0.sql`
- `test/helpers.ts`
- `test/import.test.ts`
- `test/runner.test.ts`
- `test/tasks.test.ts`

内容保持不变：

- `data/bridge.db`
- `docs/audit/CODE_AUDIT_REPORT.md`
- `docs/desktop-automation-research.md`
- `src/codex-ops.ts`
- `src/codex.ts`
- `src/hermes.ts`
- `src/pi.ts`


所有既有项目文件的 ACL 均纳入 SEC-002 修复；上述列表描述内容变更，不能将 ACL 元数据变化误称为“没有修改数据库文件的任何属性”。项目外的 baseline/ACL 备份和包管理元数据留证不属于交付源代码。

## 5. README 与安全边界

README.md 中文 / README_EN.md 英文包含一致的角色、目标、架构、状态机、CLI、安全边界和限制。Hermes 联络 Codex 与 ChatGPT、双向 prompt 中转和飞书实时汇报均明确写为目标，不宣称已有持续自动协作。

默认本机 CLI 无 reviewer 权限。真实独立验收需要不同 OS principal 的受保护策略及 ACL，或由可信宿主负责认证后签发进程内 context。`CallerAuthority.issue` 只供可信宿主使用；外部业务/Agent 参数不得到达它。拥有同一 OS 账户下任意代码执行、项目所有者或管理员权限的进程可以直接修改 SQLite/策略，CallerContext 不构成 OS 沙箱；此部署边界没有被掩盖。

原数据库升级没有在业务环境执行，下一次写入口会触发迁移。旧活动任务缺可信 holder/attempt，默认拒绝 finish/cancel/verify，不能凭旧 `claimed_by='pi'` 自动恢复身份。需要独立人员审查安排恢复；不能以“跑通新 fixture”宣称历史任务已可安全续跑。

不在本轮范围或仍未关闭的事项包括：观察模块固定路径与状态新鲜度、自动接管/执行终止、广泛内容脱敏/加密、会话 ID 完整迁移、完整 Schema CHECK/约束、备份/恢复运维、发布许可证与静态类型工程配置。部分审批一致性/lease renew/只读查询/导入事务顺带改善，未把相关旧发现全部自动关闭。

## 6. Hermes 独立验收清单

- [ ] 核对 SEC-002：根目录、data 目录、原 DB 和运行时 WAL/SHM 没有 AU/Users/Everyone 写权限，只允许明确授权主体。
- [ ] 在安装了 npm 的安全隔离环境执行 `npm test` 与 `npm run test:e2e`，确认真实 tests > 0、无失败；不对业务 DB 跑测试。
- [ ] 检查普通 pi CLI 传 `--by user` 或 `--by hermes` 不能验收，缺 context、其他 authority context、JSON 假 context 均拒绝。
- [ ] 为不同 OS principal 部署真实 reviewer 策略与 ACL；确认执行者 principal 自验始终拒绝，合法独立 reviewer 可验收合成任务。禁止对真实任务用“测试”代替人工验收。
- [ ] 检查 finish/cancel/renew 的 holder/instance/version、过期 lease 和上一次 attempt 回调负例。
- [ ] 重跑 barrier 两连接双领取，每轮恰一成功，状态与 owner、lease、event、audit 同步。
- [ ] 对 create/claim/finish/verify/cancel/approval 注入 event/audit 写故障，比较各表快照，确认全部回滚。
- [ ] 对大小写 JSON、同路径/别名、已有输出和硬链接运行导出负例，前后输入与输出 SHA-256 一致。
- [ ] 审查 v0→v1 迁移与旧活动任务恢复方案，备份后再授权业务环境迁移；本轮原 DB 未迁移。
- [ ] 核对 README 两种语言及“目标/现状”边界，确认没有声称已有自动飞书中转或后台 Codex 执行观察。
- [ ] 确认原业务 DB 内容哈希和原审查报告哈希未变，核对文件变更与 ACL 备份；检查未引入凭据或包管理副产物。
- [ ] Hermes 书面下达验收结论；验收通过后再单独下达 GitHub 同步指令。在此之前不得初始化、提交或推送 Git。

交付停在 **待验收**。测试中的 SUCCEEDED 仅属于临时合成任务，不是本次真实工作任务的状态。
