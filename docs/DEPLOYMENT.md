# 部署、配置与桌面恢复

本文提供具体环境样例；通用规则见 [项目规范](PROJECT_RULES.md)。样例不是本机真实凭据、实际安装位置或已完成部署的证明。

## 配置与支持范围

Node >=24.19.0 使用内置 node:sqlite；核心 CLI 面向 Windows/Linux。Python >=3.10 用于 Windows 桌面工具，CDP WebSocket 依赖通过 `python -m pip install -r tools/desktop/requirements.txt` 显式安装。核心 Demo 无需 Python WebSocket、桌面应用、账号或付费模型。

复制 [config.example.json](../config.example.json) 为 `.bridge.config.json`，按实际环境设置路径。Node 配置优先级是 CLI > ACB_* 环境变量 > 本地文件 > 默认，相对配置路径以文件目录为准；Python 桌面工具共享该文件的 desktop 区段及 `ACB_CONFIG`、`ACB_CDP_URL`，默认从项目根目录找配置。所有输入均需校验。

样例默认：数据库 `./data/bridge.db`；Watcher `60000ms`、检测预算 `10000ms`；持续阻塞报告阈值 `600000ms`，`ACB_BLOCKED_REPORT_MS` 可覆盖。阻塞检查在下轮轮询/本地事件执行，调度延迟另计；通知写台账/stdout，Hermes 消息适配器须实际发送用户消息，不宣称单靠本地记录满足用户送达时限。

模型请求默认 `gpt-6` / `high`。当前只验证配置生效和 Mock 能力，真实模型/强度需可信适配器独立证明。应用界面或 Agent 自报不构成证明；未知能力保持 REVIEW_REQUIRED，生产自动投递拒绝。

## 身份与安全模型

默认 CLI 是当前 OS 主体、固定 local-cli instance、pi 执行者，无 reviewer。生产部署由受信任维护者按 [caller-policy.example.json](../config/caller-policy.example.json) 配置固定 `config/caller-policy.json`；示例没有真实主体，也不会自动启用。Windows 使用实际 SID，Unix 使用 uid 主体。不同 reviewer/executor 必须使用不同身份；保护策略、代码和专用数据库目录，拒绝普通 Users/Authenticated Users 写入。

不要把 reviewer 授权复制给执行者，不用 `--by user`、角色文本、环境变量或业务 JSON 授权。调用上下文和桌面批准是宿主内存句柄；只有受信任宿主可创建。能直接改宿主代码或 DB 的同 OS 代码不受进程沙箱隔离，本项目尚无多租户 IPC 认证服务。

新库 `node dist/cli.js init` 自动建 Schema v4。旧库需先用 SQLite 在线备份 API 或可靠一致快照备份；不要只拷贝正在写入的主 DB 而忽略 WAL。先在副本执行 `node dist/cli.js migrate --db COPY.sqlite`，核查数据/外键和回滚方案，再由维护者决定业务库升级。本次开发不升级真实台账。

## 项目会话登记

由受保护的 Hermes controller OS 身份登记真实 ID；独立 reviewer 权限单独授予：

```sh
node dist/cli.js project-register demo-project --name "Demo" --root "."
node dist/cli.js mapping-register demo-project --workspace "." --gpt GPT_CONVERSATION_ID --gpt-name "Demo" --codex CODEX_CONVERSATION_ID
node dist/cli.js mapping-show demo-project
```

这是登记，不创建外部应用或对话。一个项目一个 workspace/一个同名 GPT 对话/N 个 workspace 内 Codex 对话。例如项目名 `Agent Control Bridge` 对应 GPT 对话名也为 `Agent Control Bridge`。实际名称与归属由适配器在生成前、来源回执及投递目标再次核对，不从登记文本推断界面已重命名。

多个项目分别登记并设置任务优先级；控制者事先分配应用会话、并发和资源预算。0.2.0 后台队列按优先级串行处理，项目创建和执行共用并发约束；未知外部结果会阻塞调度。不能以混用另一个项目会话绕过资源不足。新入口与尚未完成的普通 GPT 宿主能力见 [后台 MCP 部署](BACKGROUND_MCP.md)。

## 桌面工具与受控接口

外部 Agent 应用需由用户安装并登录。默认 desktop.enabled=false，前台与物理输入关闭。读取可见消息可能包含私人业务内容，须获相应访问范围授权；不读取 Cookie/Profile/登录库。发送实现保留原算法但可能改变编辑焦点，只能由可信宿主单次授权调用；裸 CLI 发送默认阻塞。完整工具说明见 [desktop README](../tools/desktop/README.md)。

