# Agent Control Bridge

通用 Windows 10/11 本机 MCP 工具，Hermes/飞书是首选控制器，也可接入其他符合约定的 MCP Client。GPT 生成工程 Prompt，Bridge 核验来源并投递，Codex 执行，结果回同一 GPT 复核，独立 Reviewer 验收。复用现有登录态，不引入额外按 Token 计费的 OpenAI API。

每项目固定 **一个原生 Codex workspace、一个同名普通 GPT 对话、多个该 workspace 内 Codex 对话**。SQLite 保存映射、来源、状态、通知及回执，禁止跨项目混用身份。

    飞书 → Hermes → 普通 GPT → 来源核验 → 登记的 Codex → GPT 复核
             ↑                    Bridge / SQLite          ↓
             └──── 通知、实际交付、独立验收 ←───────────────┘

0.2.0 为待独立验收开发版本。历史隔离 GPT → 原生 Codex → GPT 闭环曾需要人工页面定位和恢复，不能替代当前更严格写链路的验收。**创建 Workspace 和普通 GPT 允许正常 UIA、目录确认和页面/编辑焦点变化，不要求完全静默。** 最新只读检测中配置的 CDP 端点没有监听，UIA 返回 unavailable、未取得可信名称；此前曾实测 titleOnly，不能当作当前状态。现有聊天写入仍被精确身份要求阻断。本轮未执行真实 GUI 写入或 Hermes/飞书闭环。实际 GPT 模型/思考强度未知记录 null，不阻断真实来源。

## 能力与自动化边界

| 技术 | 操作 | 依赖 GUI | 页面/编辑焦点影响 | 静默能力 |
|---|---|---|---|---|
| Native IPC | 项目、会话、目录及轮次只读 | 不操作 GUI | 实测读取未改变前台 | 当前签名宿主兼容性接口，有条件；不是承诺稳定的公开外部 API |
| Windows UIA | 正常按钮、菜单、编辑框和正文 | 是，桌面须可交互 | 可能切换页面和编辑焦点 | 不保证；需要可信宿主本次批准 |
| 当前实例 CDP | 普通 GPT 精确 ID、可见正文与状态读取 | 依赖现有页面和调试端点 | 只读不导航 | 校验监听进程、签名和唯一已有目标；不自动开启端口 |
| Codex App Server | 正式 stdio 工程执行和事件 | 不依赖桌面 GUI | 通常无须焦点 | 协议支持；仍须可信原生归属和会话排他证明 |

| 业务操作 | 适配器/实际证据 | 桌面条件与影响 | 限制 |
|---|---|---|---|
| 创建原生 Workspace | ProjectHost 的 UIA 创建与原生 ID/目录回读；历史实机、当前组件证据分开 | 可交互；可能改变页面/编辑焦点 | 文件系统创建前即要求本次精确目录批准；App Server 项目不算原生 |
| 创建/命名普通 GPT | 新空白普通聊天用唯一初始化标识建立 ID，再核对 Native 新增基线、用户消息、类型和标题 | 可交互；会改变页面 | 只用于本次批准的新空白聊天；无工程内容；当前实现仅组件验证，失败不重发 |
| 创建 Codex/核验归属 | 必须安装正式原生创建回调，核对原生 projectId/cwd | 取决于正式宿主 | UIA Work 创建/工程发送已拒绝；GPT /c/UUID 不能证明 Codex 身份 |
| 完整 GPT 回复/发送 | 发送一次，Native 完成后读取 UIA/CDP 最终内容并复核消息 ID/Hash；组件验证 | UIA 需要可交互桌面 | 当前跨 CDP/UIA 的原子目标保证未打通；titleOnly 不允许现有聊天写入；内容引用不是正文 |
| App Server 后台执行 | 原生目标绑定 + 正式 stdio、turnId、事件和结果；组件验证 | 不操作 GUI，可独立于 MCP 客户端连接运行 | 需真实 Executor 委托及命令/文件审批回调；尚未实际部署长任务，不负责原生项目创建 |
| 状态/通知/恢复 | 队列、Watcher、outbox 和对账入口；隔离测试与原生恢复实证 | 普通状态查询无 UI；GPT 对账可能导航 | 不以失联推断完成；周期/阈值取统一配置 |
| 独立验收/飞书送达 | 受保护 reviewer + Hermes 既有通道 | 无须桌面写入 | 开发者/GPT 不能自验；Hermes stdio 写宿主与飞书端到端待实测 |

