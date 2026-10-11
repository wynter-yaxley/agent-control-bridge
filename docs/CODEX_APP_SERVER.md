# Codex 官方后台接口（0.2.0 开发版）

该接口使用官方 `codex app-server --listen stdio://`，补充 Codex 一侧的独立读取、后台投递、事件回执与中断处理。普通 GPT 会话创建/触发、原生桌面 workspace 创建仍缺少宿主实现，生产整链路待接入和独立验收。

## 可以直接运行的读取接口

构建后运行：

```text
node <绝对安装目录>/dist/codex-interface.js --config <统一配置绝对路径> --conversation <已知 Codex ID> --workspace <预期工作目录> --project <预期原生项目 ID>
```

安装后的入口是 `agent-control-bridge-codex-check`；源码目录可用 `npm run codex:target-check -- ...`。`agents.codex.executable` 从统一配置读取，诊断也允许操作者显式指定 `--executable`。检测预算使用 `watcher.timeoutMs`。

该入口只调用 initialize / initialized / thread/read（includeTurns=false），输出比较结果，省略历史消息、预览、账户详情、原始诊断和会话凭据。它不 resume、不登录、不运行模型，也不打开业务库。预期值仅用于诊断，不能授权执行。

MCP 的 `acb_codex_target_check` 接受 projectId 和 conversationId，只允许本连接控制者已登记的项目与 Codex 会话；可执行路径取配置，工具参数不能指定程序。返回的 ok 表示读取完成，执行授权始终为 false。

App Server 的 canonical projectId 是当前协议实验字段；目标读取与执行适配器初始化显式开启 experimentalApi。即便如此，本机已有桌面会话读取仍为空；此时输出 UNAVAILABLE，不能推断没有 workspace，也不能把预期项目 ID 复制回去当作读取证据。非空但不匹配输出 MISMATCH；实际目录不匹配也独立报告。元数据读取的自有 CLI 进程关闭插件、远程插件和应用功能，不更改真实配置；执行适配器保留已授权功能。

## 后台执行适配器

可信宿主可导入 `agent-control-bridge/codex-app-server` 中的 createCodexAppServerExecutor。根入口 agent-control-bridge 导出桥、OS 策略解析、注册表、现有 Hermes 消息适配器和通知组件。导入本身不会授权角色或安装宿主。

执行适配器必须安装以下真实来源：

- inspect：独立读取原生桌面项目/会话归属，返回 codex-app-state 证据。App Server 再核对 thread/cwd，非空 canonical projectId 也须一致；为空时仍要求独立宿主归属证据。
- assertExclusive：宿主确认其他桌面/CLI 进程没有占用目标会话，执行前再次核验。新服务的 notLoaded 状态不能证明另一进程空闲。
- model、reasoningEffort、timeoutMs、interruptTimeoutMs、selfMcpServerName：从可信宿主的统一配置读取，不由业务消息传入。

selfMcpServerName 必须是本桥在 Codex 中注册的真实 MCP 名称。子进程禁用该名称，避免执行 Agent 再加载同一控制桥而递归调度；名称缺失或非法时拒绝安装。其余 MCP 能力仍受 Codex 的配置和授权规则约束。

生产桥先检查可信 GPT Prompt、领取 attempt/holder 并持久化唯一 dispatch，再调用适配器。它不会把原始飞书需求作为工程 Prompt 执行，也不从 MCP 参数加载 JS 适配器。

## 回执与权限行为

Prompt 通过 stdin 的 JSON-RPC text input 发送。固定目标 ID，先读取、再 resume，再检查响应中的目录、选定模型/强度、审批策略和沙箱。当前适配器限定 workspace-write、项目内 writableRoots、networkAccess=false、untrusted 审批；配置不符在 turn/start 前拒绝。网络操作或额外权限仍需可信宿主支持，当前不会自动批准。

选定参数是配置回读，不能充当普通 GPT 实际推理参数证明。收到当前轮次的 model/rerouted 且目标模型改变时，中断并拒绝回执。

只接受匹配 threadId 与真实 turnId 的 completed 且无 error 回执。失败、interrupted、跨会话/跨轮次通知、断连、响应身份异常、超出输出预算或事件持久化失败都不能证明完成。事件仅记录类型和身份，不保存正文/私有错误。回执早于 turn/start 响应时，仅暂存有限、无正文的事件摘要，取得真实 ID 后核对。

超时、AbortSignal、权限/认证请求会尝试对已知真实 turnId 发一次 turn/interrupt。启动回执丢失时不猜 ID，中断未确认时不推断已停止，也不自动重发 Prompt。当前桥保持 UNCERTAIN，仍需宿主对账；此能力不是业务层取消/恢复 MCP 工具。

