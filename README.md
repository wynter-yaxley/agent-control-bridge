# Agent Control Bridge（ACB）

[![CI](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)](#1-用途平台与前置条件)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF)](https://modelcontextprotocol.io/)
[![Hermes Skill](https://img.shields.io/badge/Hermes-skill%20included-F59E0B)](skills/agent-control-bridge/SKILL.md)

[English](README_EN.md)

ACB 是一个 MCP Server，让 Hermes（或任何 MCP 客户端）直接操作 **ChatGPT 桌面应用** 和 **Codex 桌面应用**：创建 Workspace 与 Codex 项目、新建或复用对话、发送 Prompt 并取回真实回复。Hermes 只需调用工具，不必为日常任务编写脚本。

![架构](docs/images/architecture.svg)

## 1. 用途、平台与前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（ChatGPT 相关工具只支持 Windows） |
| Node.js | 24.19 或更高，安装在 Windows 上 |
| Codex 桌面应用 | 已安装并登录；ACB 会自动找到它自带的 `codex.exe` |
| ChatGPT 桌面应用 | 已安装并登录；使用 GPT 工具时需要运行 |
| Hermes | Windows 原生版或 WSL 版均可 |

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
- `--allow-foreground-input` 表示授权 ACB 向 ChatGPT 窗口键入文字（见第 6 节）。不加这个参数时，只有当输入框里已有完全相同的草稿，GPT 消息才会被发出。
- 也可以手动把 [config/hermes-mcp.example.yaml](config/hermes-mcp.example.yaml) 合并进 Hermes 的 `config.yaml`。

### Hermes 工作规范（Skill）

规则写在 [skills/agent-control-bridge/SKILL.md](skills/agent-control-bridge/SKILL.md)，上一步已复制到 Hermes 的 skills 目录。Hermes 每轮都会看到技能索引，并按其系统提示，在涉及 ChatGPT / Codex / ACB 的任务中加载这个 Skill。规则内容：

- Hermes 负责接收任务、选择项目与对话、调用 ACB、转发 Prompt、管理进度和汇报；ChatGPT 负责分析、方案和复核；Codex 负责代码、命令、文件修改和测试。
- Hermes 不重复做 Codex 的工作，不为普通任务编写脚本；优先复用已有项目和对话。
- 默认只汇报关键进度和最终结果；工具失败时只查直接原因；非核心开发先征得用户同意。

确认已加载：执行 `hermes skills list`，列表中应有 `agent-control-bridge`；在对话中也可以用 `/agent-control-bridge` 主动加载。合并到 main 后，还可以直接安装：`hermes skills install https://raw.githubusercontent.com/wynter-yaxley/agent-control-bridge/main/skills/agent-control-bridge/SKILL.md --yes`。

### 配置（全部可选）

不需要配置文件。如需调整，按以下优先级生效：命令行参数 → 环境变量 → 配置文件（`--config <file>` 或 `ACB_CONFIG`，示例见 [config.example.json](config.example.json)）→ 自动发现与默认值。

| 配置项 | 命令行 / 环境变量 | 默认值 |
|---|---|---|
| `codexExecutable` | `--codex` / `ACB_CODEX` | Codex 桌面应用自带的最新 `codex.exe`，其次是 PATH 中的 `codex` |
| `carrierThreadId` | `--carrier-thread` / `ACB_CARRIER_THREAD` | 最近一个 Codex 对话（作为桌面对话清单的调用上下文） |
| `workspaceRoot` | `ACB_WORKSPACE_ROOT` | `%USERPROFILE%\acb-workspaces` |
| `foregroundInput` | `--allow-foreground-input` / `ACB_ALLOW_FOREGROUND_INPUT=1` | 关闭 |
| `timeoutMs` | — | 240000（单次发送最长等待；低于 Hermes 默认的 300 秒工具超时） |
| 调试日志 | `--debug` / `ACB_DEBUG=1` | 关闭（正常运行不输出日志） |

## 3. MCP 工具

所有工具一次只执行一个。失败时统一返回 `{"ok":false,"code":"…","message":"…"}`。

| 工具 | 参数 | 返回 | 运行方式 |
|---|---|---|---|
| `acb_status` | 无 | 自检结果和修复建议 | 只读 |
| `acb_threads` | 无 | 最近的 ChatGPT / Codex 对话：`id / kind / title / projectId / cwd` | 只读 |
| `acb_projects` | 无 | 桌面端项目：`projectId / projectKind / label / path` | 只读 |
| `acb_workspace_create` | `name`，`path?` | `projectId / name / roots / path / directoryCreated` | 后台 |
| `acb_codex_create` | `cwd`，`title`，`prompt?` | `threadId / reply / title / cwd` | 后台 |
| `acb_codex_find` | `searchTerm` | `[{ threadId, name, cwd }]` | 后台只读 |
| `acb_codex_send` | `threadId`，`prompt` | `reply / turnId / messageIds / alreadySent / approvalsDeclined` | 后台 |
| `acb_gpt_create` | `title`，`project?` | `conversationId / title / project?` | 前台键入 |
| `acb_gpt_open` | `conversationId` | `title / navigation`（`current` 或 `sidebar`） | 操作 ChatGPT 窗口（点击） |
| `acb_gpt_send` | `conversationId`，`prompt` | `reply / turnId / inputMode / uiIdentity / navigation / alreadySent` | 前台键入 |

调用示例（参数）：

```json
{"name": "acb_workspace_create", "arguments": {"name": "shop-api"}}
{"name": "acb_codex_create", "arguments": {"cwd": "C:\\Users\\me\\acb-workspaces\\shop-api", "title": "shop-api 开发"}}
{"name": "acb_gpt_create", "arguments": {"title": "shop-api 方案", "project": "我的项目"}}
{"name": "acb_gpt_send", "arguments": {"conversationId": "<GPT 对话 ID>", "prompt": "请为订单接口设计分页方案"}}
{"name": "acb_codex_send", "arguments": {"threadId": "<Codex 对话 ID>", "prompt": "按以下方案实现并运行测试：…"}}
```

## 4. Workspace、项目与对话的管理方式

- **Workspace**：本地目录。`acb_workspace_create` 创建目录（默认在 `workspaceRoot` 下），并通过 Codex App Server 注册为 Codex 项目。同一目录重复调用，返回的是同一个项目。
- **Codex 对话**：`acb_codex_create` 在 Workspace 目录中新建对话并命名；新对话要发出第一条消息才会保存，所以创建时会顺带发一句确认消息。找已有对话用 `acb_threads` 或 `acb_codex_find`。已归档的对话在发送时会自动取消归档一次。
- **GPT 对话**：`acb_gpt_create` 新建普通对话：先发送一条一次性身份标记，据此确定对话的确切 ID，再改成指定标题。标题必须唯一，之后才能可靠定位。给出 `project` 时，新对话会建在该**已有**的 ChatGPT 项目中。
- **定位**：ChatGPT 桌面应用不支持按 ID 跳转。所以目标对话必须正在显示，或者在侧栏中有唯一同名的入口。只要标题重名或无法确认，就会失败，不会发送。
- **复用优先**：日常任务应先找已有项目和对话，确实没有时才创建。

## 5. Hermes → GPT → Codex 工作流

![工作流](docs/images/workflow.svg)

1. 用户把任务交给 Hermes。
2. Hermes 用 `acb_threads` / `acb_codex_find` 找到已有对话，没有才创建。
3. `acb_gpt_send`：请 ChatGPT 分析需求、给出方案。
4. `acb_codex_send`：把方案原文和具体任务发给 Codex，由它写代码、执行命令、测试。
5. 需要时把 Codex 的结果发回 ChatGPT 复核。
6. Hermes 向用户汇报关键进度和最终结果。

## 6. 前台操作与后台操作

| 操作 | 方式 | 需要 ChatGPT 在前台 | 键盘输入（SendInput） | 影响用户当前操作 |
|---|---|---|---|---|
| `acb_codex_*`、`acb_workspace_create` | Codex App Server（独立后台进程） | 否 | 否 | 否 |
| `acb_threads`、`acb_projects`、`acb_status` | Native IPC 只读查询 | 否 | 否 | 否 |
| `acb_gpt_send` 读取回复 | 桌面清单 + UIA 只读 | 否 | 否 | 否 |
| `acb_gpt_open` | UIA 点击侧栏入口 | 否 | 否 | 会切换 ChatGPT 当前显示的对话 |
| `acb_gpt_send` 发送 | UIA 定位 + SendInput 键入 | **是** | **是**（每段输入前核对前台窗口和焦点） | 输入期间占用键盘 |
| `acb_gpt_create` | UIA 点击「新聊天」+ SendInput 键入 | **是** | **是** | 输入期间占用键盘 |

ACB **不会**抢占前台、移动鼠标或使用剪贴板。各种情况下的行为：

- **ChatGPT 不在前台**：返回 `FOCUS_REQUIRED`，什么都不输入。
- **输入中途切换窗口或焦点**：立即停止并返回 `CONFLICT`。已经输入的部分会留在 ChatGPT 输入框里，请删除或保留；ACB 不会再把它发出去。
- **关闭 ChatGPT**：GPT 工具返回 `OWNER` 或 `IO`，Codex 工具不受影响。下次调用时会自动重新启动相应的辅助进程。
- **关闭 Codex 桌面应用**：`acb_threads` 和 GPT 工具无法读取对话清单，返回 `OWNER` 或 `IO`；Codex App Server 工具照常可用。
- **同时开着 ChatGPT 和 Codex 窗口**：只使用能确认是 ChatGPT 的那一个窗口；无法确认时拒绝操作。
- **仍需用户手动配合**：把 ChatGPT 放到前台；在 Codex 中批准命令或文件操作（ACB 不代替审批）；创建 ChatGPT 项目、把已有对话移入项目；打开不在侧栏中的旧对话。

## 7. 当前限制与故障处理

- **ChatGPT 原生项目**：ACB 不能新建项目，也不能把已有对话移入项目（「移至项目」里的项目列表 UIA 读不到），需要在 ChatGPT 中手动完成。新建对话时可以用 `project` 参数直接建在已有项目中。
- **超时**：Codex 的长任务可能超过 240 秒，此时返回 `TIMEOUT`。稍后用**同一个 Prompt** 再调用一次即可拿到回复，不会重复发送。
- **身份确认**：ChatGPT 页面不显示对话 UUID，返回 `uiIdentity: "titleOnly"`，表示是靠「标题唯一 + 桌面清单」确认的目标对话。

| 错误码 | 含义 | 处理 |
|---|---|---|
| `TIMEOUT` | 回复还没完成 | 稍后用同一 Prompt 再调用 |
| `CONFLICT` | 对话正忙、已有草稿，或输入被打断 | 等待，或清理输入框 |
| `PROVENANCE` | 无法确认目标（标题重名、不在侧栏、项目未回读确认） | 在 ChatGPT 中打开该对话，或换一个唯一标题 |
| `FOCUS_REQUIRED` / `AUTH` | ChatGPT 不在前台 / 未授权键入 | 把 ChatGPT 放到前台 / 加上 `--allow-foreground-input` |
| `OWNER` / `DEPENDENCY` / `IO` | 应用未运行或连接中断 | 运行 `acb_status` 或 `npm run check`，按其中的 `fix` 处理 |
| `CONFIG` | 找不到 Codex，或还没有任何 Codex 对话 | 安装并打开一次 Codex，或用 `--codex` 指定路径 |
| `EXECUTION` 且 `approvalsDeclined > 0` | Codex 需要审批 | 在 Codex 应用中批准，或调整该对话的审批策略 |

## 8. 开发、部署与开源

```powershell
npm ci               # 按 package-lock.json 安装确切版本（会自动构建）
npm run typecheck
npm test             # 只用 Mock，不触碰真实对话
npm run smoke -- --name ACB-smoke --path C:\temp\acb-smoke   # Windows 实机冒烟：会真实发送消息
```

- 源码在 `src/`，构建产物在 `dist/`（不入库）。两个 PowerShell 辅助脚本必须保存为带 BOM 的 UTF-8，否则 Windows PowerShell 5.1 会读错中文控件名；`npm run build` 会检查这一点。
- 开发规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- 许可证：[MIT](LICENSE)；依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 从 0.3 升级：`--carrier-thread` 和 `--codex` 改为可选；默认超时从 300 秒改为 240 秒（如需 300 秒，配置 `timeoutMs: 300000`，并把 Hermes 的 `timeout` 调到 400）；新增 `acb_status`；`scripts/acceptance.mjs` 更名为 `npm run smoke`。原有工具的名称和参数不变。
