# Windows 桌面原生读取接口

## 结论

新增 `NativeDesktopReadClient`、`checkNativeDesktop` 和只读诊断入口 `agent-control-bridge-native-check`。这是本机桌面管道的兼容性实现，不是 OpenAI 承诺稳定的公开会话 API，不提供任意 RPC 代理或消息发送。当前后台 MCP 不自动安装它为生产生成宿主。

2026-10-11 的本机验证表明：旧公开请求省略 `callerSource` 时返回 `-32602 / Invalid tool request`；在已有 Codex 任务上下文中补齐 `callerSource: "codex"` 后，目录、会话列表和指定会话读取成功。指定 GPT 对话的 ID、标题、ChatGPT backing kind 核对成功；实际普通聊天模式、模型/思考强度仍未取得完整证据。GPT 与 Codex workspace 的固定关联由桥维护；普通 GPT 不需要属于原生 Codex 项目。开发者测试不是独立验收。

后续本机目录核对仍为 53 个原生工具，包含 `create_thread`、`set_thread_title` 和 `list_projects`，未包含 workspace 创建工具。`create_thread.target` 支持已有 project、projectless 与 chatgptWorkCloud，未提供普通 GPT 创建目标。目录存在重命名能力不能代替对自有普通 GPT 测试会话的实际验证；当前只读客户端不调用这些写工具。目录保留新广告的 schema 便于后续检查，传输请求白名单没有放宽。

2026-10-12 交接后的再次核对：本机签名宿主版本仍为 `155.0.8059.40`，目录仍为 53 工具。新增创建能力诊断核对 schema 指纹和已审核的目标种类，允许固定的 `list_projects({})` 只读调用。本项目的既有桌面原生 ID、local host、精确名称和目录均读回匹配；这不证明创建或 Codex 对话归属。当前交接对话的目录与项目相同，但桌面 `list_threads` 的 `projectId` 为空，前一对话则具有原生项目 ID；不以 cwd 推断成员关系。未改变这些对话的归属。

`checkNativeProvisioningCapabilities` 只返回诊断证据与 `BLOCKED`，不能充当创建宿主。未来新增工具、未知目标、引用 schema 需要审核；schema 广告、Work 目标、改名能力和实验 App Server 项目均不能将普通 GPT 或原生 workspace 创建标为已验证。目录不存在某能力不是该产品永久不支持的证明。

继续核对已安装的 `26.1007.2314.0` 应用静态代码后，发现桌面确有 `projects.createLocal`，内部支持 `setActive: false`；MCP 包装工具名为 `create_project`，其目录注册受 `projectToolsEnabled` 控制。本机实际目录没有广告该工具；包装实现也未传入 `setActive`，不能据内部参数推断外部工具支持后台创建。后续真实调用修正了“目录未广告即不可调用”的推断，见下文。

同一签名宿主的管道还注册了 `taskWorkspace/prepare`、`taskProject/list`、`taskProject/assign`，它们要求选中的桌面 executor environment。`prepare` 只分配目录并检查已有 projectId，不创建桌面项目。桌面 App Server 后端的 `storeProject` 更新映射与既有项目元数据，没有把未知外部项目写入桌面项目缓存；因此单独 `project/create` 仍不能充当原生 workspace 创建器。

普通 Chat 的实际创建函数为 `createChatGptMcpAppThread`；扩展 `ui/message` 的新会话分支按宿主 recipient 的 conversationOrigin 选择落点，内部取得的 server thread ID 没有通过该扩展返回（结果为 `{}`）。这证明存在内部实现，尚未证明桥能后台选择普通模式并获取精确 ID。没有执行安装包代码、注入脚本、修改桌面状态或读取凭据；本轮仅记录六个相关静态文件的哈希与上述调用关系。

## PR #2 原生调用验证（2026-10-12）

同一 OpenAI 签名桌面宿主、同用户及同系统会话下，向静态代码中已确认的 `create_project` 处理器发送空参数，收到 `create_project received invalid arguments.`。随后固定 `list_hosts({})` 调用成功，返回 local host 及当前已批准的 workspace root。两次调用均未观察到前台窗口改变，没有创建资源或运行模型。开发验证仅证明处理器及只读目录调用可达，不能证明有效创建成功。

`projectToolsEnabled` 在本版本控制 `list_hosts` / `create_project` 的目录注册；执行器保留了创建分支，未发现该分支再次检查同一门控。没有修改功能开关，也没有把这个版本观察当成稳定公开 API。