## 验证边界

协议回执、串会话、异常与权限路径通过隔离 Mock 测试；Hermes/MCP → 模拟 GPT 来源 → 模拟 App Server → 独立模拟验收 → 模拟通知回执有成功和失败场景。本机真实验证包括读取当前 Codex 会话及在独立临时 Codex home 创建无消息测试会话，未调用模型、未修改已有真实会话配置或业务库。普通 GPT、飞书真实入站、新建原生项目及用户同时编辑时的完整流程尚未验证。

## 第一优先级隔离诊断

源码目录可运行以下检查，预算取 `nativeInterface.timeoutMs`，可执行路径取 `agents.codex.executable` 或显式参数：

```text
npm run codex:provision-check -- --config config.example.json --executable <官方 Codex 绝对路径> --name-dormant-threads
```

它创建独有临时目录与 Codex home，不继承真实登录或 MCP 配置，不读取凭据。先从模型目录选择两种模型及两档强度，在同一目录创建三个 Codex ID、另一目录创建一个 ID。核对创建回执中的模型/强度，再按 ID 和 cwd 读回。可选名称仅写入本次新建的 Codex 测试对话，不能算作 GPT 改名验证。

随后关闭自有实例、重开同一隔离 home，读取原 ID，并在不传模型/强度覆盖参数的情况下 resume 核对保存的设置，再检查按目录分组的列表。任何不匹配、请求失败、超时、交互认证/审批或清理失败都会报告失败，禁止转入生产宿主。`--skip-listings` 明确跳过列表时只能返回 PARTIAL，不计通过。

本机已确认创建四个不同 ID，`gpt-6.1-sol` 的 low/ultra 与 `gpt-6-astra` 的 low 创建回执一致。仅创建的零消息会话在新实例读取失败；增加官方 `thread/name/set` 后四个 ID 均可重新读取。无参数覆盖的保存设置恢复检查未通过，零消息列表也返回空页。它们是明确遗留，不能宣称原生桌面 workspace 已绑定、参数永久保存或真实模型已执行。

函数 `checkCodexProvisioning` 供可信嵌入调用，不是生产创建适配器或 MCP 任意 RPC 工具。清理仅针对该调用创建并核对过的临时根；失败时返回 `cleanupCode` 和目录名，保留所有权标记，不能转而删除未知数据。

实现依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。本机生成的公开协议 schema 另外确认了字段和审批枚举；没有复制第三方项目实现。

## 实验项目 API 与精确命名诊断

当前官方 CLI 的 `generate-json-schema --experimental` 还包含 `project/create`、`project/read`、`project/list` 和 `thread/start.projectId`。稳定 schema 不包含这些字段；不能据此误判底层完全没有项目 API。

```text
npm run codex:project-check -- --config config.example.json --executable <官方 Codex 绝对路径>
```

根宿主入口与 `./codex-app-server` 导出 `checkCodexProjectProvisioning`。它在独有 home 建两个项目，验证 idempotencyKey 重放不产生新项目，每项目精确名称及根路径；随后给 A 建三个、B 建一个无消息 Codex 对话，显式带 projectId，分别核对归属、目录，设置临时名称后精确改为中文最终名。关闭连接、重开同一 home，再按原始 ID 验证项目、四个对话、项目归属和精确名称。最后检查项目及项目内对话列表，不调用 turn/start。

本机真实检查已确认上述创建、幂等、归属、命名和冷读取，项目列表也匹配两个项目；无消息对话列表却分别返回 0，预期 3/1。连续两次后停止重复列表路径；`--identity-only` 不调用列表，明确返回 PARTIAL。它也不能证明保存的模型/强度或真实推理已执行。此结果只证明独立 App Server 的项目登记，原生桌面 saved-project 登记、普通 GPT 创建和完整业务流程仍未验证。

隔离 CLI 默认插件同步曾留下文件锁；诊断现在用官方 feature 开关关闭自身插件/远程插件/应用功能，先关闭 stdin 等待退出，再有限度终止自有实例。修正后的 identity-only 真实测试临时目录完整清理。早期两处残留的单次清理被自动审批拒绝，未删除也未换工具绕过；不以最后一次清理成功抹去旧残留。

参考：[公开项目协议定义](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)、[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。[桌面项目创建请求 #25385](https://github.com/openai/codex/issues/25385)报告独立 App Server 与桌面登记可能不同；这是外部报告，当前应用的工具目录也未提供桌面项目创建，不能假设已经修复。
