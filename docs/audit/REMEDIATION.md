# 审查问题整改追踪

日期：2026-10-10（Asia/Tokyo）。基线：`75db1e443c1853f99d642ee0e0f56f6ce5fdce61`。保留 [原审查报告](CODE_AUDIT_REPORT.md) 的 24 项结论；此文件记录后续整改，不能视为独立验收通过。此前第一批由 Hermes 验收，本次新增实现仍待独立验收。

状态：FIXED_AND_TESTED=实现及隔离回归有证据；IMPLEMENTED_UNVERIFIED=已实现/文档化但外部实测未完成；DEFERRED=边界或长期事项未完成；BLOCKED=环境/授权阻塞。状态不代表系统对抗任意同 OS 主体的执行代码。

| ID | 原等级 | 原问题 | 实际修复文件 | 修复方式 | 测试证据 | 当前状态 | 限制与后续建议 |
|---|---|---|---|---|---|---|---|
| SEC-001 | P1 | 业务角色伪造、缺所有权约束 | src/caller.ts; src/tasks.ts; src/review-boundary.ts; src/migrations.ts | OS 主体与不可序列化 caller context；holder/instance；独立验收 SQL gate | caller/cli/tasks/migration/transactions 测试 | FIXED_AND_TESTED | 同一 OS 主体运行不可信代码仍不等于进程安全沙箱；真实 Hermes 宿主接入待验证 |
| SEC-002 | P1 | NTFS ACL 过宽 | src/permissions.ts; src/permissions.ps1; src/db.ts | 授权 SID/700/600；建库前保护专用数据目录；纯 .NET/SID 校验避免隐式账户名解析，固定阶段错误摘要 | test/database.test.ts 实际临时库 ACL、宽 SID 拒绝、受控子进程；用户提供 Hermes 实查仅 SYSTEM/Administrators/机主 | FIXED_AND_TESTED | 本地全部通过，CI 结果单列于 DELIVERY；未再次改业务库或项目 ACL；真实多 OS 主体部署应重新验收 |
| STATE-001 | P1 | 双领取、终态竞争 | src/tasks.ts | status/version/owner/instance/attempt 条件 UPDATE，changes=1 | barrier 双领取 10 轮恰 1 成功；finish/cancel 竞争 | FIXED_AND_TESTED | 无自动重试旧版本；重新读版本再决策 |
| DB-001 | P1 | 多步持久化分开提交 | src/db.ts; src/tasks.ts; src/prompts.ts | 短事务，事件/审计同提交；嵌套 savepoint | events/audit 故障注入全部回滚 | FIXED_AND_TESTED | 外部发送与 SQLite 无分布式原子事务；不确定投递保持 DELIVERING |
| CODE-002 | P2 | 导出覆盖原文件 | src/chatgpt.ts | 大小写扩展名、同路径拒绝；wx 创建；失败清理自身文件 | imports 的覆盖负例原 hash 不变 | FIXED_AND_TESTED | 跨外部文件和 DB 不承诺断电级原子提交 |
| CODE-001 | P2 | CLI 校验/错误码错误 | src/cli.ts; src/errors.ts | 必填/enum/重复别名校验，pass/fail 恰一项；stderr JSON、非 0；watch/demo 合约 | cli/e2e/workflow；全部 help smoke | FIXED_AND_TESTED | 桌面 argparse 保留标准 stderr/2；真实外部接口另行验收 |
| STATE-002 | P2 | 无续约恢复、重试旧所有权 | src/tasks.ts; src/cli.ts | renew/recover/requeue，显式独立恢复，清旧 attempt/owner/error | tasks/providers recovery；工作流 | FIXED_AND_TESTED | 离线检测不自动判成功；永久失联需授权者处理 |
| STATE-003 | P2 | 审批重决/不存在也审计成功 | src/tasks.ts | pending CAS，一次决策，自审批拒绝，短事务 | tasks/transactions 审批负例 | FIXED_AND_TESTED | 当前只记审批不执行真实控制；未来操作消费逻辑需绑定实际动作 |
| DB-002 | P2 | 锁冲突无等待 | src/db.ts; src/config.ts | busy_timeout 默认 5000、配置校验/预算；冲突可诊断 | concurrency 锁冲突/释放重试 | FIXED_AND_TESTED | 长锁仍拒绝，不无限重试或覆盖状态 |
| DB-003 | P2 | Schema 未约束关键值 | src/migrations.ts | 旧数据先验证；enum/null PK/FK triggers；新增来源与映射表约束 | migration/database 无效值及未来版本拒绝 | FIXED_AND_TESTED | 兼容保留旧表；不静默删旧非法数据 |
| DB-004 | P2 | 不同 Provider 会话 ID 冲突 | src/chatgpt.ts; src/codex.ts; src/migrations.ts | source 命名空间+唯一索引，UPSERT(source,external_id) 保留旧引用 | providers 同 external ID 两来源共存、legacy FK 保留 | FIXED_AND_TESTED | 有历史重复 source/external_id 时升级拒绝，需人工清点 |
| CODE-003 | P2 | 外部 JSON 仅断言 | src/codex.ts; src/chatgpt.ts; src/config.ts; tools/desktop/desktop_common.py | 运行时嵌套校验、有限长度/数量、配置未知字段拒绝 | config/providers/imports malformed 负例 | FIXED_AND_TESTED | 测试覆盖已使用字段；外部应用 Schema 演进需新增 fixtures |
| CODE-004 | P2 | WSL/Windows 路径硬编码 | src/config.ts; src/codex.ts; src/pi.ts; src/hermes.ts; tools/desktop | 相对配置路径、homedir、环境覆盖、Node >=24.19；不依赖 D 盘和特定用户 | config Unicode/空格路径；clean install；build/typecheck | FIXED_AND_TESTED | 可信 Windows OS helper 固定标准系统路径是安全边界；真实 Linux CI 另行查询 |
| CODE-005 | P2 | 陈旧观察误报运行 | src/pi.ts; src/hermes.ts; src/chatgpt.ts; src/codex.ts | unknown/freshness/observedAt；创建与导入观察时间分离；Codex 历史不当实时执行 | providers 时间字段；CLI 合约；文档边界 | FIXED_AND_TESTED | 真实桌面后台执行不可完整观察；元数据只证明快照 |
| SEC-003 | P2 | 自由文本泄密 | src/security.ts; src/tasks.ts; src/chatgpt.ts; src/cli.ts; tools/desktop/desktop_common.py | 常见字段/Token/JSON 秘密模式脱敏；标题/Prompt 拒认证材料；不回显原异常 | security/config/desktop；当前及 Git 全 refs 模式扫描 | FIXED_AND_TESTED | 模式扫描不能识别所有私密业务文本或未知凭据；不宣称绝对安全 |
| SEC-004 | P2 | 资源无上限 | src/security.ts; src/tasks.ts; src/chatgpt.ts; src/codex.ts; tools/desktop/desktop_common.py | 8MiB 文件/导出、64KiB Prompt/事件、列表分页、有限 JSON/帧数/超时 | config/providers/prompts timeout；imports；list validation | FIXED_AND_TESTED | SQLite 历史扫描与 watcher 大台账仍随数据增长；不承诺无限规模 |
| ARCH-001 | P2 | 帮助/查询开可写 DB | src/cli.ts | 参数/help/auth 失败先返回；查询只读，不运行 Schema；init/migrate 显式 | cli help 不开库、readonly；check smoke | FIXED_AND_TESTED | watch 持久化通知是写命令；不当纯只读部署 |
| TEST-001 | P2 | 默认零测试、不安全 e2e | scripts/test.mjs; scripts/clean-install.mjs; test/ | 发现实际 test 文件且 tests>0；唯一临时库、隔离 Mock | npm test；test:e2e；test:install | FIXED_AND_TESTED | 真实桌面与付费模型不在默认测试范围 |
| DB-005 | P3 | 没有版本与迁移 | src/migrations.ts; src/db.ts; src/cli.ts | 线性 0→1→2；失败回滚，未知未来版本拒绝，旧库显式升级 | database/migration upgrade/repeat/failure/data retention | FIXED_AND_TESTED | 业务库本轮未迁移；维护者先备份/在副本演练 |
| SEC-005 | P3 | 终端控制字符未转义 | src/security.ts; src/cli.ts; tools/desktop/desktop_common.py | C0/bidi 转义、JSON 输出及摘要 | security；desktop 字段脱敏 | FIXED_AND_TESTED | 授权查看消息仍可能包含私人业务内容 |
| ARCH-003 | P3 | 外部集成无可审查边界 | tools/desktop/; src/prompts.ts; README.md; README_EN.md | 完整迁入 12 文件并列出能力、权限、来源限制；禁止伪造模型/发送成功即验收 | desktop mock/help、安全静态检查；workflow Mock | IMPLEMENTED_UNVERIFIED | 真实 GPT-6/High、后台安全生产自动中转和 MSIX 重启未验证；生产适配器尚缺 |
| SEC-006 | P3 | Git 忽略/防护缺失 | .gitignore; scripts/check.mjs; .github/workflows/ci.yml | DB/log/env/profile/cache 忽略；当前+全 refs 扫描；CI 最小权限 | check-ignore 正/负例，历史所有 blob 模式检查 | FIXED_AND_TESTED | CI 必须实际运行查询；未知秘密无法由基础模式穷尽 |
| ARCH-002 | P4 | 观察/执行接口渐进统一 | src/prompts.ts; src/topology.ts; src/config.ts | 窄适配器+可信上下文+会话 registry；能力与请求/实际模型分离 | prompts/topology/config | DEFERRED | 未全量插件化观察 Provider，规模小先维持清晰接口，不重复造框架 |
| DB-006 | P4 | 备份/保留/索引运维 | docs/DEPLOYMENT.md; docs/DEVELOPMENT.md | 记录在线备份/副本演练/不自动清业务数据；连接由调用者关闭 | 隔离迁移保留数据测试 | DEFERRED | 生产 RPO/RTO、保留周期和恢复演练需用户业务决策；不擅自改真实库 |