不启动第二实例、Profile、浏览器/WebView；不重启或停止现有应用，不提升权限、注入、写应用私有数据库、提取凭据或接管物理输入。UIA 仍使用既有局部查询和 Automation Pattern，没有另建驱动或坐标兜底。

## 安装与配置

Node.js >=24.19.0、npm、Git。Windows IPC/UIA 使用系统 PowerShell 5.1，无须另装 UI 框架。只有保留的 CDP Python 适配器需要 Python >=3.10 及 websocket-client。

当前只读验证环境：Windows 11 build 26200、Node 24.19.0、OpenAI.Codex 26.1007.2314.0。Windows 10 为目标部署平台，尚无本轮实机证据；第三方应用更新可能改变 IPC/UIA/CDP，兼容性须按实际目标验证，内部接口不承诺官方稳定支持。

    git clone https://github.com/wynter-yaxley/agent-control-bridge.git
    cd agent-control-bridge
    npm ci --ignore-scripts
    npm run build
    node dist/cli.js help
    node dist/cli.js demo

demo 使用唯一临时库与明确 Mock 来源，退出清理，不调用真实模型或读取业务库。Mock 不能通过配置开启生产权限。

复制 [config.example.json](config.example.json) 为 .bridge.config.json，配置实际路径和启用项。默认 Agent/桌面操作关闭；CLI > ACB_* 环境变量 > 文件 > 默认。配置不是角色或 UI 授权。

| 配置 | 默认值及用途 |
|---|---|
| database.path | ./data/bridge.db，专用台账 |
| background.workspaceRoot / maxConcurrent | ./workspaces / 1，GUI 串行，后台执行独立计数 |
| background.timeoutMs / leaseSeconds | 120000 / 600，单次传输/GUI 预算；持久执行定期续租、不受整个任务时长限制 |
| background.intervalMs / watcher.intervalMs | 60000，事件触发加周期兜底 |
| watcher.timeoutMs / failureReporting.blockedAfterMs | 10000 / 600000，检测预算和持续阻塞上报阈值 |
| nativeInterface | 原生预算、帧大小、候选上限和只读白名单 |
| desktop.uiPollMs | 100，UIA 控件等待周期 |
| desktop.cdpUrl / python | 已有回环调试端点 / Python；UIA 路线无须 CDP |
| agents.chatgpt.model / reasoningEffort | 请求 gpt-6 / high，不代表实际参数已验证 |
| agents.codex.executable / model / reasoningEffort | 正式 CLI 路径和显式执行参数；默认 null，不借用 GPT 参数 |

真实 GPT/Codex 还需对应 agents.*.enabled。GPT 曾超过 120 秒，上一隔离测试使用 timeoutMs=600000、leaseSeconds=1000、uiPollMs=1000；这些值不是时延保证。

新库可用 node dist/cli.js init --config <配置>。既有库先一致性备份、在副本验证，再显式 migrate；不自动迁移业务库，不只复制活跃 SQLite 主文件而忽略 WAL。

身份来自 OS principal 与受保护的 [caller-policy.example.json](config/caller-policy.example.json)，实际策略固定为 config/caller-policy.json。controller、Codex executor、独立 reviewer 分开，保护策略/代码/库 ACL。业务文本、环境变量、MCP 参数和 --by 不能授权。同 OS 任意恶意代码不受台账角色隔离；没有公共多租户 HTTP 服务。

## Hermes / MCP 接入

    node <项目绝对目录>/dist/mcp.js --read-only --config <配置绝对路径> --db <已有专用数据库绝对路径>

