# Agent Control Bridge

Hermes 通过飞书协调现有 ChatGPT/Codex：GPT 生成工程 Prompt，Bridge 验证真实来源并投递，Codex 执行，结果回同一 GPT 复核，Hermes 独立验收与报告。复用现有登录态，不提供模型推理服务，不引入额外按 Token 计费的 OpenAI API。

每项目固定 **一个原生 Codex workspace、一个同名普通 GPT 对话、多个该 workspace 内 Codex 对话**。SQLite 保存映射、来源、状态、通知及回执，禁止跨项目混用身份。

    飞书 → Hermes → 普通 GPT → 来源核验 → 登记的 Codex → GPT 复核
             ↑                    Bridge / SQLite          ↓
             └──── 通知、实际交付、独立验收 ←───────────────┘

0.2.0 为待验收开发版本。已完成真实隔离 GPT → 原生桌面 Codex → GPT 闭环，过程中需要页面定位、停止生成与对账恢复。**按用户 2026-10-13 要求，创建 Workspace 和普通 GPT 不要求完全静默，允许正常 UIA、目录确认和页面/编辑焦点变化；完全静默不再是这两项创建的验收门槛。** 默认 MCP 仍须接入可信桌面写宿主。实际 GPT 模型/思考强度未知记录 null，不再阻断；真实来源、完整正文、精确会话/消息 ID 和哈希仍须核验。

## 能力与自动化边界

| 技术 | 操作 | 依赖 GUI | 页面/编辑焦点影响 | 静默能力 |
|---|---|---|---|---|
| Native IPC | 项目、会话、目录及轮次只读 | 不操作 GUI | 实测读取未改变前台 | 当前签名宿主兼容性接口，有条件；不是承诺稳定的公开外部 API |
| Windows UIA | 正常按钮、菜单、编辑框和正文 | 是，桌面须可交互 | 可能切换页面和编辑焦点 | 不保证；需要可信宿主本次批准 |
| 当前实例 CDP | 已有受控页面读取/传输 | 依赖现有页面结构和调试端点 | 读取不导航；写入可能影响页面/焦点 | 不保证；不自动开启端口或创建浏览器/Profile |
| Codex App Server | 正式 stdio 工程执行和事件 | 不依赖桌面 GUI | 通常无须焦点 | 协议支持；仍须可信原生归属和会话排他证明 |

| 业务操作 | 适配器/实际证据 | 桌面条件与影响 | 限制 |
|---|---|---|---|
| 创建原生 Workspace | WindowsNativeProjectHost：正常 UIA + 原生 ID/目录回读，组件真实通过 | 可交互；可能改变页面/编辑焦点 | 本次初始化与精确目录批准；独立 App Server 项目不算原生 |
| 创建/精确命名普通 GPT | 同一 ProjectHost；正常聊天模式、改名保存、ID/标题回读真实通过 | 可交互；会改变页面 | 标题与 workspace 完全同名；整套自动创建待部署实测 |
| 创建 Codex/核验归属 | 正式宿主创建及原生 projectId/cwd 回读真实通过；UIA Work 分支有实现 | UIA 创建依赖可交互界面 | 新 UIA 创建分支未整套实测；不能只凭 cwd 推断成员关系 |
| 完整 GPT 回复/发送 | ConversationHost：UIA 正文 + 原生消息关联；真实工程 Prompt/反馈通过 | 可交互；导航/发送可能改变页面和编辑焦点 | 内容引用不是正文；合成 idle/completed 不能证明流式结束；诊断读取不授予生成权 |
| 原生 Codex 执行 | ConversationHost + runner；真实文件及一次 Node 断言通过 | UIA 发送依赖界面，状态/最终输出经 IPC 读回 | 只执行一次，回执丢失须对账原执行 |
| App Server 后台执行 | 既有执行适配器；协议/事件/沙箱经隔离测试 | 不操作 GUI | 当前目标的真实工程集成待独立验收，不负责原生桌面项目创建 |
| 状态/通知/恢复 | 队列、Watcher、outbox 和对账入口；隔离测试与原生恢复实证 | 普通状态查询无 UI；GPT 对账可能导航 | 不以失联推断完成；周期/阈值取统一配置 |
| 独立验收/飞书送达 | 受保护 reviewer + Hermes 既有通道 | 无须桌面写入 | 开发者/GPT 不能自验；Hermes stdio 写宿主与飞书端到端待实测 |

不启动第二实例、Profile、浏览器/WebView；不重启或停止现有应用，不提升权限、注入、写应用私有数据库、提取凭据或接管物理输入。UIA 仍使用既有局部查询和 Automation Pattern，没有另建驱动或坐标兜底。

## 安装与配置