## 新增要求及边界

- Watcher：60000ms 默认、本进程事件即时检查、跨进程轮询兜底、SQLite completion 记录去重、重启恢复、检测不重叠，超时/停止中断。模拟时钟证明正常快检测在下次 60000ms tick 观察；事件循环延迟、DB 锁和检测耗时不能被 setInterval 消除，不声称严格 SLA。外部通知与本地去重记录不构成 exactly-once 分布式发送。
- Prompt：可信宿主安装适配器，能力检查、请求/实际模型和思考强度分开；来源与哈希校验；不确定投递保持 DELIVERING、需独立确认再恢复，不自动重复发送。实际桌面模型不能验证时拒绝自动投递。普通环境变量不能把生产 DB 变成 Demo。
- 对话拓扑：一个项目一个 workspace/一个 GPT 对话/N 个 Codex 对话，生产发送前和回执后双向校验；新项目成套登记；角色字符串不可授权。真实映射 ID 由用户已授权应用的可信元数据提供，不能从文本自我声明信任。
- 应用恢复：已退出/未知区分，报备、事件授权、指定 CDP 参数重启、Windows Python 校验、恢复映射后继续。Mock 验证顺序；真实安装启动能力尚未验证；本轮未启动/重启真实 Agent。
- 桌面安全：原写工具可能改变编辑焦点，默认阻塞；保留算法但受可信宿主单次授权和来源证明保护。旧 raw prompt continue/relay 不再直通执行。没有未经授权的 OS 物理键鼠/窗口激活路径。
- 桌面内容与映射：发送后编辑器内容逐字匹配（含空白）；缺少登记会话编辑器时不自动新建 GPT 对话。19 项 Mock 回归包含空白篡改和无编辑器拒绝；不据此宣称真实界面焦点已验证。
- GitHub：非交互进程包装层不提取凭据；已有 GitHub 集成缺可见性修改接口、本机无已授权 gh。旧建仓脚本需要 credential fill 提取 Token，违反本轮凭据铁律，因此未调用。私有推送和公开状态必须分别报告。
- 迁移清理：12/12 原文件已迁入，原创 MIT 权利已获用户明确确认。新路径独立执行 help、16 项 Mock/发送算法/异常关闭测试；原始 12 文件的外部持久备份与基线 hash 逐一一致。远端 104 文件与本地 Git 树逐项一致，12/12 原备份和迁移 hash 核验后已清理旧工具目录，删除后 16 项 Mock 回归再次通过；真实写链路单列未验证，不删除无关目录。