stdout 只承载 MCP，安全错误写 stderr。默认入口只注册 8 个只读工具，以 SQLite readOnly/query_only 打开已有 v6 库，不建库、不迁移、不改 ACL、不启动队列。通用 MCP Client 可以使用同一 stdio 契约；没有强制 Hermes 身份文本要求。

最小 Windows 组合入口：

    node dist/windows-host.js --config <配置> --db <已有 v6 库>
    node dist/windows-host.js --write --config <配置> --db <已有 v6 库>

默认只读；--write 按调用者策略角色开放台账工具，不启动任务队列，也不凭开关授予 GUI 权限。MCP 进程只提交/查询，**另起一个同台账 --worker 运行时**持续执行和对账，客户端断连不停止它。不要从配置、环境变量或 MCP 加载任意插件代码。

    node dist/windows-host.js --preflight --config <配置> --db <库> [--carrier-thread <已登记 Codex ID>]

--preflight 只读：输出调用者策略角色、各角色数量、本 Controller 的执行者委托、库 Schema 与未归属旧项目数、Codex 配置、CDP 端口是否监听、受限 UIA 结构摘要（只含控件类型/类名/层级/Pattern，不含名称和正文）、原生项目/线程数量，以及 blockers。

没有嵌入程序时，组合入口只从受保护的 config/caller-policy.json 取得能力：执行者条目写 "host": "<Controller SID>" 才是本 Controller 的唯一委托执行者，SID 必须与 Controller、Reviewer 不同；这是部署者在信任根中的委托，不是 OS 级隔离。Codex 命令/文件审批写入台账 approvals，只能由独立 Reviewer 用 acb_approvals_pending / acb_approval_decide 决定；turnId 不是本次已记录的原 turn、cwd/grantRoot 越出工作区、含认证材料、超时（background.timeoutMs）或取消时一律拒绝，绝不自动接受。缺少任何前提时 --worker 拒绝启动，并列出 EXECUTOR_DELEGATION_MISSING、CARRIER_THREAD_MISSING、CODEX_EXECUTABLE_MISSING、CODEX_MODEL_OR_EFFORT_MISSING。原生项目宿主默认只读：创建被拒绝，reconcile/adopt/attach 只回读。只有 Controller 连接且配置 desktop.enabled=true 时才允许创建：新 Workspace 与普通 GPT 的 UI 初始化先写入台账审批（gui-initialization），由独立 Reviewer 用 acb_approval_decide 决定，同一名称/路径 10 分钟内有效，拒绝或超时即不创建。没有正式原生 Codex 创建回调时，操作在 Workspace 与 GPT 完成后停在 BLOCKED / CODEX_ATTACH_REQUIRED（phase=codex.attach）：操作者在该 Workspace 中手工新建 Codex 对话，再用 acb_project_attach_codex 逐个附加；每个 ID 都必须由 Native IPC 回读为该 Workspace、该目录下的 Codex 线程。现有 GPT 对话的发送/读取批准仍需 runWindowsHost(args, createBindings) 嵌入真实回调。

受保护启动代码复用既有实现，trusted 必须来自实际宿主，提供本次批准和真实执行者绑定，没有自动批准默认值：

    import {
      runWindowsHost, WindowsNativeUi, createWindowsNativeReadTools,
      createWindowsNativeProjectHost, createWindowsNativeConversationHost,
      createDesktopGptReader, createWindowsNativeGptReader,
    } from './dist/host-api.js';

    export async function startDesktopBridge(args, trusted) {
      await runWindowsHost(args, ({ config, authority, context }) => {
        const ui = new WindowsNativeUi(config);
        const native = createWindowsNativeReadTools(
          config, trusted.carrierThreadId, trusted.createCodexThread,
        );
        const gptReader = createDesktopGptReader(config, trusted.configPath);
        const { ordinaryChat } = createWindowsNativeConversationHost({
          config, native, ui, authorizeUiOperation: trusted.authorizeUiOperation,
        });
        return {
          projects: createWindowsNativeProjectHost({
            config, native, ui, authorizeInitialization: trusted.authorizeInitialization,
          }),
          ordinaryChat, gptReader,
          gptUiReader: createWindowsNativeGptReader(config, trusted.carrierThreadId, ui),
          executorContext: trusted.bindExecutor(authority, context),
          approveCodex: trusted.approveCodex,
        };
      });
    }

