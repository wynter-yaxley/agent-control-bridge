# Agent Control Bridge

[English](README_EN.md)

Agent Control Bridge 是连接 Hermes、ChatGPT 与 Codex 的本地任务控制和状态管理桥。它为飞书上的 Hermes 提供任务台账、进度观察与独立验收接口，让 ChatGPT 生成工程 Prompt，由桥验证并中转给 Codex 执行开发。

项目保留各 Agent 的职责：Hermes 协调并向用户汇报；ChatGPT 负责沟通和生成 Prompt；Codex 执行开发；Bridge 管理来源、权限和状态；SQLite 保存可追踪记录。它适合已有桌面 Agent 的协作场景，不提供模型推理服务。

## 核心能力

- **任务生命周期**：原子领取、版本冲突检测、租约、进度、交付、取消与显式恢复。
- **独立验收**：执行者只能提交待验收交付；授权的独立 reviewer 是 `SUCCEEDED` 的唯一入口。
- **Prompt 中转接口**：校验可信来源、会话、模型能力和内容哈希，记录投递状态；不确定投递保留待核实状态。
- **SQLite 台账**：任务、事件、审批、来源、验收与持久通知；支持受控 Schema 升级。
- **Watcher**：事件触发检查与周期轮询、通知去重、重启恢复、阻塞超时报备记录。
- **桌面协作工具**：受限 CDP 读取与授权发送接口，默认关闭写入；不接管物理鼠标键盘。
- **无凭据 Demo**：隔离 Mock 完整演示 ChatGPT → Bridge → Codex → Watcher → 独立验收。
- **后台原生读取诊断**：Windows 管道读取已存在的 Codex/GPT 对话摘要，核对目标 ID/标题，无浏览器、物理输入或前台切换；读取成功仍不授权生产生成。见 [原生接口说明](docs/NATIVE_DESKTOP.md)。

**当前边界**：真实桌面生成适配器尚不能独立证明 GPT-6/High，生产自动 Prompt 投递默认拒绝。飞书消息发送须接入 Hermes 消息适配器。Codex 本地历史是快照，不能完整观察所有后台执行；取消台账不证明真实 Agent 已停止。详见 [部署说明](docs/DEPLOYMENT.md)。

## 架构

![Agent Control Bridge 架构与数据流](assets/architecture.svg)

```text
用户需求 → Hermes → ChatGPT 生成 Prompt → Bridge 验证/中转 → Codex 执行
                    Bridge ← 状态与交付 ← Codex
                       ↕ SQLite       ↓ Watcher
用户 ← Hermes 汇报 ← 独立验收入口 → Bridge 最终状态
```

一个项目登记 **1 个 Codex workspace + 该 workspace 下 N 个 Codex 对话 + 1 个 GPT 对话**。GPT 对话名必须与 workspace 项目名一致；开发、测试和交付在登记的 Codex 对话中进行。新项目成套隔离，生产适配器必须独立核对实际会话。

## 快速开始

0.2.0 开发版本增加了 stdio MCP 入口、持久后台队列、独立执行者、普通 GPT 宿主接口、项目建套流程和待发送通知回执。普通 GPT 的真实宿主绑定尚未完成；缺少能力时会记录 `BLOCKED`，不会改用浏览器或第二 profile。见 [后台 MCP 接入与当前边界](docs/BACKGROUND_MCP.md)。

### 环境

核心 CLI 需要 **Node.js >=24.19.0、npm 和 Git**，使用 Node 内置 SQLite，无需 SQLite 原生扩展。MCP 入口使用官方 MCP TypeScript SDK 和 Zod。核心面向 Windows/Linux；既有桌面集成面向 Windows，需要 Python >=3.10、可选的 `websocket-client`、已安装并登录的外部 Agent 应用及受控 CDP 接口。Demo 不需要这些桌面条件。

```sh
git clone https://github.com/wynter-yaxley/agent-control-bridge.git
cd agent-control-bridge
npm install
npm run build
npm test
node dist/cli.js help
node dist/cli.js demo
```

`demo` 创建并清理唯一临时库，展示生成测试 Prompt、桥接投递、Codex 领取、进度、Watcher、提交交付、拒绝执行者自验、独立 Mock 验收与最终查询。`mock-chatgpt` 来源和 `mock:gpt-6` 模型明确标记为测试数据；不会调用付费模型或读取业务库。普通配置或环境变量不能打开生产 Mock 权限。

### 初始化本地台账

PowerShell：

```powershell
Copy-Item config.example.json .bridge.config.json
node dist/cli.js init --config .bridge.config.json
node dist/cli.js config-show --config .bridge.config.json
node dist/cli.js schema-version
```

其他终端可用 `cp config.example.json .bridge.config.json`。默认关闭外部 Agent 与桌面操作；数据目录应专用并受限。完整真实环境配置见 [部署说明](docs/DEPLOYMENT.md)。

## 配置

配置优先级：**CLI 显式参数 > 对应环境变量 > 本地配置文件 > 内置默认值**。`--config` 或 `ACB_CONFIG` 选择配置文件；`--db` 覆盖数据库路径。配置内相对数据路径以配置文件目录为基准，环境变量和 CLI 的数据库路径以工作目录为基准。未知字段、非法类型和不安全端点会被拒绝。