## 后续优先顺序

1. Hermes 对 provenance、映射、独立验收、默认拒绝前台输入做对抗验收，并核查本次真实测试数量与远端提交。
2. 本轮复查 GitHub 集成已显示 public，匿名网页可读；可见性已由本轮之外的操作改变。本轮不再重复改设置，完成当前代码安全门禁后正常推送，再独立确认远端内容。
3. 实现可信桌面模型/思考强度及会话证明适配器，真实用户授权后验证发送、CDP 故障恢复和焦点影响；当前迁移清理只依据已验证源码副本、Mock 回归和可恢复备份，不冒称真实应用通过。
4. 制定备份/保留/RPO/RTO，副本恢复演练后由维护者显式升级真实业务库。

生成工程 Prompt 的 GPT 对话必须与 Codex workspace 的项目名称完全一致：例如 workspace 项目名为 `Agent Control Bridge`，GPT 对话也必须命名为 `Agent Control Bridge`。新建项目时一并设置并核对名称；不能只核对会话 ID。映射由受信任 Hermes 登记 `--gpt-name`，生产适配器须独立观察实际名称，在生成前及来源回执中复核；无法验证时拒绝自动执行。登记文字不是真实界面已经重命名的证明。

公开状态复核：2026-10-10 通过 GitHub 集成和匿名网页独立确认目标仓库为 public。此前观察到 private 与当前 public 不矛盾；本轮未获取凭据或调用可见性修改接口。

