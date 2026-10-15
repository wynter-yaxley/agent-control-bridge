# Agent Control Bridge

让 Hermes 通过 MCP 创建本地 Workspace 与 Codex 项目、新建 Codex / ChatGPT 对话、定位目标对话、转发 Prompt 并取回真实回复。不管理任务、不保存台账。

[English](README_EN.md)

## 两条链路

| 目标 | 通道 | 说明 |
|---|---|---|
| Codex | 本机 `codex.exe app-server`（stdio） | `project/create`、`thread/start {cwd}`、`turn/start`、`thread/read`、`thread/name/set`、`thread/search`、`thread/unarchive`。按 threadId 直接操作，不切换界面 |
| ChatGPT | 桌面应用 UIA + Codex 桌面 Native IPC（`read_thread` / `list_threads` / `set_thread_title`） | 当前对话已显示目标时直接使用；否则仅在标题于原生清单中唯一时点击侧栏条目打开。输入：用户已写好相同草稿时只点击发送；否则在 `--allow-foreground-input` 授权且 ChatGPT 已在前台时用 SendInput 键入 |

## 基础保护

- **目标识别**：ChatGPT 标题以原生按 ID 读取为准；同名对话存在、或目标不在最近清单中时直接失败。页面无 `/c/<UUID>` 路由时结果为 `titleOnly`。发送后用原生回读确认 Prompt 落在目标 ID。新建对话以一次性标记确认 ID，不按标题推断。
- **输入**：不夺取前台；ChatGPT 不在前台或输入框无焦点时返回 `FOCUS_REQUIRED`。每段键入前核对前台窗口与焦点，换行用 Shift+Enter，键入后内容须一致才点击发送；失败时只清除自己键入的内容。不使用剪贴板、CDP 或 `ValuePattern.SetValue`（对该输入框无效）。
- **不重复发送**：目标最新一轮已是同一 Prompt 时只读取回复；`TIMEOUT` 后用同一 Prompt 再调用即可读取。忙碌对话、他人草稿一律拒绝；同一时间只执行一个调用。
- **Codex 审批**：桥不代替用户批准命令或文件操作，审批请求会被拒绝并在结果中计数（`approvalsDeclined`）。

## 配置

需要 Windows、Node >= 24.19.0、已登录的 ChatGPT 与 Codex 桌面应用和本机 `codex.exe`。`npm ci && npm run build`。

| 字段 | 含义 |
|---|---|
| `carrierThreadId` | 任意一个已有 Codex 对话 ID，作为 Native IPC 调用上下文 |
| `codexExecutable` | `codex.exe` 绝对路径 |
| `workspaceRoot` | 新建 Workspace 的默认父目录 |
| `foregroundInput` | `true` 表示用户授权 SendInput 键入（或 `--allow-foreground-input`） |
| `timeoutMs` / `uiPollMs` | 单次等待上限（默认 300000）/ 轮询间隔（默认 1000） |
| `nativeInterface.maxCandidates` | 原生管道候选上限，默认 32 |

启动：`node dist/mcp.js --config <文件> [--carrier-thread <ID>] [--codex <codex.exe>] [--allow-foreground-input]`。

## MCP 工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `acb_threads` | 无 | 最近原生对话 `id / kind / title / projectId / cwd` |
| `acb_projects` | 无 | 原生项目 `projectId / projectKind / label / path` |
| `acb_workspace_create` | `name`, `path?` | 建目录并 `project/create`：`projectId / name / roots / path / directoryCreated`；同一目录重复调用返回同一项目 |
| `acb_codex_create` | `cwd`, `title`, `prompt?` | 新 Codex 对话（首轮已应答以便持久化）：`threadId / reply / title` |
| `acb_codex_find` | `searchTerm` | `thread/search` 命中的 `threadId / name / cwd` |
| `acb_codex_send` | `threadId`, `prompt` | `reply / turnId / messageIds / alreadySent / approvalsDeclined` |
| `acb_gpt_create` | `title` | 新普通 ChatGPT 对话 `conversationId / title` |
| `acb_gpt_open` | `conversationId` | `title / navigation`（`current` 或 `sidebar`） |
| `acb_gpt_send` | `conversationId`, `prompt` | `reply / turnId / inputMode / uiIdentity / navigation / alreadySent` |

多对话转发：把一个工具返回的 `reply` 作为另一个对话的 `prompt` 发送即可。失败时返回 `{ ok:false, code, message }`。

ChatGPT 原生「项目」的创建与归入：当前没有经实测可用的接口，未实现。

## 开发与验收

    npm run typecheck
    npm test

测试只使用模拟对象。Windows 实机验收：`node scripts/acceptance.mjs --config <文件> --carrier-thread <ID> --codex <codex.exe> --name <新 Workspace 名> --path <隔离目录>`，按 Workspace → Codex 项目与对话 → 搜索 → GPT 对话 → 定位 → 收发 → 转发 顺序执行，首个失败即停止。