| 配置 | 默认值与用途 | 环境覆盖 |
|---|---|---|
| `database.path` | `./data/bridge.db`，专用台账目录 | `ACB_DB_PATH` |
| `database.busyTimeoutMs` | `5000`，有限 SQLite 锁等待 | — |
| `watcher.intervalMs` | `60000`，跨进程轮询兜底 | `ACB_WATCH_INTERVAL_MS` |
| `watcher.timeoutMs` | `10000`，合作式检测预算 | — |
| `failureReporting.blockedAfterMs` | `600000`，持续阻塞报备阈值 | `ACB_BLOCKED_REPORT_MS` |
| `agents.chatgpt.model` | `gpt-6`，请求模型，不代表已验证实际模型 | `ACB_CHATGPT_MODEL` |
| `agents.chatgpt.reasoningEffort` | `high`，请求思考强度 | `ACB_CHATGPT_REASONING` |
| `desktop.cdpUrl` | 本机回环端点，具体样例见配置文件 | `ACB_CDP_URL` |
| `desktop.enabled` / `allowForegroundAutomation` | `false`；开启配置仍不授予单次操作权限 | — |
| `desktop.allowPhysicalInput` | `false`；物理输入不支持 | — |

Watcher 本进程事件可触发即时检查，跨进程依赖周期兜底。检测及时返回且事件循环正常时，目标为一个周期加检测耗时与调度延迟；**不承诺无条件最坏 60 秒 SLA**。阻塞通知也是本地台账事件，Hermes 需要消费并真正向用户上报。完整字段见 [config.example.json](config.example.json)。

## 使用方法

### 手动台账演练

以下只演示记录操作，不自动执行代码。默认 CLI 调用者是无 reviewer 权限的 `pi`，因此用 `pi` 演练；生产 Codex 领取另外要求已经验证并投递的 ChatGPT Prompt。

```sh
node dist/cli.js task-create -t "本地台账演练" -k demo -e pi
node dist/cli.js task-list --status QUEUED
node dist/cli.js task-claim TASK_ID --version 0 -e pi
node dist/cli.js task-progress TASK_ID --version 1 --note "人工模拟开发完成"
node dist/cli.js task-renew TASK_ID --version 2 --lease 600
node dist/cli.js task-finish TASK_ID --version 3 --note "交付待独立验收"
node dist/cli.js task-show TASK_ID
node dist/cli.js watch
```

将 `TASK_ID` 替换为返回的 UUID，每次操作采用查询得到的最新版本。`watch` 是独立观察进程，可在其终端停止，不停止外部 Agent。只有部署好的独立 reviewer OS 身份可执行：

```sh
node dist/cli.js task-verify TASK_ID --version 4 --pass --reason "独立检查交付"
node dist/cli.js task-show TASK_ID
node dist/cli.js status
```

验收结果写入 SQLite，最终状态可查询；真实用户消息由 Hermes 消息适配器发送。无需部署身份的完整演练使用 `demo`。

### 状态机与权限

```text
QUEUED → RUNNING → WAITING_APPROVAL → 独立 verify(pass) → SUCCEEDED
                  WAITING_APPROVAL → 独立 verify(fail) → FAILED
RUNNING ⇄ BLOCKED
过期 RUNNING/BLOCKED → 独立 recover → FAILED → reviewer requeue → QUEUED
UNKNOWN → reviewer requeue → QUEUED
合法活动状态 → owner cancel → CANCELLED
```

`--by`、执行者名称、role 字符串与环境变量不能授予权限。调用身份来自 OS 主体和受保护策略；状态更新校验版本、holder、instance 与 attempt。执行者不能验收自己，普通 SQL 最终成功写入也有验收门禁。直接修改宿主代码、策略或数据库的所有者属于可信边界；同一 OS 账户的任意恶意代码不受这套台账权限隔离。Linux 当前支持单用户核心 CLI 与 Demo；跨 uid 共享写入验收尚未提供。部署配置见 [身份和安全模型](docs/DEPLOYMENT.md)。

项目不获取、复制、展示、保存或修改认证凭据，不导出 Cookie 或会话 Token。运行库、个人配置、日志、Profile 与缓存默认不入库；消息和日志仍应避免含私密业务内容。

### 真实桌面模式与扩展

先安装、登录外部应用并配置本机 CDP，再由可信宿主安装生成/传输适配器，登记 workspace/GPT/Codex 会话。ChatGPT 的实际模型、思考强度或来源无法验证时，产物保持 `REVIEW_REQUIRED`；没有可靠证明不能自动进入 Codex。手动文件导入不会授权执行。

桌面发送可能改变编辑焦点，需要可信宿主单次授权，命令行参数不能授权。默认只提供受限读取与诊断；不会重启正在使用的应用。工具参数、兼容入口和故障说明见 [桌面工具](tools/desktop/README.md)；恢复步骤见 [部署说明](docs/DEPLOYMENT.md)。

新增 Agent 可实现窄能力接口并注册可信适配器；新增执行者类型还需要兼容扩展状态类型和 Schema。参见 [开发说明](docs/DEVELOPMENT.md)。

### 故障排查

成功 JSON 写 stdout，错误 JSON 写 stderr。退出码：`1` 文件/I/O；`2` 参数/配置；`3` 权限/来源；`4` 状态/版本/租约/验收；`5` 数据库/Schema；`6` Agent/能力/依赖；`7` 超时；`8` 执行失败。

缺库先 `init`，冲突先重新查询版本。旧库需先备份并在副本用 `migrate --db COPY.sqlite` 验证；普通写命令拒绝隐式升级。AUTH/PROVENANCE 失败应检查受保护身份或适配器，不用角色文字绕过。CDP 不可达不能单独证明闪退，也不能据此自动重启。

## 许可与文档

采用 [MIT License](LICENSE)，依赖许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

- [部署与恢复](docs/DEPLOYMENT.md)
- [项目协作规范](docs/PROJECT_RULES.md)
- [贡献指南](CONTRIBUTING.md)与[开发说明](docs/DEVELOPMENT.md)
- [历史审查](docs/audit/CODE_AUDIT_REPORT.md)、[整改追踪](docs/audit/REMEDIATION.md)与[交付记录](docs/audit/DELIVERY.md)