通用规范补齐：SemVer/CHANGELOG/验收后版本 tag、隔离探针卫生、结论/证据/遗留验收模板、多项目优先级与会话隔离、可配置阻塞上报。failureReporting.blockedAfterMs 默认 600000ms；Watcher 以本次 BLOCKED 状态事件为起点，续租不会推迟报备，重复检查和重启不重复记录。实际用户消息仍由 Hermes 适配器发送。README 中英双版仅保留使用者内容，过程事项移至 CONTRIBUTING、DEVELOPMENT 与 audit。

CLI 别名补充证据：目录别名启动旧入口 exit=0/helpPresent=false，新 import.meta.main 入口 exit=0/helpPresent=true；test/cli.test.ts 新增实际子进程契约，不降低旧断言。scripts/test.mjs 流式输出且零测试拒绝，clean-install 在规范临时路径运行并报告 pass/fail/skipped，超时仅清理自己启动的测试子树。初次 Windows CI 安装探针失败记录保留，须核验修订后 CI。SQLite3 及其 sidecar 同时纳入忽略/检查。

受控迁移补充：init 只初始化空库，旧库明确要求 migrate；陌生及缺表当前版本数据库先拒绝，回归证明原始 bytes/version/业务记录不变。Windows 安装 CI 的 ACL 超时不算通过，恢复必要非秘密 OS 元数据并固定受信任系统模块路径，新增真实临时库权限子进程测试；111 项本地回归通过，待远端复核。

CI 证据以 [DELIVERY](DELIVERY.md) 和 [VALIDATION](VALIDATION.json) 的独立查询为准，保留前三次实际失败，跳过不算通过。第三次 Windows 是 110 pass/1 fail，新增受控 ACL 探针超时；没有删除断言或停用 ACL。权限助手现去掉模块自动加载与账户名称解析，失败附固定阶段，实际远端复核独立记录。本地 111 项及干净安装通过；19 项桌面 Mock 与生产外部链路严格区分。