配置样例 CDP 是 `http://127.0.0.1:9222`，可配置端口；仅允许回环 HTTP/WS，不跟随重定向至外部地址。恢复 origin 必须为与端点一致的受限回环 origin（如 `http://127.0.0.1:9222`），配置校验拒绝通配符 `*`。不要把调试端点暴露到公网，不要导出浏览器会话秘密。

## 部署拓扑（Windows 原生 vs WSL）

支持两种生产部署拓扑，CDP 访问边界不同：

- **Windows 原生 Node**：Node 与 Windows Python Worker 在同一 Windows 主机。Node 经受控传输层调用 Worker，Worker 访问 Windows 回环 CDP（`127.0.0.1:9222`）。
- **WSL Node + Windows Worker**：Node 在 WSL，Windows 桌面工具（Python + CDP 访问）在 Windows 侧。Node 不得假定 WSL 回环等于 Windows 回环；CDP 必须由 Windows 侧 Worker 访问。

两种拓扑下，Windows CDP 一律由 Windows 侧 Python Worker 访问，Node 不直接连接 CDP。健康检查、连接重试与 Worker 生命周期由受控传输层管理；Worker 断开时不得继续发送任务。

## GPT 闪退与恢复部署流程

1. 可信宿主检查进程和调试接口，区分确定退出、仍运行、状态未知。单独 CDP 不可达不能证明闪退。
2. 先向用户报备事件与已知证据；为此事件取得明确、单次恢复授权。不得结束仍运行的应用，也不能切换前台或模拟物理输入。
3. 宿主使用已配置安装入口恢复，参数由配置端点及受限 origin 生成。例如 `--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`；不能把参数写死到业务模块。
4. 在 **Windows 侧 Python** 检查 CDP：`python tools/desktop/recovery.py --check-cdp`。WSL 的回环网络可能无法到达 Windows 回环；不要用 WSL curl 失败推断 Windows 应用已退出。
5. 校验接口、实际模型能力、登记的同名 GPT 会话和 Codex workspace 映射。接口可达不证明登录、模型、会话恢复或任务完成。
6. 恢复来源记录和不确定投递状态，核实后继续；来源或目标错配保持阻塞，不能重复发送已可能投递的 Prompt。

`recovery.py` 提供宿主注入 probe/notify/restart/restore_mapping 的事件授权流程；默认 CLI 仅诊断，不启动应用。实际 MSIX 安装是否接受这些参数、无焦点影响的启动方式及真实模型证明 **尚未验证**，不报告已恢复。本次没有重启任何真实 Agent。

## 飞书连通性诊断（源码目录）

`npm run feishu:check -- --config config.example.json` 默认只检查应用认证及 Bot 信息。诊断读取统一配置的 `feishu.apiOrigin` 和 `feishu.timeoutMs`，只允许官方 HTTPS 端点，不打开桌面应用、不启动 Hermes 或真实 Agent，也不打开业务数据库。

凭据由可信调用方通过 stdin 提供一个含 `app_id`、`app_secret` 的 JSON 对象；不得写入参数、源码、配置或日志。交互输入关闭回显，兼容 Windows 的 CR/LF/CRLF。输出仅包含检查状态、HTTP/API 状态码及脱敏的 Bot 信息，省略访问令牌及原始响应。

向用户发送测试消息必须有明确授权，并同时提供 `--send-test-message --test-recipient-open-id <AUTHORIZED_OPEN_ID>`。每次调用仅发起一次消息发送请求，携带去重编号；如果返回超时或发送状态未知，不得重新调用来猜测结果。成功的 message receipt 只证明飞书接收了发送请求，不能证明用户已读、入站事件订阅可用或 GPT/Codex 工作流完成。

## 后台接入诊断（源码目录）

新增 Windows 原生只读诊断 `node dist/native-interface.js --config config.example.json --carrier <EXISTING_CODEX_TASK_ID> --conversation <EXISTING_GPT_ID> --title <EXPECTED_TITLE>`，安装包入口为 `agent-control-bridge-native-check`。预算读取 `nativeInterface`，不访问业务库、不生成消息、不启动模型、不读取凭据。它与旧 CDP 工具分开；WSL Hermes 需要 Windows Node 宿主，不能直接从 Linux/Docker 连接 Windows 管道。成功读取仍不授权生产 Prompt 生成或执行。协议兼容性、宿主身份校验及待补证能力见 [原生桌面读取接口](NATIVE_DESKTOP.md)。

