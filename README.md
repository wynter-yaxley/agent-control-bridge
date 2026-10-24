# agent-control-bridge

[![CI](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)](#准备)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF)](https://modelcontextprotocol.io/)

[English](README_EN.md)

一个 MCP Server，让 AI agent 直接使用你电脑上 **ChatGPT 桌面应用** 里的 ChatGPT 对话和 Codex 对话：查看、搜索、读取、新建对话，发送一条消息并拿回真实回复。

- **一个工具只做一件事**：读取、搜索、新建、发送彼此独立，按需调用，没有固定流程。
- **能在后台的都在后台**：Codex 的所有操作和 ChatGPT 对话的读取都不碰窗口，不打扰你。
- **不会重复发送**：同一条消息超时后再调用，只会取回回复，不会再发一次。
- **在本机运行**：ACB 自己不向任何服务上传数据（你发送的消息仍由 ChatGPT / Codex 按其服务规则处理），不读取账号凭据，不替你批准 Codex 的命令。

![架构](docs/images/architecture.svg)

## 能做什么

| 工具 | 作用 | 会打扰你吗 |
|---|---|---|
| `acb_codex_list` | 列出最近的 Codex 对话（可按目录筛选） | 否 |
| `acb_codex_find` | 按关键词搜索 Codex 对话 | 否 |
| `acb_codex_read` | 读取一个 Codex 对话最近几轮的问答 | 否 |
| `acb_codex_create` | 在某个目录新建一个 Codex 对话 | 否 |
| `acb_codex_send` | 给 Codex 对话发消息，等它做完并返回回复 | 否 |
| `acb_workspace_create` | 新建一个工作目录并注册为 Codex 项目 | 否 |
| `acb_gpt_list` | 列出 ChatGPT 对话 | 否 |
| `acb_gpt_read` | 读取一个 ChatGPT 对话最近几轮的问答 | 否（读回复正文时会打开该对话） |
| `acb_gpt_open` | 在应用里打开某个 ChatGPT 对话 | 会切换当前显示的对话 |
| `acb_gpt_create` | 新建一个 ChatGPT 对话并命名 | 会激活窗口并输入 |
| `acb_gpt_send` | 给 ChatGPT 对话发消息并返回回复 | 会激活窗口并输入 |
| `acb_threads` / `acb_projects` | 列出应用侧栏里的全部对话 / 项目 | 否 |
| `acb_status` | 自检：哪里没准备好、怎么修 | 否 |

## 准备

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 24.19 或更高（装在 Windows 上）
- ChatGPT 桌面应用（Microsoft Store 版，内含 Codex），已登录，并至少用过一次 Codex
- 一个支持 MCP 的客户端，例如 Hermes、Claude Desktop

> 只用 Codex 工具时，理论上也能在 macOS / Linux 上运行（需要已安装 `codex` 命令），但未经实测。

## 安装

在 PowerShell 中：

```powershell
git clone https://github.com/wynter-yaxley/agent-control-bridge.git
cd agent-control-bridge
npm install        # 安装并构建
npm run check      # 自检，并打印适合本机的接入配置
```

## 接入 MCP 客户端

把下面的配置加入你的 MCP 客户端（路径换成你的实际路径，`npm run check` 会打印填好的版本）：

```json
{
  "mcpServers": {
    "acb": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\agent-control-bridge\\dist\\mcp.js", "--allow-foreground-input"]
    }
  }
}
```

**Hermes** 用户可以直接运行 `npm run check` 输出的 `hermes mcp add ...` 命令，并把 [skills/agent-control-bridge](skills/agent-control-bridge/SKILL.md) 复制到 Hermes 的 skills 目录（命令同样在输出里）。这个 Skill 告诉 agent 每个工具怎么用、有哪些注意事项；其他客户端也可以把它作为系统提示使用。

建议把客户端的工具超时设为 300 秒以上：给 Codex 或 ChatGPT 发消息时，ACB 最长会等 240 秒。

## 使用须知

**关于 `--allow-foreground-input`**

给 ChatGPT 发消息、新建 ChatGPT 对话时，ACB 需要把 ChatGPT 窗口切到前台并输入文字。加上这个参数表示你同意这样做。

- 输入期间请不要操作键盘鼠标。你一旦切走窗口，ACB 立即停止，不会再抢回前台，也不会把输入了一半的内容发出去（这部分文字可能留在输入框里）。
- 窗口最小化时，ACB 会先把它恢复出来、确认是 ChatGPT 窗口后才输入。
- 不加这个参数：ACB 从不激活窗口、从不打字；只有 ChatGPT 已在前台、输入框里已经有一模一样的草稿时才会发送。
- 只用读取类工具或 Codex 工具时，不需要这个参数。

**ChatGPT 对话**

- ChatGPT 窗口需要处于 **ChatGPT 模式**（不是 Codex 模式）。ACB 不会替你切换模式。
- 新建对话的标题必须唯一，之后才能可靠地找到它。
- 发消息时，ACB 只会在能确认身份的对话里输入：目标对话要么正在显示，要么在侧栏里只有一个同名入口。标题重名时会拒绝，不会发错对话。
- 应用只向 ACB 提供最近 50 条对话（置顶的另算）。太早的对话请先在应用里打开一次。
- 应用的对话记录里通常不保存 ChatGPT 回复的正文。`acb_gpt_read` 读不到回复时会标记 `replyInWindowOnly`，让 agent 加上 `window: true` 再读一次（会打开该对话）。

**Codex 对话**

- Codex 想执行命令或改文件、需要审批时，ACB 一律拒绝，并在结果里告诉你被拒绝了几次。请在应用里自己批准，或调整该对话的审批设置。
- 已归档的对话，发消息时会自动取消归档。
- 任务做得久，超过 240 秒会返回 `TIMEOUT`，但任务仍在继续。稍后用**同一条消息**再调用一次即可拿到回复，不会重复发送。

**其他**

- 所有发送、新建、窗口操作一次只执行一个；读取类工具随时立即返回。
- 应用自动更新后不需要重启 ACB；ACB 本身更新后，需要在客户端里重新加载 MCP（Hermes 中是 `/reload-mcp`）。
- ACB 不能新建 ChatGPT 项目，也不能把对话移进项目，需要你在应用里操作。

## 出了问题

先让 agent 调用 `acb_status`（或运行 `npm run check`），按其中的 `fix` 处理。常见情况：

| 错误码 | 通常意味着 | 怎么办 |
|---|---|---|
| `TIMEOUT` | 回复还没好 | 稍后用同一条消息再调用 |
| `CONFLICT` | 对话正忙，或输入框里有你的草稿 | 等一会儿，或清空输入框 |
| `FOCUS_REQUIRED` | 输入时窗口被切走，或 Windows 拒绝激活 | 回到 ChatGPT 窗口后重试 |
| `AUTH` | 没有加 `--allow-foreground-input` | 在配置里加上这个参数 |
| `OWNER` | 应用没运行，或找不到 ChatGPT 模式的窗口 | 打开应用并切到 ChatGPT 模式 |
| `PROVENANCE` | 无法确认是哪个对话（重名、不在最近列表里） | 在应用里打开该对话，或换一个唯一标题 |
| `CONFIG` | 找不到 Codex，或还没有任何 Codex 对话 | 安装应用并用一次 Codex |
| `DEPENDENCY` / `IO` | 应用没响应，或 ChatGPT 未登录 | 按 `acb_status` 的提示处理 |
| `EXECUTION` | Codex 任务失败，或需要审批被拒 | 查看回复；需要审批时去应用里批准 |

新建 ChatGPT 对话中途失败时，结果里会带上已创建对话的 ID（`status: "partial"`）。请先看看这个对话，不要直接重新创建。

## 配置（可选）

不需要配置文件。需要时可用命令行参数、环境变量或 JSON 文件（`--config`，示例见 [config/config.example.json](config/config.example.json)）。

| 选项 | 命令行 / 环境变量 | 默认 |
|---|---|---|
| 允许前台输入 | `--allow-foreground-input` / `ACB_ALLOW_FOREGROUND_INPUT=1` | 关 |
| Codex 程序路径 | `--codex` / `ACB_CODEX` | 自动找应用自带的 `codex.exe` |
| 新工作目录的位置 | `ACB_WORKSPACE_ROOT` | `%USERPROFILE%\acb-workspaces` |
| 单次发送最长等待 | 配置文件 `timeoutMs` | 240000（毫秒） |
| 调试日志 | `--debug` / `ACB_DEBUG=1` | 关 |

## 开发

```powershell
npm ci; npm run typecheck; npm test     # 测试只用 Mock，不碰真实对话
npm run smoke -- --name ACB-smoke       # Windows 实机测试：会真实新建对话并发消息
```

开发规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE) · 依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