该例是需要接入真实外部授权的组合方式，不提供 trusted 的伪实现。启动时还须给 --carrier-thread <已登记的原生 Codex ID>，以便组合入口安装 App Server Executor；正式原生 Codex 创建回调缺失则明确阻断，没有 UIA Work 兜底。carrierThreadId 只是传输上下文，不授予角色。审批绑定项目/目录/会话/动作/有效范围；命令与文件变更由可信审批回调决定，认证/登录请求拒绝。没有实际委托不能默认批准。

Controller、Executor、Reviewer 必须是不同的受保护主体/连接，Reviewer 不兼任 Controller 或 Codex。普通 Controller 不能提交最终验收或执行 Reviewer 专属恢复。策略与代码在受控启动时加载，不热更新授权；改源码不能提升运行中的权限。同 OS 用户恶意代码仍可破坏本机运行时，不能声称强隔离。实际本机策略已取消 Controller/Reviewer 重叠，独立 Reviewer 仍需部署者提供。

[Hermes MCP 样例](config/hermes-mcp.example.yaml) 开放 8 个查询/诊断工具；可信写入口有 25 个工具，包括设置默认 Codex、旧项目 adopt、Workspace 步骤显式重启、Codex 附加与 Reviewer 审批。Reviewer 使用单独受保护连接。路径变量替换为实际非秘密路径。只读示例 timeout 为 300 秒：最长 GPT 诊断顺序为 CDP 120 秒、UIA 回退 120 秒、原生核验 30 秒，加 30 秒客户端余量；预算变化时按统一配置重新计算，普通台账查询通常立即返回。同步项目创建另按实际阶段设置预算；工程任务提交立即返回 ID，由独立 worker 执行，不能用延长 MCP 超时替代它，也不能因客户端断开重新发送。

WSL Hermes 使用可执行的 Windows Node 绝对路径（WSL 下为 /mnt/c/.../node.exe），入口/配置/库参数使用 Windows 绝对路径，Node >=24.19.0；不要把 Linux Node 当作 Windows UIA 宿主。tools/hermes/mcp_probe.py 只验证隔离协议，不是真实写宿主。HermesGatewayAdapter 复用已验证飞书事件和可信项目路由；NotificationDispatcher 持久保存回执，不另起事件消费者。

Hermes 虚拟环境 MCP SDK 已连接 Windows 编译入口与真实 OS 策略，发现 8 个只读工具并观察到 HOST_MISSING；没有启动 Hermes Agent/飞书消费者、修改实际 profile 或发送消息。现有部署业务库 v2 被 SCHEMA 拒绝，需部署者备份后显式迁移；本轮未改业务库。实际策略的 Controller/Reviewer 重叠已取消，独立 Reviewer 仍未配置；只读连接没有验收或写工具。

已检查 Hermes 的 MCP trust gate 与 form elicitation：它们能询问用户，但没有现成的受保护 Windows 回调，把批准与本次会话 ID/动作/事件及 executor 绑定。不能把客户端 JSON accept 当作宿主授权。最小写接入条件是受保护 Windows 组合根提供已有 authorizeInitialization/authorizeUiOperation 与 bindExecutor，批准可撤销且限定本次范围，独立 reviewer 分离；本项目不另建认证/RPC 框架。

## 精确会话与完成边界

CDP 优先复用当前实例已有端点，先校验端口所属签名进程与唯一已有 ChatGPT WebView，再比对 /c/UUID 和 Native 登记 ID。不能连接或无法证明唯一目标即回退 UIA Document.Current.Name，返回 titleOnly、conversationId:null 和空消息，不反复扫描 UUID；连名称也不可得（含名称为空）则 unavailable，reason 给出失败阶段：interactive-desktop（锁屏/非交互桌面）、chatgpt-process（进程不存在）、chatgpt-window（无唯一主窗口，如窗口隐藏到托盘或存在多个窗口）、gpt-document（无 Document）。诊断保留 cdpError，不把回退当作 CDP 成功。identityVerified 与标题证据严格区分。

