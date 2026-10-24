# agent-control-bridge（ACB）

[![CI](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)](#1-用途平台与前置条件)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF)](https://modelcontextprotocol.io/)
[![Hermes Skill](https://img.shields.io/badge/Hermes-skill%20included-F59E0B)](skills/agent-control-bridge/SKILL.md)

[English](README_EN.md)

Agent Control Bridge（ACB）是一个 MCP Server，把 ChatGPT / Codex 桌面应用的能力拆成一组**互相独立的工具**：列出、搜索、读取 Codex 对话；列出、读取 ChatGPT 对话；新建对话；向某个对话发送一条 Prompt 并取回真实回复。每个工具只做一件事，由调用方（Hermes 或任何 MCP 客户端）按需选用和组合，ACB 不规定工作流程。

![架构](docs/images/architecture.svg)

## 1. 平台与前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（ChatGPT 相关工具只支持 Windows） |
| Node.js | 24.19 或更高，安装在 Windows 上 |
| 桌面应用 | ChatGPT / Codex 桌面应用，已登录。新版以「ChatGPT」名称发布（Microsoft Store 包 `OpenAI.Codex`，主程序 `app\ChatGPT.exe`），同一个应用承载 ChatGPT 对话和 Codex 任务；ACB 会自动找到它自带的 `codex.exe` |
| MCP 客户端 | 例如 Hermes（Windows 原生版或 WSL 版均可） |

> Codex 工具只依赖 `codex app-server`，理论上也能在 macOS / Linux 上运行，但没有实测。

## 2. 安装与连接 Hermes

在 Windows 的 PowerShell 中：

```powershell
git clone https://github.com/wynter-yaxley/agent-control-bridge.git
cd agent-control-bridge
npm install          # 安装依赖并自动构建 dist/
npm run check        # 只读自检，并打印适合本机的 Hermes 注册命令
```

`npm run check` 会检查 Codex、ChatGPT 和桌面对话清单是否可用，并输出 `hermes` 字段，其中是**已经填好本机路径**的两组命令。按 Hermes 的安装位置选一组执行：

```bash
# Hermes 在 WSL 中（示例，以 check 输出为准）
hermes mcp add acb --command '/mnt/c/Program Files/nodejs/node.exe' --args 'D:\agent-control-bridge\dist\mcp.js' --allow-foreground-input
cp -r '/mnt/d/agent-control-bridge/skills/agent-control-bridge' ~/.hermes/skills/
```

```powershell
# Hermes 在 Windows 上（示例，以 check 输出为准）
hermes mcp add acb --command "C:\Program Files\nodejs\node.exe" --args "D:\agent-control-bridge\dist\mcp.js" --allow-foreground-input
Copy-Item -Recurse -Force "D:\agent-control-bridge\skills\agent-control-bridge" "$env:LOCALAPPDATA\hermes\skills\"
```

完成后新开一个 Hermes 会话（或执行 `/reload-mcp`），即可使用 `mcp_acb_*` 工具。

- 服务名请保持为 `acb`，工具名会是 `mcp_acb_acb_gpt_send` 这样的形式。
- `--allow-foreground-input` 表示授权 ACB 自动恢复/激活已核验的 ChatGPT 窗口并键入文字（见第 5 节）。不加这个参数时，不激活、不键入；只有 ChatGPT 已在前台且输入框里已有完全相同的草稿时，才会发送。只用读取类工具时不需要这个参数。
- 也可以手动把 [config/hermes-mcp.example.yaml](config/hermes-mcp.example.yaml) 合并进 Hermes 的 `config.yaml`。

### Skill（工具说明与安全规则）

[skills/agent-control-bridge/SKILL.md](skills/agent-control-bridge/SKILL.md) 上一步已复制到 Hermes 的 skills 目录，Hermes 在涉及 ChatGPT / Codex / ACB 的任务中会加载它。它只说明每个工具做什么、何时用读取类工具即可，以及不可削弱的安全规则（不重复发送、不代批审批、失焦即停、失败按错误码处理）；**不规定角色分工或固定流程**，怎么组合由任务决定。

确认已加载：执行 `hermes skills list`，列表中应有 `agent-control-bridge`；在对话中也可以用 `/agent-control-bridge` 主动加载。合并到 main 后，还可以直接安装：`hermes skills install https://raw.githubusercontent.com/wynter-yaxley/agent-control-bridge/main/skills/agent-control-bridge/SKILL.md --yes`。

### 配置（全部可选）

不需要配置文件。如需调整，按以下优先级生效：命令行参数 → 环境变量 → 配置文件（`--config <file>` 或 `ACB_CONFIG`，示例见 [config/config.example.json](config/config.example.json)）→ 自动发现与默认值。

| 配置项 | 命令行 / 环境变量 | 默认值 |
|---|---|---|
| `codexExecutable` | `--codex` / `ACB_CODEX` | Codex 桌面应用自带的最新 `codex.exe`，其次是 PATH 中的 `codex` |
| `carrierThreadId` | `--carrier-thread` / `ACB_CARRIER_THREAD` | 最近一个 Codex 对话（作为桌面对话清单的调用上下文） |
| `workspaceRoot` | `ACB_WORKSPACE_ROOT` | `%USERPROFILE%\acb-workspaces` |
| `foregroundInput` | `--allow-foreground-input` / `ACB_ALLOW_FOREGROUND_INPUT=1` | 关闭 |
| `timeoutMs` | — | 240000（单次发送最长等待；低于 Hermes 默认的 300 秒工具超时） |
| 调试日志 | `--debug` / `ACB_DEBUG=1` | 关闭（正常运行不输出日志） |

## 3. 功能（各自独立）

所有工具一次只执行一个，彼此没有先后依赖：只想读 Codex 对话，就只调用 Codex 读取工具；只想看 GPT 的某段回复，就只调用 `acb_gpt_read`。失败时统一返回 `{"ok":false,"code":"…","message":"…"}`，可能附带 `fix` 和诊断字段。

### 3.1 Codex 对话（`codex app-server`，后台、无窗口）

| 工具 | 参数 | 返回 | 性质 |
|---|---|---|---|
| `acb_codex_list` | `limit?`（1–100，默认 20），`cwd?`，`cursor?` | `threads[{ threadId, name, preview, cwd, status, updatedAt }]`、`nextCursor` | 只读 |
| `acb_codex_find` | `searchTerm` | `[{ threadId, name, cwd }]` | 只读 |
| `acb_codex_read` | `threadId`，`turns?`（1–20，默认 1） | 对话信息、`turnCount`，以及最近几轮的 `turns[{ turnId, status, prompt, reply, truncated, error }]`（由旧到新） | 只读，不发送、不恢复对话 |
| `acb_codex_create` | `cwd`，`title`，`prompt?` | `threadId / reply / title / cwd` | 写入：新建并发送首条消息 |
| `acb_codex_send` | `threadId`，`prompt` | `reply / turnId / messageIds / alreadySent / approvalsDeclined` | 写入：发送一条 Prompt |
| `acb_workspace_create` | `name`，`path?` | `projectId / name / roots / path / directoryCreated` | 写入：目录 + Codex 项目（幂等） |

这一组只需要能找到 `codex.exe`，不依赖桌面窗口、命名管道或 ChatGPT。

### 3.2 ChatGPT 对话

| 工具 | 参数 | 返回 | 方式 |
|---|---|---|---|
| `acb_gpt_list` | 无 | `[{ conversationId, title, projectId }]`（置顶在前，其余最多 50 条） | Native IPC 只读，无窗口 |
| `acb_gpt_read` | `conversationId`，`turns?`（1–10，默认 1），`cursor?`，`window?` | `title / status`、最近几轮的 `turns[{ turnId, status, prompt, reply, replyInWindowOnly, truncated, error }]`（由旧到新）、`nextCursor`（继续读更早的轮次） | 默认 Native IPC 只读，无窗口；`window: true` 时从 ChatGPT 窗口读取最新一轮回复。都不输入、不发送 |
| `acb_gpt_open` | `conversationId` | `title / navigation`（`current` 或 `sidebar`） | 操作 ChatGPT 窗口（点击） |
| `acb_gpt_create` | `title`，`project?` | `conversationId / title / project?` | 前台键入 |
| `acb_gpt_send` | `conversationId`，`prompt` | `reply / turnId / inputMode / uiIdentity / navigation / alreadySent` | 前台键入 |

桌面应用的对话记录里，ChatGPT 回复常常只以引用占位（`::chatgpt-content-reference{…}`）保存，正文只在页面上。此时 `acb_gpt_read` 返回 `reply: null, replyInWindowOnly: true`，不会把占位符当成回复；传 `window: true` 会像 `acb_gpt_open` 一样显示该对话（可能点击侧栏，需授权），再经 UIA 读取最新一轮回复。列出和默认读取只走桌面应用的 Native IPC（需要桌面应用在同一 Windows 会话中运行，并以一个 Codex 对话作为调用上下文，见 `carrierThreadId`）；打开、新建、发送还需要 ChatGPT 窗口。

### 3.3 桌面清单与自检

| 工具 | 参数 | 返回 | 性质 |
|---|---|---|---|
| `acb_threads` | 无 | 侧栏清单中两类对话：`id / kind（codex/chatgpt）/ title / projectId / cwd` | 只读 |
| `acb_projects` | 无 | 桌面端项目：`projectId / projectKind / label / path` | 只读 |
| `acb_status` | 无 | 自检结果、修复建议和诊断信息（见第 6 节） | 只读 |

调用示例（参数）：

```json
{"name": "acb_codex_list", "arguments": {"cwd": "C:\\Users\\me\\acb-workspaces\\shop-api"}}
{"name": "acb_codex_read", "arguments": {"threadId": "<Codex 对话 ID>", "turns": 3}}
{"name": "acb_gpt_read", "arguments": {"conversationId": "<GPT 对话 ID>", "turns": 2}}
{"name": "acb_gpt_send", "arguments": {"conversationId": "<GPT 对话 ID>", "prompt": "请为订单接口设计分页方案"}}
{"name": "acb_codex_send", "arguments": {"threadId": "<Codex 对话 ID>", "prompt": "实现订单分页并运行测试"}}
```

工具之间没有固定顺序。需要跨对话协作时（例如把某个 GPT 回复转给 Codex），由调用方先读取、再发送，ACB 不会自动串联。

## 4. Workspace、项目与对话的管理方式

- **Workspace**：本地目录。`acb_workspace_create` 创建目录（默认在 `workspaceRoot` 下），并通过 Codex App Server 注册为 Codex 项目。同一目录重复调用，返回的是同一个项目。
- **Codex 对话**：`acb_codex_create` 在 Workspace 目录中新建对话并命名；新对话要发出第一条消息才会保存，所以创建时会顺带发一句确认消息。找已有对话用 `acb_codex_list`（可按 `cwd` 过滤）或 `acb_codex_find`。已归档的对话在发送时会自动取消归档一次。
- **GPT 对话**：`acb_gpt_create` 新建普通对话：先发送一条一次性身份标记，据此确定对话的确切 ID，再改成指定标题。标题必须唯一，之后才能可靠定位。给出 `project` 时，新对话会建在该**已有**的 ChatGPT 项目中。
- **定位**：ChatGPT 桌面应用不支持按 ID 跳转。所以发送目标必须正在显示，或者在侧栏中有唯一同名的入口。只要标题重名或无法确认，就会失败，不会发送。只读取不需要定位：`acb_gpt_read` 按 ID 直接读取。
- **复用优先**：先用列出/搜索/读取工具找到已有对话，确实没有时才创建。

## 5. 前台操作与后台操作

| 操作 | 方式 | 需要 ChatGPT 在前台 | 文本输入 | 影响用户当前操作 |
|---|---|---|---|---|
| `acb_codex_*`、`acb_workspace_create` | Codex App Server（独立后台进程） | 否 | 否 | 否 |
| `acb_gpt_list`、`acb_gpt_read`、`acb_threads`、`acb_projects`、`acb_status` | Native IPC 只读查询 | 否 | 否 | 否 |
| `acb_gpt_send` 读取回复 | 桌面清单 + UIA 只读 | 否 | 否 | 否 |
| `acb_gpt_open` | UIA 点击侧栏入口 | 是（已授权时自动尝试激活） | 否 | 切换当前对话，已授权时可能切前台 |
| `acb_gpt_send` 发送 | UIA 定位 + 核验输入 | 是（已授权时自动尝试激活） | 单行 SendInput；多行 UIA ValuePattern（持续核对前台和焦点） | 激活窗口，输入期间占用键盘 |
| `acb_gpt_create` | 左侧导航栏「新聊天」+ SendInput 键入 | 是（已授权时自动尝试激活） | 是 | 激活窗口，输入期间占用键盘 |

`--allow-foreground-input` 明确授权 ACB 恢复最小化的、身份已确认的 ChatGPT 窗口，并在输入前尝试激活一次。ACB 等待恢复完成，再向该窗口内唯一可用的输入框发出一次 UIA 焦点请求；焦点请求不写入或清除草稿，仍须核对 Windows 实际前台句柄。未授权时不激活、不键入。ACB 不移动鼠标、不使用剪贴板。各种情况下的行为：

ChatGPT 编辑器会合并连续的 Shift+Enter 换行；多行文本因此使用已核验 composer 支持的 UIA ValuePattern 逐段写入，仅替换本次已确认的输入前缀，每段精确回读，保留空行。单行仍用 SendInput；两种方式都需要授权并持续核对前台与焦点。

- **ChatGPT 不在前台**：已授权时自动尝试激活，确认 Windows 实际前台句柄一致才输入。Windows 拒绝激活或未授权时返回 `FOCUS_REQUIRED`，不向其他窗口输入，不通过修改系统设置或模拟快捷键强抢焦点。
- **输入中途切换窗口或焦点**：立即停止并返回 `FOCUS_REQUIRED`，不反复切回。已经输入的部分可能留在 ChatGPT 输入框里，请删除或保留；ACB 不会把它发出去。
- **失焦诊断**：`diagnostics.focusReason` 区分 `activationDenied`（Windows 拒绝激活）、`foregroundChanged`（前台窗口改变）、`composerFocusLost`（输入框失焦）和 `foregroundNotAuthorized`（未授权切前台）。同时返回 `targetHandle`、`foregroundHandle` 和本次已完成写入的前缀长度 `typedLength`（UTF-16）；不包含正文。写入、提交和失败清理前都会再次检查前台，失焦后不清理草稿。
- **激活诊断**：发生激活尝试时，失焦错误还包含 `diagnostics.activation`：方式 `method`、恢复请求是否受理 `restoreAccepted`、UIA 请求是否完成 `requestCompleted`，以及异常时的 `hresult`（按实际步骤返回）。请求完成不代表窗口已成为前台。
- **关闭 ChatGPT**：GPT 工具返回 `OWNER` 或 `IO`，Codex 工具不受影响。下次调用时会自动重新启动相应的辅助进程。
- **关闭桌面应用**：`acb_threads`、`acb_gpt_*` 无法读取对话清单，返回 `OWNER` 或 `IO`；`acb_codex_*` 只依赖 Codex App Server，照常可用。
- **ChatGPT 窗口最小化**：最小化的窗口读不到界面，无法直接确认它处于 ChatGPT 模式还是 Codex 模式。已授权且它是应用唯一的窗口时，ACB 先恢复一次（不聚焦、不输入），再按常规识别；确认是 ChatGPT 模式后才激活和输入，是 Codex 模式或仍无法识别则返回 `OWNER`。未授权或应用有多个窗口时不恢复，返回 `OWNER`（stage `chatgpt-window`，`diagnostics` 中给出窗口数、`minimized` 等计数），请把 ChatGPT 窗口显示出来。
- **同时开着 ChatGPT 和 Codex 窗口**：只使用能确认是 ChatGPT 的那一个窗口；无法确认时拒绝操作。
- **仍需用户手动配合**：Windows 拒绝激活时手动处理；在 Codex 中批准命令或文件操作（ACB 不代替审批）；创建 ChatGPT 项目、把已有对话移入项目；打开不在侧栏中的旧对话。

## 6. 当前限制、运维与故障处理

- **ChatGPT 原生项目**：ACB 不能新建项目，也不能把已有对话移入项目（「移至项目」里的项目列表 UIA 读不到），需要在 ChatGPT 中手动完成。`acb_gpt_create` 的 `project` 参数依赖空白新聊天页的「更改项目」按钮。**已知问题**：桌面应用 v26.1021 的空白页上没有该按钮，带 `project` 创建会在输入前以 `PROVENANCE`（stage `gpt-project`）失败，不带 `project` 不受影响。
- **超时**：Codex 的长任务可能超过 240 秒，此时返回 `TIMEOUT`。稍后用**同一个 Prompt** 再调用一次即可拿到回复，不会重复发送。
- **身份确认**：ChatGPT 页面不显示对话 UUID，返回 `uiIdentity: "titleOnly"`，表示是靠「标题唯一 + 桌面清单」确认的目标对话。
- **清单范围**：native host 最多返回 50 条非置顶对话，置顶对话另计；接口没有分页参数，顺序受侧栏排序设置影响。不会把缺失的对话冒充已确认目标；页面暴露 UUID 时仍须按 ID 读取核验。桌面应用报告 ChatGPT 清单不可用（例如未登录）时返回 `DEPENDENCY`，不会把空清单当成「标题唯一」。
- **读取范围**：`acb_gpt_read` 每次最多 10 轮，用 `nextCursor` 继续往前读；`acb_codex_read` 返回最近 1–20 轮。两者只返回用户消息和最终回复文本（不含推理、工具输出），单段超过 20000 字符时截断并标记 `truncated`。
- **新建**：只点击左侧导航栏的「新聊天」，确认空白页面后发送一次初始化标记，取得真实 ID，等待初始化完成再改标题；native 按 ID 读取、清单中同一 ID 的标题和页面定位连续两次一致才成功；页面显示了正确的 UUID 也不能代替清单确认。侧栏清单可能延迟约一分钟更新，会在原始创建超时预算内等待一致；预算耗尽后不再写入标题。失败会以 `status: "partial"` 返回已知 `conversationId`（未知则为 null）、实际 `title`、`requestedTitle`、`identityVerified`、失败 `stage` 及必要的标题核对结果。先检查已建对话，禁止重复创建或重复发送初始化标记。

| 错误码 | 含义 | 处理 |
|---|---|---|
| `TIMEOUT` | 回复还没完成 | 稍后用同一 Prompt 再调用 |
| `CONFLICT` | 对话正忙、已有草稿 | 等待，或清理输入框 |
| `PROVENANCE` | 无法确认目标（标题重名、不在侧栏、项目未回读确认） | 在 ChatGPT 中打开该对话，或换一个唯一标题 |
| `STATE` | 空白页面识别或 composer 精确回读校验失败 | 按 stage 和必要诊断定位，不重发 |
| `FOCUS_REQUIRED` / `AUTH` | Windows 拒绝激活、输入失焦 / 未授权键入 | 停止，处理焦点问题 / 明确授权 `--allow-foreground-input`；不循环激活 |
| `OWNER` / `DEPENDENCY` / `IO` | 应用未运行、连接中断，或桌面应用拒绝了请求 | 运行 `acb_status` 或 `npm run check`，按其中的 `fix` 和 `nativeError` 处理 |
| `IPC_CONFIG` | 桌面应用认为请求参数无效 | 对照 `nativeError` 与应用版本，更新 ACB |
| `CONFIG` | 找不到 Codex，或还没有任何 Codex 对话 | 安装并打开一次 Codex，或用 `--codex` 指定路径 |
| `EXECUTION` 且 `approvalsDeclined > 0` | Codex 需要审批 | 在 Codex 应用中批准，或调整该对话的审批策略 |

### 桌面应用自动更新之后

桌面应用会自动更新，并删除旧版本目录（`%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\`）。ACB 作为常驻进程，按以下方式应对：

- **`codex.exe` 路径**：自动发现的路径在每次使用前重新发现，更新后自动切换到新版本，不再出现「`DEPENDENCY`: Codex app-server could not start」需要重启 MCP Server 的情况。通过 `--codex` / `ACB_CODEX` / 配置文件指定的路径按原样使用；文件已不存在时直接返回 `DEPENDENCY` 并提示改用自动发现。
- **Native IPC 管道**：v26.1021 起，桌面应用把对话清单等工具（`tools/call`）从 `codex-browser-use-<uuid>` 管道移到了独立的 `codex-app-tools-<uuid>` 管道（旧管道只剩浏览器自动化和 `ping`）。ACB 优先使用新管道，找不到时回退旧管道以兼容旧版；主机身份核验（同一会话、同一用户、OpenAI 签名、唯一进程）不变。一次请求失败后，辅助进程会重新发现并核验管道，应用重启后无需重启 MCP Server。
- **错误细节**：桌面应用拒绝请求时，错误信息保留其原始错误码和消息（如 `Native request was rejected: [-1] No handler registered for method: tools/call`），并在 `nativeError` 中给出，便于判断是否又发生了协议变化。
- **`acb_status` 诊断**：`server.pid / server.startedAt`（当前 MCP Server 进程，可判断是否是更新前启动的旧进程）、`codex.path / codex.source`、`nativeIpc.host.appVersion / nativeIpc.host.pipe`（实际使用的管道类型）、`nativeIpc.pipes`（当前存在的两类管道数量）。
- **仍需手动重启的情况**：ACB 自身更新后（`dist/` 变化），需要在 Hermes 中执行 `/reload-mcp` 或重新开会话。
- **Codex 配置告警**：app-server 启动时若提示 `computer_use.windows.always_allowed_app_ids` 被忽略，说明 `~/.codex/config.toml` 中有已弃用的键，可自行删除该键（ACB 不修改该文件）。

## 7. 开发、部署与开源

```powershell
npm ci               # 按 package-lock.json 安装确切版本（会自动构建）
npm run typecheck
npm test             # 只用 Mock，不触碰真实对话
npm run smoke -- --name ACB-smoke --path C:\temp\acb-smoke   # Windows 实机冒烟：会真实发送消息
```

- smoke 失败后可用 `--gpt-conversation <已知 ID> --codex-thread <已知 ID>` 续测已有隔离会话，不重复创建或发送初始化标记。未指定 `--gpt-project` 时跳过项目测试。`--scope codex` 或 `--scope gpt` 只验收其中一组功能（默认 `all`）。
- 目录：`src/` MCP Server 与两个 PowerShell worker；`test/` Mock 回归测试；`scripts/` 构建与实机冒烟；`config/` 配置与 Hermes 注册示例；`skills/` Hermes Skill；`docs/images/` 图示。
- 源码在 `src/`，构建产物在 `dist/`（不入库）。两个 PowerShell 辅助脚本必须保存为带 BOM 的 UTF-8，否则 Windows PowerShell 5.1 会读错中文控件名；`npm run build` 会检查这一点。
- 开发规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- 许可证：[MIT](LICENSE)；依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 从 0.4 升级：工具名称和参数不变；新增 `acb_codex_list`、`acb_codex_read`、`acb_gpt_list`、`acb_gpt_read`；适配 v26.1021 起的 `codex-app-tools` 管道；Skill 改为工具说明，不再规定 Hermes → GPT → Codex 流程。
- 从 0.3 升级：`--carrier-thread` 和 `--codex` 改为可选；默认超时从 300 秒改为 240 秒（如需 300 秒，配置 `timeoutMs: 300000`，并把 Hermes 的 `timeout` 调到 400）；新增 `acb_status`；`scripts/acceptance.mjs` 更名为 `npm run smoke`。原有工具的名称和参数不变。