有效创建仍存在具体静默阻断：`projects.createLocal` 调用精确路径的 folder consent，未知信任的新目录会进入 `BrowserWindow.show()` 和桌面确认回调；父目录的批准不能替代新目录确认。该调用没有传入自动新建目录的例外参数，MCP 包装也没有传入 `setActive: false`。选中项目变化是否影响编辑焦点尚未实测，不能承诺静默。托管 worktree 的创建和附件登记没有补齐这些条件；没有发出可能打开确认窗口的有效创建请求。

AppHost 的项目服务绑定 Electron WebContents 的 MessagePort；现有进程间 coordinator 注册的是线程 owner/follower 操作，没有发现项目或普通 Chat 创建请求。`ui/message` 在 MCP App iframe 宿主中处理，当前原生工具管道不提供该操作；新会话模式依赖已有 recipient，回执仍没有 server thread ID。`send: false` 只建立草稿。普通 GPT 的进程外创建入口、精确 ID 和 ordinary mode 回读仍未验证，因此生产 `ProjectHost` 未安装，不提供占位创建器或任意 RPC 代理。

本次另从 PR 的 Windows CI 日志定位到原有无副作用 worker 测试的超时：PowerShell 启动及 stdin 读取完成，阻塞在 `ConvertFrom-Json`。worker 现从 `$PSHOME` 的固定 OS 路径显式加载 Utility 模块，避免依赖自动模块查找；结果以该版本 CI 为准。增加预算与 OS 元数据的实验未解决问题，OS 环境实验已撤回。测试保留脱敏输出及阶段标记，不再丢弃 stderr，不改变脚本策略。生产管道预算、环境、身份校验和固定只读请求均未变化。此前通过的测试无需据此推断原生创建可用。

## 使用

在 Windows 构建后运行：

```powershell
node dist/native-interface.js --config config.example.json --carrier <EXISTING_CODEX_TASK_ID> --conversation <EXISTING_GPT_ID> --title <EXPECTED_TITLE>
```

安装包入口为 `agent-control-bridge-native-check`，源码目录可以运行 `npm run native:check --` 并追加同样参数。不提供会话目标时仅检查当前 Codex carrier 和最小会话列表。carrier 是已存在的本机 Codex 对话；本工具不会运行模型创建 carrier。目标参数只决定只读诊断范围，不授予 controller/reviewer 权限。

创建能力诊断使用互斥模式：

```powershell
node dist/native-interface.js --config config.example.json --carrier <EXISTING_CODEX_TASK_ID> --provisioning-capabilities --project <EXPECTED_NATIVE_PROJECT_ID> --workspace <ABSOLUTE_WINDOWS_PATH> --name <EXACT_PROJECT_NAME>
```

`project/workspace/name` 可一起省略，省略时只读目录与 carrier。不接受部分项目期望参数或同时使用 conversation/title。最多三个 RPC；同一宿主实例、绝对预算和隐藏进程限制保留。项目结果仅输出匹配布尔值，不输出项目 ID、名称、路径或其他项目列表。`ok: true` 表示诊断读取成功，`state: BLOCKED` 表示创建链路仍缺证。

Hermes 可以通过 `acb_native_target_check({projectId, conversationId})` 检查自己项目登记的 Codex carrier 和配对 GPT。GPT ID/预期标题由受保护的登记表读取，不能从工具参数覆盖。必须先通过 controller 和项目权限检查；未知目标在打开管道前拒绝。Windows MCP 宿主使用默认读取器，WSL 嵌入宿主可以通过可信 `nativeInspector` 函数转发到 Windows 读取进程，不能用环境变量或 JSON 安装宿主。

预算统一来自配置的 `nativeInterface`：`timeoutMs` 为整次诊断的绝对时间预算，`maxFrameBytes` 为单帧上限，`maxCandidates` 为枚举上限。默认值见配置样例；不会循环重试。诊断最多四个 RPC，在任一步失败时结束，并输出固定错误代码或固定失败阶段。

WSL Hermes 的 Windows 管道操作必须放在 Windows Node 宿主中。Linux/Docker Node 不能直接使用此原生接口；不要据此启动新的飞书事件消费者、修改现有 Bot 凭据配置或创建新的浏览器/profile。

## 传输与输出