现有聊天写入仍需在同一桌面操作中、修改草稿前和提交前核对精确身份，并在提交后验证原生回执。当前 UIA URI 只有通用 index.html，跨 CDP/UIA 的原子目标保证也未打通，故拒绝工程写入。新聊天仅在本次可信创建批准下有例外：确认新建空白普通聊天，以唯一 ACB_INIT 标识发送不含工程任务的初始化消息，关联原生新增 ID/精确用户消息/类型/同名标题；不确定即保留原阶段，不重发。Codex 不使用 GPT 页面 URI，也没有 UIA Work 工程发送兜底。

生成只发送一次；原生最新轮次 completed/idle 后才读取最终正文，匹配用户 Prompt、助手消息 ID 并再次核对原生轮次。UIA 还需非流式状态与精确回复操作；CDP 需要该助手消息自身的明确流式结束证据，缺失不猜测。按钮或合成 completed 单独不足。全文/Hash 保留原台账，完成证据写现有审计/反馈字段；未知结果对账原轮次、不重发。Native content-reference 仍不是正文。

这些正向完成路径本轮只经组件测试，当前界面缺 ID，不能宣称实机最终正文已验收。NativeChatMessageHost 已有正式发送/回读及可见正文关联能力；本轮没有改写其 IPC 协议，也不把 content-reference 当完整正文。

## MCP 工具

保留原 acb_ 名称，不增加动态搜索/注册中心。状态为紧凑摘要，完整证据按需读。

| 工具 | 功能 |
|---|---|
| acb_capabilities | hostStatus:missing/installed/readyForTargetChecks；可指定 projectId/conversationId 查 targetStatus；verified 仅证明观察到的身份，不是执行授权或环境验收 |
| acb_project_prepare / acb_project_get | 成套创建、状态及已记录资源 ID；READY 才能用于任务 |
| acb_project_reconcile | 核对原阶段/回执，继续安全确认尚未开始的步骤；不替换已知资源 |
| acb_project_default_codex | 选择同项目已登记的默认 Codex；CLI 同步提供 mapping-default |
| acb_request_submit / acb_request_get | 需求入队、可指定 codexConversationId，否则用显式默认；eventKey 去重、状态/version/attempt/最后事件 |
| acb_request_retry | 原因修复后重试无未知外部结果的 BLOCKED |
| acb_execution_result | 默认结果/反馈 ID、哈希、字符数；includeContent:true 取完整正文 |
| acb_execution_review | 将保存交付回固定 GPT 一次，不等于验收 |
| acb_request_reconcile_generation | 回读原 GPT 生成并恢复队列，不重发 |
| acb_request_reconcile_execution | 原执行者核对原回执再回 GPT，不重跑 |
| acb_execution_reconcile_feedback | 回读原 SENDING/UNCERTAIN 反馈，不重发 |
| acb_notifications_pull / acb_notifications_ack / acb_notifications_status | 通知领取、实际 external receipt 确认、数量/不确定发送 |
| acb_review_submit | 独立 reviewer 与 expectedVersion；controller/executor 不开放 |
| acb_codex_target_check / acb_native_target_check / acb_gpt_read | 可选只读诊断，不授予执行/创建/生成完成权限 |

兼容变化：需要全文的旧客户端给 acb_execution_result 加 includeContent:true。原正文仍在台账保存，状态查询不重复返回 Prompt/历史。project 操作的 resources 返回已取得的 appProjectId、GPT/Codex conversationId 和路径，省去 CLI 映射查询；部分身份不代表成功。

## 一次真实工作流