Node.js >=24.19.0、npm、Git。Windows IPC/UIA 使用系统 PowerShell 5.1，无须另装 UI 框架。只有保留的 CDP Python 适配器需要 Python >=3.10 及 websocket-client。

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
| background.workspaceRoot / maxConcurrent | ./workspaces / 1，创建和执行串行，共用宿主 |
| background.timeoutMs / leaseSeconds | 120000 / 600，租约大于操作预算 |
| background.intervalMs / watcher.intervalMs | 60000，事件触发加周期兜底 |
| watcher.timeoutMs / failureReporting.blockedAfterMs | 10000 / 600000，检测预算和持续阻塞上报阈值 |
| nativeInterface | 原生预算、帧大小、候选上限和只读白名单 |
| desktop.uiPollMs | 100，UIA 控件等待周期 |
| desktop.cdpUrl / python | 已有回环调试端点 / Python；UIA 路线无须 CDP |
| agents.chatgpt.model / reasoningEffort | 请求 gpt-6 / high，不代表实际参数已验证 |
| agents.codex.executable | 正式 Codex CLI 路径，用于 App Server |

真实 GPT/Codex 还需对应 agents.*.enabled。GPT 曾超过 120 秒，上一隔离测试使用 timeoutMs=600000、leaseSeconds=1000、uiPollMs=1000；这些值不是时延保证。

新库可用 node dist/cli.js init --config <配置>。既有库先一致性备份、在副本验证，再显式 migrate；不自动迁移业务库，不只复制活跃 SQLite 主文件而忽略 WAL。

身份来自 OS principal 与受保护的 [caller-policy.example.json](config/caller-policy.example.json)，实际策略固定为 config/caller-policy.json。controller、Codex executor、独立 reviewer 分开，保护策略/代码/库 ACL。业务文本、环境变量、MCP 参数和 --by 不能授权。同 OS 任意恶意代码不受台账角色隔离；没有公共多租户 HTTP 服务。

## Hermes / MCP 接入

    node <项目绝对目录>/dist/mcp.js --config <配置绝对路径> --db <专用数据库绝对路径>

stdout 只承载 MCP，安全错误写 stderr。默认入口提供台账和按配置启用的诊断；**真实工作流由可信 Windows 组合根通过 runMcp(args, createHost) 安装宿主**。开关不授予桌面写权，也不能从业务消息加载任意脚本。

受保护启动代码复用既有实现，trusted 必须来自实际宿主，提供本次批准和真实执行者绑定，没有自动批准默认值：

    import {
      runMcp, createWindowsNativeReadTools,
      createWindowsNativeProjectHost, createWindowsNativeConversationHost,
    } from './dist/host-api.js';

    export async function startDesktopBridge(args, trusted) {
      await runMcp(args, ({ config, authority, context }) => {
        const native = createWindowsNativeReadTools(
          config, trusted.carrierThreadId, trusted.createCodexThread,
        );
        return {
          projects: createWindowsNativeProjectHost({
            config, native, authorizeInitialization: trusted.authorizeInitialization,
          }),
          ...createWindowsNativeConversationHost({
            config, native, authorizeUiOperation: trusted.authorizeUiOperation,
          }),
          executorContext: trusted.bindExecutor(authority, context),
        };
      });
    }

carrierThreadId 是现有工具调用上下文，不是角色授权。正式 Codex 创建回调可选，否则走已有 UIA Work 分支。授权绑定本次项目名/目录、会话 ID、动作和事件；一次批准可覆盖明确列出的初始化、生成、执行、反馈和清理，不能保存为永久配置。

[Hermes MCP 样例](config/hermes-mcp.example.yaml) 默认开放 15 个流程工具，诊断按需加入，reviewer 使用单独受保护连接。路径变量替换为实际非秘密路径。同步项目调用预算覆盖五个顺序阶段：120000ms 示例为 630 秒，600000ms 示例为 3030 秒；客户端超时不能触发盲目重发。

WSL Hermes 的管道/UIA 宿主运行在当前登录桌面的 Windows 会话，通过既有合法传输连接。tools/hermes/mcp_probe.py 只验证隔离协议，不是真实写宿主。HermesGatewayAdapter 复用已验证飞书事件和可信项目路由；NotificationDispatcher 持久保存回执，不另起事件消费者。

## MCP 工具

保留原 acb_ 名称，不增加动态搜索/注册中心。状态为紧凑摘要，完整证据按需读。

| 工具 | 功能 |
|---|---|
| acb_capabilities | 宿主、阻断、uiInteractionRequired；先查一次，环境修复后再查 |
| acb_project_prepare / acb_project_get | 成套创建、状态及已记录资源 ID；READY 才能用于任务 |
| acb_project_reconcile | 核验原 UNCERTAIN 完整 bundle，不重建、不接受替代 ID |
| acb_request_submit / acb_request_get | 需求入队、eventKey 去重、状态/version/attempt/最后事件 |
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