- Node 生成 JSON 请求；隐藏的 PowerShell 辅助进程对同一请求严格校验后，保留 Node 的原始 JSON 字节发送。
- 辅助进程不使用执行策略覆盖、宿主重启或登录操作。其唯一 RPC 白名单为 `tools/list`、`list_projects({})`、`list_threads(limit=1)`、`read_thread(turnLimit=1, includeOutputs=false, maxOutputCharsPerItem=0)`。项目读取拒绝额外参数，仍不提供写工具或任意代理。
- `tools/list` 使用 `threadStartKind: "all"`；`tools/call` 使用 `namespace: "codex_app"`、`tool`、`arguments`、已有 carrier `threadId`、独立 `callId/turnId` 及 `callerSource: "codex"`。这是传输来源声明，不是业务授权，也不能证明模型来源。
- 枚举有上限；多宿主进程歧义拒绝。宿主要求同 Windows 用户、同会话、Codex 产品和有效 OpenAI 组织签名。实际发送使用的连接再次核对 server PID 和进程启动时间；后续 RPC 绑定同一进程实例，拒绝 PID 重用或宿主变化。
- 4 字节小端长度前缀、严格 UTF-8、帧上限、响应 ID、结果类型和单回合窗口均核验。异常、超时、取消只终止自己创建的辅助进程；不停止桌面应用，不重放请求。
- 对话正文、标题、路径、账户详情、宿主 PID、原始错误不进入诊断输出。输出仅给出是否匹配、已观察到的字段名及明确未验证的能力。前台窗口检查是本次读操作的观测证据，不是未来写操作的保证。

## 与生产门禁的关系

返回 `ok: true` 只表示读取诊断通过。`ordinaryChatVerified`、`actualGenerationParametersVerified`、`projectMappingVerified`、`executionAuthorized`、`fullWorkflowReady` 仍为 false；即使返回对象存在配置 model/effort 字段，也不转换为实际生成证明。

受信任 `ProjectHost.inspect` 现在必须提供 `workspaceSurface: 'native-desktop'`；隔离 App Server、unknown 或缺失值在创建目录及外部资源前阻塞。`verifyBundle` 必须独立读回桌面原生登记，并返回 `workspaceSurface: 'native-desktop'` 及与 `appProjectId` 相等的 `codexNativeProjectId`，创建和 reconcile 共用此校验。此为 Unreleased 宿主契约的收紧；既有嵌入适配器需补证，不能只加固定字符串使其通过。返回文本、配置或环境变量不安装可信宿主，也不授予执行或验收权限。

下一阶段需要合法宿主提供专用普通 GPT 测试会话、真正后台的一次发送/确定回合回执、完整最终回复、实际模型/思考强度，以及创建/命名/核验原生 workspace 与会话的能力。普通 GPT 的宿主读取证明须包含精确 ID、ordinary-chat 模式与项目同名标题；与 Codex workspace 的关联由受保护且不可变的登记表约束，不能以伪造共同原生 projectId 替代。缺少证据时保留 BLOCKED，不把原始需求或 Mock 送入真实 Codex。

官方插件扩展 `ui/message` 的公开 schema 只列 `active` / `new` 目标；需要已连接的 MCP App UI 与宿主能力协商。该文档不能证明指定 ID 后台唤醒、失去 UI 后继续工作、精确命名、普通 GPT 到 workspace 映射或实际生成模型证明。MCP Events 当前文档列 Work/Cloud/dots，不能替代用户要求的桌面普通聊天。

## Bits & Bolts Remote 安装后核对

2026-10-12 用户安装了 Bits & Bolts Remote，当前缓存版本为 `1.0.23`，连接开放 12 个 CAD / 设置示例工具。只读调用 `cad.context({})` 返回 `threadId: null`、`hasTrustedResourcePath: false`、`localFilesystem: false`；消息为当前宿主未提供 thread ID。此结果只适用于本次 Codex 调用，不能推断普通 GPT 调用也会缺少 ID，也不能把插件已连接当作创建能力证明。

安装后再次执行原生创建能力诊断：同用户签名宿主仍为 `155.0.8059.40`，前台窗口未改变，原生目录仍为 53 个工具。`create_thread` 仍只有已有 project、projectless、chatgptWorkCloud 目标，没有开放原生 workspace 或普通 GPT 创建入口。

官方文档所列 TypeScript SDK `@openai/mcp-extensions@0.1.0` 的公开包已只读核对。`OpenAIExtensions.message` 需要 MCP App 的宿主在连接时广告 `openai/message`；其选项严格限定 `target: 'active' | 'new'` 与可选 `send: true`，不含指定会话 ID、标题、普通模式或后台运行参数。这说明当前公开 SDK 的入口不足以实现本项目的完整后台创建契约，不代表未来 SDK 或所有宿主都不支持这些能力。当前未发现该插件向外部桥提供常驻的 `ui/message` 调用端点。