1. 构建后先跑 windows-host --preflight，按 blockers 补齐策略委托、Reviewer、库迁移/adopt、--carrier-thread 与 Codex 配置；再绑定本次 UI 范围并查 acb_capabilities。HOST_MISSING 先安装，不在未变环境反复重试。fullWorkflowReady 固定 false，TARGET_ENVIRONMENT_ACCEPTANCE_REQUIRED 留给目标验收，不伪造通过。
2. acb_project_prepare {name,eventKey} 创建唯一隔离套件，保存 operationId/projectId/resources。GPT 精确同名，原生 ID/路径/ordinary 模式/Codex 成员关系必须回读。
3. 启动独立可信 worker；acb_request_submit {eventKey,projectId,title,requirement,codexConversationId?} 返回持久 requestId。指定目标或显式默认，绝不按 ID 排序。需求不是工程 Prompt；worker 生成、核验、投递、续租、收集并回 GPT。执行中 Codex 的命令/文件审批由独立 Reviewer 在 acb_approvals_pending 中查看并用 acb_approval_decide 决定，超时即拒绝。
4. 优先消费通知；仅在状态变化、恢复、验收需要时查状态。WAITING_APPROVAL 且反馈 COMPLETE 后，acb_execution_result {requestId,includeContent:true} 一次读取证据；必要来源字段由受保护只读台账核对。
5. Hermes 独立验证实际文件/测试，再由独立 reviewer 调 acb_review_submit {taskId,expectedVersion,pass,reason}。GPT 复核/Codex 自报 PASS 不替代验收。
6. 领取通知后由 Hermes 原飞书通道发送，保存真实 receipt 再 ack。结束只清理归属明确的本次测试资源，不动用户库、其他 workspace/聊天。

最小真实测试仅在新目录创建唯一文本文件并核验固定内容，不重复旧探针。只有独立验收能进入 SUCCEEDED。用户 workspace/配置及忽略的私有运行证据不属于源码清理范围。

## 故障与恢复

| 错误/状态 | 处理 |
|---|---|
| AUTH / OWNER | 核对真实宿主/上下文/本次批准，不能自签业务角色或改私有状态 |
| BLOCKED / UNSUPPORTED | 报告缺失宿主/控件；环境未变不重试 |
| PROVENANCE | 核对原会话/标题/归属、完整正文、消息 ID/哈希；不放宽条件 |
| CONFLICT | 查看 version/attempt/holder，保留用户草稿及运行任务 |
| GPT generation UNCERTAIN | reconcile_generation 回读原请求；合成完成不足以证明流式结束 |
| 工程 UNCERTAIN | 原 turnId 或精确 dispatchId 回读；仍运行则 RUNNING，完成进入 WAITING_APPROVAL，不 resume/start 重跑 |
| 反馈 SENDING/UNCERTAIN | reconcile_feedback，不重发结果 |
| project UNCERTAIN | 保存 phase/resources；只有唯一原阶段回执才能补记遗失 ID，安全缺失步骤才继续；未知则阻断，不补造。重启后的新宿主按原生项目/线程归属和原 ACB_INIT 初始化消息核验已有资源，不要求重新打开 GPT 页面。stages 分开报告目录已建、原生 Workspace、GPT 与 Codex 数量；phase=workspace 且原生端查不到时 reconcile 只返回 PROVENANCE，不会续跑。原持有者已退出、目录仍为空、原生端列不出该目录的任何 Workspace 时，Controller 可调用 acb_project_restart_workspace 显式重试这一步（需宿主本次批准、写审计、每个操作最多 2 次）；目录非空或已有原生 Workspace 时拒绝 |
| DB / SCHEMA | 一致性备份、副本验证、显式迁移；迁移后旧项目没有 project_access，须 acb_project_adopt 按已记录的 GPT/Codex ID 回读原生归属后才授予访问，mapping-register 不再认领无主项目 |
| TIMEOUT / 失联 | 保留未知结果并按阈值报告，不以失联推断成功或确定退出 |

恢复应用先报告、确认退出、取得事件批准、核对原映射；不可结束仍运行的应用。页面不稳定/账户挑战须如实报告，不能保证零风控。

