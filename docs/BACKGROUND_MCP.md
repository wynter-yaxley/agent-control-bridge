# 后台 MCP 接入与开发边界

本页对应 0.2.0 开发版本，待独立验收。项目规则和来源要求仍适用。

## 启动与身份

安装依赖、构建后，由 Hermes 的 MCP 客户端启动隐藏后台进程：

```text
node <项目绝对目录>/dist/mcp.js --config <配置绝对路径>
```

`npm run mcp -- --help` 可查看帮助。实际连接使用 stdio；stdout 只承载 MCP，错误代码写入 stderr。MCP 进程不启动浏览器、不建立 profile、不操作剪贴板，也不读取认证秘密。Hermes 配置格式取决于其版本，本项目不假定 YAML 字段。

首次使用初始化新的专用库；既有库须先由操作员备份，再显式 migrate。直接启动 MCP 不自动升级旧库。本轮开发没有迁移业务数据库。

进程身份来自 OS principal 和受保护的 config/caller-policy.json。策略可以增加 controller: true，reviewer: false，用于 Hermes 调度。旧 Hermes reviewer 策略保留控制兼容性，显式 controller: false 可撤销。独立验收必须来自与执行者不同的可信 principal。默认 CLI 身份没有 Hermes 控制权。

stdio 连接代表一个被授权的本地主体，不自动认证飞书最终用户。Hermes 仍负责用户和项目授权；多租户需由可信宿主为连接分配独立上下文。本版本没有公共 HTTP 端点。

## 工具

| 工具 | 用途 |
|---|---|
| acb_capabilities | 列出宿主缺口；不把接口对象存在当作完整验收通过 |
| acb_codex_target_check | 只读核对控制者已登记的 Codex 会话与实际目录；不授权执行 |
| acb_native_target_check | Windows 原生只读核对已登记的 Codex/GPT 配对；不接受任意 GPT 目标或 RPC |
| acb_project_prepare / acb_project_get | 成套创建并查询项目操作；未接宿主则 BLOCKED |
| acb_project_reconcile | 只读核对已记录的完整 UNCERTAIN 资源，成功后登记；不接受替代 ID，不重新创建 |
| acb_request_submit / acb_request_get | 需求入队、消息去重和实际状态查询 |
| acb_request_retry | 明确重试无未知外部结果的 BLOCKED 请求 |
| acb_notifications_pull / acb_notifications_ack | 领取通知，以真实外部消息编号确认送达 |
| acb_notifications_status | 查询通知数量和禁止自动重发的发送记录 |
| acb_review_submit | 独立授权验收，执行者不能自验 |

eventKey 使用飞书原消息事件编号。同编号、同内容返回原记录，内容改变会拒绝。没有 Prompt 导入、来源自报、任意角色授权或浏览器控制工具。

## 后台行为

后台按统一配置周期检查，入队会触发检查。第一版并发上限固定为 1，项目创建和任务执行共用限制，任务按优先级及入队时间执行。Registry 隔离一个 GPT 与多个 Codex 会话；当前队列按会话 ID 排序选择该项目一个已登记 Codex 会话，按明确 ID 续用。额外 Codex 对话可由可信宿主登记，尚无自动增建 MCP 工具。

执行前先固定可信 Prompt、领取 task attempt 和 holder，再启动外部任务。事件记录类型和时间，不将任意模型输出写入诊断日志。完成进入 WAITING_APPROVAL，只有独立验收能进入 SUCCEEDED。

生成或执行超时保留 UNCERTAIN，禁止盲目重试。新进程不会把可能仍运行的旧任务判成失败。外部不确定操作需要独立核验和后续宿主对账能力；没有可通过业务 JSON 伪造“未执行”证据的恢复工具。

通知采用租约和持久回执。Hermes 在飞书发送成功后提交实际 message receipt，未确认则租约过期后可补发。回执丢失可能产生重复外部消息，Hermes 应按稳定通知 ID 去重，不能凭空保证平台恰好发送一次。

可信嵌入宿主还可安装 `HermesGatewayAdapter` 和 `NotificationDispatcher`。前者只接收现有 Hermes 已验证的 Feishu v2 文本事件，由可信路由函数选择用户/群的项目，拒绝 Bot 消息与未经授权的会话；后者使用稳定通知 ID 和官方发送接口，发送前记录状态，取得回执后先持久化再确认。SENDING/UNCERTAIN/REJECTED 记录从自动拉取中排除，须对账，避免租约过期触发重复发送。两个组件均不会另起飞书事件消费者；独立 stdio 入口尚未安装它们。

