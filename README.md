# Agent Control Bridge

让 Hermes 通过 MCP 向**现有的** ChatGPT / Codex 桌面对话转发一条 Prompt，并取回真实回复。只做这一件事：不建 Workspace、不建对话、不管理任务、不保存台账。

[English](README_EN.md)

## 两条链路

| 目标 | 发送 | 回复 |
|---|---|---|
| ChatGPT 普通对话 | ChatGPT 桌面应用 UIA：输入框写入 Prompt、点击“发送”（不接管物理鼠标键盘） | 先由 Codex 桌面的 Native IPC `read_thread` 确认该轮完成，再用 UIA 读取与该 Prompt 对应的完整回复 |
| Codex 对话 | 本机 `codex app-server`：`thread/resume` + `turn/start` | 轮询 `thread/read` 直到该轮结束，返回最终回复（不含 commentary） |

## 基础保护

- **目标识别**：ChatGPT 目标标题来自 Native IPC 按会话 ID 读取的结果，而不是当前窗口。UIA 先核对当前对话标题，不一致立即退出，不碰输入框和草稿；页面暴露 `/c/<UUID>` 时再按 UUID 精确核对，否则为 `titleOnly`（不保证 UUID 身份，结果中返回 `uiIdentity`）。需要由用户先在 ChatGPT 桌面应用里打开目标对话。
- **不重复发送**：发送前读取目标对话的最新一轮；如果它已经是同一条 Prompt，就不再发送，只读取它的回复（仍在运行时返回 CONFLICT）。超时后用同一 Prompt 再调用一次即可取回回复。对话正忙时拒绝发送。
- **不误写**：输入框里有其他未发送草稿时拒绝；同一时间只执行一次发送；Codex 的命令/文件审批请求一律拒绝。
- **只读宿主校验**：Native IPC 只允许 `list_threads` 与 `read_thread`，并核对管道另一端是同一用户、签名有效的 Codex 进程。

## 安装与配置

需要 Windows、Node >= 24.19.0、已登录的 ChatGPT 与 Codex 桌面应用，以及本机 `codex.exe`。

    npm ci
    npm run build

配置（见 [config.example.json](config.example.json)；旧版配置文件也可直接使用，未用到的字段被忽略）：

| 字段 | 含义 |
|---|---|
| `carrierThreadId` | 任意一个已有 Codex 对话 ID，作为 Native IPC 调用上下文 |
| `codexExecutable` | `codex.exe` 的绝对路径 |
| `timeoutMs` | 单次等待回复的上限，默认 300000 |
| `uiPollMs` | UIA / 回读轮询间隔，默认 1000 |

也可用命令行参数覆盖：`node dist/mcp.js --config <文件> --carrier-thread <Codex ID> --codex <codex.exe>`。

## MCP 工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `acb_threads` | 无 | 最近的原生对话 `id / kind / title` |
| `acb_gpt_send` | `conversationId`, `prompt` | `reply`, `turnId`, `title`, `uiIdentity`, `alreadySent` |
| `acb_codex_send` | `threadId`, `prompt` | `reply`, `turnId`, `messageIds`, `alreadySent` |

失败时返回 `{ ok:false, code, message }`；`TIMEOUT` 表示已发送但回复未就绪，不会自动重发。Hermes 接入样例见 [config/hermes-mcp.example.yaml](config/hermes-mcp.example.yaml)。

## 开发

    npm run typecheck
    npm test

测试只使用模拟对象；真实投递需在 Windows 上人工验证。