worker 启动按 PID/进程启动标识核对原持有者。已退出/状态未知的生成、执行、反馈和项目操作保留 ID 转入 UNCERTAIN 并通知；不会把存活持有者的工作抢走。未知任务只限制同项目及有关 GUI 阶段，其他项目已准备好的可信 Prompt 可继续后台执行；真实 RUNNING 后台任务仍遵守单并发。锁屏或非可交互桌面拒绝 GUI 副作用，已授权 App Server 执行继续。持久执行的 RPC 有单次预算，整个工程轮次不使用十分钟总超时。

Prompt 已完整保存但尚未投递时，只有原进程确定退出、来源/会话/正文 Hash 有效、生成 COMPLETE、Prompt PENDING、Task QUEUED 且没有 dispatch/execution 证据，才恢复原请求继续投递；不重新调用 GPT。已经 UNCERTAIN 的此类旧记录也可用 reconcile_generation 恢复，未知投递保留原证据。Windows 不存在 PID 的正常查询不再被误判为未知；实际查询错误仍是未知。

原执行从 UNCERTAIN 观察为 RUNNING_OBSERVED 后，再取得原完成回执时同步 Task、Execution 与 Request 到 WAITING_APPROVAL，并检查更新行数。普通 RUNNING 不接受这一恢复入口；重复完成对账不重复通知、工程执行或 GPT 反馈。

正式原生 Codex 创建回调只保证 threadId，以及可能提供的 projectId；当前没有可回读的 operationKey 契约。恢复不再搜索从未发送的 ACB_CODEX_INIT。已记录的原 threadId 必须回读原生项目/目录；如果创建成功但 ID 未保存，只有宿主另有真实原操作回执才能恢复，否则保持 UNCERTAIN，不按同名清单猜测、不探针发送、不重新创建。保留已建 Workspace、GPT 和路径。

## 数据管理

    node dist/cli.js db-backup --config <配置> --file <专用备份目录中的新文件>
    node dist/cli.js db-restore --file <已验证备份> --db <专用恢复目录中的新文件>

使用 SQLite 在线 backup，包括 WAL 中已提交的数据。备份/恢复拒绝覆盖已有文件；恢复校验完整性，只写新台账，不覆盖活跃任务。部署者先停止 Bridge 自有运行时、检查新库及原会话映射，再受控切换配置；不停止 ChatGPT/Codex，也不自动迁移或启动 Agent。清理只针对关闭连接后、能证明归属的已结束隔离测试资源，未知业务目录不删。数据库不默认上传云端。v6 迁移增加进程所有者、创建阶段、GUI 占用和默认/指定 Codex，旧多会话映射需明确选择默认。

## 性能、生命周期与验证

每个 Bridge 进程/Windows 用户会话串行复用一个自有 PowerShell worker，JSON 行和原 JSON-RPC ID 关联请求。新 pipe handle 均核对签名宿主 PID/启动时间；签名/同用户检查只对同一存活进程缓存。超时只结束自有 worker，不重放请求、不动桌面应用。runMcp 在在途操作结束后关闭 worker；直接底层宿主退出时调用 closeNativeReadWorker() 或 NativeReadWorker.close()。

2026-10-13 少量同机只读采样：原两次启动耗时 4583/1628ms，复用冷/热为 3828/219ms，启动数 2→1，59 字节摘要一致、前台未变。只测一次冷/热组合，不是 SLA 或实际 Token Usage；没有遥测服务。App Server 在单次执行内已复用连接读事件和结果，不引入进程池。UIA 现复用一个串行自有 Worker，每次重新获取窗口/root/控件并释放 mutex，不缓存 UI 元素。只读测量：初始实验初始化 220ms、查询 188ms；同进程第二次 3ms/51ms，含两次查询的进程总计 906ms。改动后实际调用冷/热 1320ms/53ms，初始化 235ms 仅发生一次、控件查询 225ms/51ms；另一次错误身份检查在导航前 PROVENANCE，零写操作。可调用时现有组合路径约 8–9 次 UIA 调用，未实测整项业务总时长，当前身份阻断不能推算端到端提速。runMcp 退出在途操作后关闭自有 UIA Worker；直接 API 用户调用 closeWindowsNativeUiWorkers() 或 ui.close()。

    npm run typecheck
    npm run build
    npm test
    npm run test:desktop
    npm run check
    npm audit --audit-level=high
    npm run test:install