Hermes MCP 客户端配置样例见 [hermes-mcp.example.yaml](../config/hermes-mcp.example.yaml)，使用当前官方 `mcp_servers` 字段。Node 路径必须是 Hermes 所在环境的 Node >=24.19.0，不能假定系统 PATH 满足版本要求。样例不授权 controller/reviewer，也不安装普通 GPT 宿主。

WSL 可用 [mcp_probe.py](../tools/hermes/mcp_probe.py) 与 Hermes 已安装的 MCP SDK 做隔离互通检查：传入其 Python、`--node` 和 `--repository`，先构建桥。探针只修改自有临时目录、策略及数据库，验证协议、工具、阻塞和去重，结束清理，不修改真实 Hermes 配置或调用真实 Agent。

## 可信宿主接入

可信嵌入代码通过 BackgroundHostBindings 安装对象，不从 MCP JSON 或任意脚本路径加载：

- ordinaryChat：普通 GPT 能力检查、精确会话读取、完整结果、实际模型和思考强度证据。
- projects：原生 workspace、同名普通 GPT、Codex 对话建立，以及独立资源读回。
- executor + executorContext：独立执行者和真实本机 Codex 身份观察。createCodexBackgroundExecutor 复用已登录 CLI，用 stdin 投递和精确 ID 恢复，不提取认证。
- nativeInspector：可选可信 Windows 读取宿主；默认实现仅能在 Windows 运行。只用于 `acb_native_target_check`，不授权 ordinaryChat 或 projects。读取实现见 [原生接口](NATIVE_DESKTOP.md)。

桥的 projectId 与宿主 appProjectId 分开保存。目录存在不代表原生 workspace 已建立；完整 bundle 读回成功才 READY。部分失败保留资源并停止自动重建，不删除未知归属数据。

普通 GPT 的固定绑定由桥维护，无须将普通 GPT 移入原生 Codex 项目。可信宿主可以返回 `source: application-host`、`kind: ordinary-chat`、精确 conversationId 和精确同名 name；桥据此核对不可变的项目/GPT 登记。旧界面导航适配器仍须提供它自己承诺的项目/目录证据。这个分离不削弱 Codex 原生项目归属、来源、完整生成或实际模型/强度门禁。

创建结束后的读取失败可能留下完整身份记录。此时控制者可调用 `acb_project_reconcile({operationId})`，宿主只读取已登记的原始资源；精确核验后登记 READY。缺少任意 ID、异名、Work 对话、跨项目读回、并发或权限不符均拒绝，保持待核实。它不会从调用参数补齐身份，也不会重新创建对话或运行模型。

项目身份创建与模型执行分开检查。可信宿主能创建并独立核对普通 GPT、同名标题、原生 workspace 和 Codex 对话时，身份建档可以先完成，不要求已经取得 GPT 实际模型/强度。`READY` 只表示该套身份已创建和读回；生产生成仍要求完整消息及可信实际模型/强度。缺少后者保持阻塞，不把身份建档当作执行授权。

Registry 在短事务内拒绝复用其他项目的目录、普通 GPT ID、原生 workspace ID 或 Codex ID；GPT 与 Codex ID 也不得交叉使用。项目的 workspace/GPT 配对不可覆盖，可继续登记该项目额外 Codex ID。隔离数据库的重连检查通过；桌面应用中的真实成套创建和归属尚未通过。

## 尚未打通的真实功能

普通 GPT 的合法外部创建、完整原文和真实生成参数读取，以及无焦点影响的宿主绑定尚未完成。独立 MCP 入口没有安装生产宿主：它能运行协议、管理台账、接收已登记项目需求并报告阻塞，不能自动完成真实 GPT→Codex 生产任务。

新的 [Codex 后台接口](CODEX_APP_SERVER.md) 提供可安装执行适配器、只读 CLI/MCP 检查、实验项目 API 隔离诊断、事件回执和中断尝试，仍要求独立宿主的项目归属及会话排他检查；未知中断不能视为停止。`npm run codex:check` 仍可只读检查初始化、账户配置和模型列表。业务取消/恢复 MCP 工具、自动增建 Codex 对话、不完整项目/生成/执行的 UNCERTAIN 对账恢复及 Hermes 持续通知调度仍待宿主接入。Mock 通过不能计为真实功能验证。

SDK v1.32.1 用于 stdio 兼容，能力限于 2025-11-25 协议维护线，不宣称支持 2026-07-28 新功能。升级应以 Hermes 实际客户端兼容性测试为依据。

真实验收须证明新项目成套建立、精确同名、原会话续用、用户同时编辑时无干扰、完整可信生成证据及桌面 workspace 归属。平台零风控不能保证，账户挑战时停止并如实报告。