同一入口的 `--provisioning-capabilities` 模式可附带成组的 `--project <NATIVE_ID> --workspace <ABSOLUTE_WINDOWS_PATH> --name <EXACT_NAME>`，核对当前目录 schema 与既有桌面原生登记。只读成功仍输出创建链路 BLOCKED；schema 广告不授予创建权限。ProjectHost 嵌入契约收紧后的原生证据要求见上述原生接口文档，缺证不可仅用实验 App Server 回执补齐。

构建后可运行 `node dist/codex-interface.js --config config.example.json --conversation <REGISTERED_THREAD_ID> --workspace <EXPECTED_WORKSPACE> --project <EXPECTED_NATIVE_PROJECT_ID>`，可执行程序从配置读取，或由操作者显式给出 `--executable`。安装包提供 `agent-control-bridge-codex-check`。它只读 thread/read，省略正文与私有诊断，不 resume 或调用模型；原生项目字段为空输出 UNAVAILABLE，不能以预期值替代真实证据。控制者的 MCP `acb_codex_target_check` 额外限定登记项目和会话。执行适配器及宿主需求见 [Codex 后台接口](CODEX_APP_SERVER.md)。

`npm run codex:check -- --config config.example.json --executable <CODEX_EXECUTABLE>` 调用官方 App Server 的只读初始化、已有账户检查和模型列表。可执行文件与预算来自参数/统一配置；不打开登录页面、不创建会话、不调用模型、不输出账户邮箱或凭据。已有账户配置不证明普通 GPT 对话能力或真实工程任务可执行。

源码目录新增 `npm run codex:provision-check -- --config config.example.json --executable <CODEX_EXECUTABLE> --name-dormant-threads`，只在新临时 Codex home 创建无消息会话、核对模型/强度和持久读取；不会加入桌面原生 workspace 或启动执行。真实验证及保存设置/列表/清理的遗留见 [Codex 后台接口](CODEX_APP_SERVER.md)。身份建档可以先于 GPT 实际模型证据；这不改变生产生成和自动投递的拒绝规则。

`npm run codex:project-check -- --config config.example.json --executable <CODEX_EXECUTABLE>` 使用当前 CLI 的实验项目协议，在新隔离 home 验证项目创建、幂等、Codex 原生协议归属、精确中文改名和重连读取。可加 `--identity-only` 跳过已知无消息列表问题，结果明确为 PARTIAL。项目 API 的 SQLite 登记不证明桌面 saved-project 登记；不能把测试结果或实验项目 ID 直接灌入生产映射。该诊断关闭自身插件/远程插件/应用功能，避免默认同步留下锁，不改真实配置。宿主 `acb_project_reconcile` 仅核验已记录的完整 UNCERTAIN 资源，不创建替代对话；缺失 ID 必须保持待核实。

`node scripts/feishu-notification-check.mjs --config config.example.json --send-test-message --test-recipient-open-id <AUTHORIZED_OPEN_ID>` 在用户明确授权后，通过新通知发送器发出一条测试消息。凭据仍仅从 stdin 输入；台账位于独立测试目录并在退出时清理。它验证发送回执与台账确认，不证明真实消息入站、Hermes 调度或 GPT/Codex 执行。

生产通知发送器的总请求预算使用 `feishu.timeoutMs`，通知租约使用 `background.notificationLeaseMs`，后者须更大。构建后可用 Hermes 自带的 Python/MCP SDK 和满足版本要求的 Node 运行 `tools/hermes/mcp_probe.py`；不要启动竞争的飞书消费者、重启现有 gateway 或修改包含凭据的配置来代替测试。

## 故障分类

CLI 输出可诊断的 code 与非零退出码，不输出原始认证/SQL异常。INPUT/CONFIG 检查样例字段；AUTH/OWNER 检查宿主身份；PROVENANCE/UNSUPPORTED 检查来源及实际能力；CONFLICT 先查最新版本；DB/SCHEMA 先备份、副本演练；TIMEOUT 检查检测是否合作取消。取消和恢复仅改台账，不证明外部执行已停止。

业务保留周期、备份 RPO/RTO 和恢复演练由部署者按实际数据要求确定；当前不自动清理业务记录。只清理有归属证据的隔离测试残留。

Unix 默认数据权限为目录 0700/文件 0600，因此当前 Linux 范围是单用户核心 CLI 与隔离 Demo，不提供跨 uid 的共享可写验收 CLI。Windows 可按受保护 SID 策略部署独立主体；跨用户宿主服务的认证/IPC 和 Unix ACL 部署仍须另行实现，不能为运行验收而放宽业务库给所有用户。