37 个帮助命令子进程实测共 5780ms；同一命令集转入既有 CLI 单元测试（35 个直接调用、demo/watch 保留入口进程验证），静态 check 不再重复启动。完整祖先安全扫描保留，未测得收益的 CI/安装矩阵不改。

check 的本机路径规则与运行账户无关：任何具体的 /home/<名称>/ 或 \\Users\\<名称>\\ 都会被拦截，占位符除外，同一提交在任何机器上结论相同。[scripts/check-history-baseline.json](scripts/check-history-baseline.json) 仅登记首个已发布提交中两个确定路径/Blob Hash 的 localUserPath；清单扩展、后续提交复用旧 Blob、相同内容出现在私有路径、当前树及新 Blob 均失败。acknowledgedHistory 只是技术登记，输出 PENDING_HERMES_POLICY_REVIEW，须独立 Reviewer 批准历史例外；改变检查器源码本身仍须独立审查。npm 配置为不支持审计接口的镜像时，可临时运行 npm audit --registry=https://registry.npmjs.org/，不修改原 Registry。

npm test 已发现全部 Node 测试，包含 e2e/workflow；CI 不再重复同一 e2e 集合。test:e2e 仍可定向执行。干净安装只验证依赖/构建/编译入口/Mock 演练，不重跑源码矩阵。Mock 通过不等于桌面、Hermes/飞书验收。

只读诊断保留 native:check、codex:check、codex:target-check；飞书发送测试需明确批准。删除旧创建目录研究、实验 App Server 项目探针、第二 Profile 原型。保留当前 CDP 读取及有调用依赖的兼容模块。

结构保留职责层次：mcp-server/mcp 为协议；background/project-provisioner/prompts/tasks/topology/outbox 为业务；native-readonly/windows-native-host 为 IPC/UIA；codex-app-server/ordinary-chat/hermes-gateway/notification-delivery 为适配器。没有为美观搬迁整个项目。

实际源码参考：[WPS 常驻 JSON 行宿主](https://github.com/sueccku/dsh-plugin-wps-office-next/blob/bc69b96fca0c30e63680a151ebf96a093404d2da/host/wps-com-host.ps1)、[mcp-windows 局部查询](https://github.com/sbroenne/mcp-windows/blob/655b9fc92d03ad52a270067c6844ea1231c90559/src/Sbroenne.WindowsMcp/Automation/Tools/UIFindTool.cs)、[FlaUI 批量动作](https://github.com/shanselman/FlaUI-MCP/blob/da1d2a24eae6ccdfbbd40a1375b6617536552351/src/FlaUI.Mcp/Tools/BatchTool.cs)、[winapp Pattern 操作](https://github.com/microsoft/winappCli/blob/96f487615872f7c0e4032e0361856e3109a477e3/src/winapp-CLI/WinApp.Cli/Commands/UiInvokeCommand.cs)、[mcp-compressor 门面转换](https://github.com/atlassian-labs/mcp-compressor/blob/86dc1dfd414d68914d2fbb7b2421420c3f74bbea/python/mcp-compressor/mcp_compressor/transforms.py)。只借鉴原则，不复制/执行源码或引入框架；默认 8 个、可信写入口 25 个工具不需要动态 Catalog。

规则见 [PROJECT_RULES](docs/PROJECT_RULES.md)，独立报告用 [验收模板](docs/ACCEPTANCE_TEMPLATE.md)。保留 [MIT LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。报告存项目 docs，私有历史不发布，不再写个人文件夹。

默认不新增调研、阶段报告或一次性测试 Markdown；使用说明更新本文、行为更新 CHANGELOG，过程留在 PR/CI。只有用户明确要求才新增独立报告。