本轮没有打开示例 UI、发送消息、创建真实会话、修改插件配置或添加生产代码。示例公开 MCP 端点的独立只读连接在 10 秒内超时，未取得其 UI 资源；这个网络结果不否定已经成功的宿主插件连接。现有插件仅用于能力核对，两个创建器和真实 workflow 仍未完成。继续开发需要可实际调用的原生宿主创建入口及普通 GPT 身份回执；当前不添加空实现或以匿名 `openai/session` 代替真实会话 ID。

## 后台宿主入口续查

2026-10-12 继续检查了既有服务复用、Windows 注册入口、项目创建分支及插件协议。官方 CLI 的 `app-server proxy --sock` 能连接既有控制套接字；本机只读 `app-server daemon version` 返回连接失败（退出码 1、Windows 错误 10050）。安装包 `application-network-startup` 的本地 daemon 分支明确要求非 Windows；当前 Windows 路径使用 `StdioConnection` 启动子进程，以 stdin/stdout 通信。因此不能把另起 daemon 或 App Server 当作已连接桌面的后台入口。未启动、停止或重启任何服务。公开实现见 [stdio proxy](https://github.com/openai/codex/blob/72f999edc7848961b99c4b98bf1e62d12fa35798/codex-rs/stdio-to-uds/src/lib.rs)。

Windows Appx 清单未注册 `windows.appService`；已有协议、执行别名和 sandbox service 不提供这两个创建回执。安装包的 `create_thread` projectless 分支明确设置 `workspaceKind: 'projectless'`，项目登记参数为 null，不会隐式补建 saved-project。官方仓库当前 Windows `codex app PATH` 已通过 `codex://threads/new?path=...` 打开目录，不能继续概括为所有版本都只打印手动说明；该路径仍是 UI 打开入口，没有本项目要求的后台成套创建回执，本轮未调用。见 [Windows launcher](https://github.com/openai/codex/blob/72f999edc7848961b99c4b98bf1e62d12fa35798/codex-rs/cli/src/desktop_app/windows.rs)。

插件协议另有版本差异：上节核对的已发布 SDK `0.1.0` 限制 `send: true`；官方仓库 `0d606217705e0e71eb21fff009619b67b80611dc` 的 [message.ts](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/typescript/src/app/message.ts) 与规范现已允许 `send: boolean`。安装包也处理 `send: false`，行为是追加或打开可编辑草稿；`ui/message` 结果仍为 `{}`。新源码仍没有会话标题、精确 ID、普通模式或常驻后台调用参数。文本块的 title 是输入内容标签，不能当作聊天标题。

重新搜索插件目录与公开实现，未确认能同时提供两项原生创建能力的插件；目录搜索并非穷尽证明。Conversation MCP 提供既有对话操作，ChatGPT Native Bridge 让 ChatGPT 调用本地工具。Explodex 依赖 CDP 与 renderer 注入，不符合已保留的约束，未安装或运行。上游 [#52821](https://github.com/openai/codex/issues/52821) 也报告缺少原生项目创建工具，但它是其他环境的用户报告，不代替本机证据。

可保留全部约束的实现方向仍是由可信桌面宿主开放两个专用操作：调用原生项目服务并明确禁止切换当前项目，返回可由 `list_projects` 核对的 ID；创建普通 Chat，返回精确会话 ID、模式与同名标题。已有内部函数是宿主侧的实现基础，不是桥可以直接调用的公开接口。当前未找到受支持的外部入口，两个创建器和完整 workflow 仍未完成；没有增加占位创建器、任意 RPC 代理或额外生产校验逻辑，也未重复已有测试。新增静态文件哈希和只读检查证据保存在本次 `creation-research-20261012` 目录。

## 资料

- [OpenAI 插件扩展](https://developers.openai.com/plugins/build/extensions)及其[消息扩展规范](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#uimessage-extensions)。
- [OpenAI MCP Events 支持范围](https://developers.openai.com/plugins/build/mcp-events)。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：本项目 Codex 侧执行使用它，但独立 App Server 的可读历史不证明附着于桌面正在运行的线程。
- [openai/codex #48314](https://github.com/openai/codex/issues/48314)：报告者提供了 `callerSource` 缺失线索；本项目仅采用请求字段线索，未采用其中的应用终止、缓存搬移或私有代码修补操作。
- [Conversation MCP](https://github.com/kajmahal/chatgpt-conversations-mcp/tree/4c2640d88cc95df1fa3d4d1c60f433d452c97351)：公开参考实现；未安装、运行或复制其源码到本项目。

当前实现没有零风控保证，也没有读写绕过或凭据导出机制。