1. 构建、绑定可信宿主/角色与本次 UI 范围；查 acb_capabilities。HOST_MISSING 先安装，不在未变环境反复重试。fullWorkflowReady 固定 false，TARGET_ENVIRONMENT_ACCEPTANCE_REQUIRED 留给目标验收，不伪造通过。
2. acb_project_prepare {name,eventKey} 创建唯一隔离套件，保存 operationId/projectId/resources。GPT 精确同名，原生 ID/路径/ordinary 模式/Codex 成员关系必须回读。
3. acb_request_submit {eventKey,projectId,title,requirement}，飞书用真实事件 ID。需求不是工程 Prompt；队列自动选登记会话、生成、核验、投递、保存结果并回 GPT。
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
| 工程 UNCERTAIN | reconcile_execution 核对原 Prompt/起始时间/目标/final_answer，不重跑 |
| 反馈 SENDING/UNCERTAIN | reconcile_feedback，不重发结果 |
| project UNCERTAIN | 完整原资源才可 reconcile，缺 ID 则报告，不能补造 |
| DB / SCHEMA | 一致性备份、副本验证、显式迁移 |
| TIMEOUT / 失联 | 保留未知结果并按阈值报告，不以失联推断成功或确定退出 |

恢复应用先报告、确认退出、取得事件批准、核对原映射；不可结束仍运行的应用。页面不稳定/账户挑战须如实报告，不能保证零风控。

## 性能、生命周期与验证

每个 Bridge 进程/Windows 用户会话串行复用一个自有 PowerShell worker，JSON 行和原 JSON-RPC ID 关联请求。新 pipe handle 均核对签名宿主 PID/启动时间；签名/同用户检查只对同一存活进程缓存。超时只结束自有 worker，不重放请求、不动桌面应用。runMcp 在在途操作结束后关闭 worker；直接底层宿主退出时调用 closeNativeReadWorker() 或 NativeReadWorker.close()。

2026-10-13 少量同机只读采样：原两次启动耗时 4583/1628ms，复用冷/热为 3828/219ms，启动数 2→1，59 字节摘要一致、前台未变。只测一次冷/热组合，不是 SLA 或实际 Token Usage；没有遥测服务。App Server 在单次执行内已复用连接读事件和结果，不引入进程池。UIA 操作算法未改，不增加未经批准的写测试。

    npm run typecheck
    npm run build
    npm test
    npm run test:desktop
    npm run check
    npm audit --audit-level=high
    npm run test:install

npm test 已发现全部 Node 测试，包含 e2e/workflow；CI 不再重复同一 e2e 集合。test:e2e 仍可定向执行。干净安装只验证依赖/构建/编译入口/Mock 演练，不重跑源码矩阵。Mock 通过不等于桌面、Hermes/飞书验收。

只读诊断保留 native:check、codex:check、codex:target-check；飞书发送测试需明确批准。删除旧创建目录研究、实验 App Server 项目探针、第二 Profile 原型。保留当前 CDP 读取及有调用依赖的兼容模块。

结构保留职责层次：mcp-server/mcp 为协议；background/project-provisioner/prompts/tasks/topology/outbox 为业务；native-readonly/windows-native-host 为 IPC/UIA；codex-app-server/ordinary-chat/hermes-gateway/notification-delivery 为适配器。没有为美观搬迁整个项目。

实际源码参考：[WPS 常驻 JSON 行宿主](https://github.com/sueccku/dsh-plugin-wps-office-next/blob/bc69b96fca0c30e63680a151ebf96a093404d2da/host/wps-com-host.ps1)、[mcp-windows 局部查询](https://github.com/sbroenne/mcp-windows/blob/655b9fc92d03ad52a270067c6844ea1231c90559/src/Sbroenne.WindowsMcp/Automation/Tools/UIFindTool.cs)、[FlaUI 批量动作](https://github.com/shanselman/FlaUI-MCP/blob/da1d2a24eae6ccdfbbd40a1375b6617536552351/src/FlaUI.Mcp/Tools/BatchTool.cs)、[winapp Pattern 操作](https://github.com/microsoft/winappCli/blob/96f487615872f7c0e4032e0361856e3109a477e3/src/winapp-CLI/WinApp.Cli/Commands/UiInvokeCommand.cs)、[mcp-compressor 门面转换](https://github.com/atlassian-labs/mcp-compressor/blob/86dc1dfd414d68914d2fbb7b2421420c3f74bbea/python/mcp-compressor/mcp_compressor/transforms.py)。只借鉴原则，不复制/执行源码或引入框架。当前 19 个工具没有证据需要动态 Catalog。

规则见 [PROJECT_RULES](docs/PROJECT_RULES.md)，独立报告用 [验收模板](docs/ACCEPTANCE_TEMPLATE.md)。保留 [MIT LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。报告存项目 docs，私有历史不发布，不再写个人文件夹。
