# Desktop tools

[中文主说明](../../README.md) · [English project guide](../../README_EN.md) · [原工具索引](TOOLS.md)

本目录迁入原有 12 个项目工具，保留 DOM 读取、输入框检查、草稿保护、注入一致性检查和兼容工具名。用户确认这些原始文件为项目原创，允许按 MIT 发布。迁移记录见 [清单](../../docs/audit/DESKTOP_MIGRATION.json)。原始路径不再是安装依赖。

## 环境和安装

Python >=3.10（Windows 桌面模式使用 Windows 侧 Python）；读取已登录 ChatGPT/Codex 的可见界面需要应用本身支持且已经由用户授权启用 CDP。本项目不会自动启动调试端口或获取登录状态。核心 Node CLI/Demo 不需要 Python WebSocket 依赖。

```powershell
python -m pip install -r tools/desktop/requirements.txt
python -m unittest discover -s tools/desktop/tests -v
python tools/desktop/gpt-read --help
```

依赖仅 `websocket-client==1.8.0`，Apache-2.0；未复制第三方源码。读取宿主可见消息仍可能包含私密业务信息，用户必须授权读取该会话。输出对常见认证字段及凭据模式脱敏，模式扫描不能识别所有秘密。

## 配置与能力边界

统一使用根目录 `.bridge.config.json`（默认不入 Git），`ACB_CONFIG` 可指定其他配置文件，`ACB_CDP_URL` 覆盖 `desktop.cdpUrl`。CDP 默认 `http://127.0.0.1:9222`，拒绝远端、URL 凭据、重定向和不匹配的 WebSocket 主机/端口。`desktop.enabled` 默认 false；配置启用不代表有发送授权。Python 不读取 Cookie、Profile、Token 或密钥。

`codex-status` 的元数据默认 `~/.codex`，可通过统一配置 `agents.codex.statePath` 指定目录中的全局状态文件；旧兼容 `ACB_CODEX_HOME` 显式覆盖该目录。需要 Codex 提供 `thread_history_1.sqlite` 及相应表，该文件不是桥接业务数据库。

| 工具 / 示例 | 功能与输出 | 参数 | 后台安全 / 焦点 / 物理输入 / 授权 |
|---|---|---|---|
| `python tools/desktop/gpt-read --last --json` | 可见 ChatGPT 消息 JSON；`modelVerified:false` | `--last`, `--json`, `--kind webview\|page` | 是 / 无 / 无 / 已授权会话读取 |
| `python tools/desktop/cdp_messages.py page` | 兼容可见消息 JSON | positional `webview` / `page` | 是 / 无 / 无 / 已授权会话读取 |
| `python tools/desktop/probe_targets.py` | 目标数量/类型；不输出 URL、页面内容、会话信息 | 无（支持 `--help`） | 是 / 无 / 无 / CDP 已启用 |
| `python tools/desktop/route-execution-guard gpt|codex` | 只读归属/执行位观察分类；明确 `trustedAuthorityGranted:false` | `gpt` 或 `codex` | 是 / 无 / 无 / 用户授权的 CDP 只读 |
| `python tools/desktop/codex-status --limit 6` | 只读线程历史摘要；不证明当前后台执行 | `--thread ID`, `--project NAME`, `--limit 1..100` | 是 / 无 / 无 / 用户元数据读取 |
| `python tools/desktop/relay.py codex2gpt` | 返回助手输出候选，`REVIEW_REQUIRED`，不自动发送 | `gpt2codex\|codex2gpt` | 读取是 / 无 / 无 / 不授予写权 |
| `python tools/desktop/gpt-send --help` / `gpt_send_cdp.py` | 原 CDP 注入/提交算法；普通 CLI 发送默认阻塞 | 提示词、`--force-clear`（仅可信宿主受控调用） | 否 / 可能改变编辑焦点 / 无 OS 物理输入 / 单次宿主授权 |
| `python tools/desktop/gpt-rename --help` / `desktop_rename.py` | 对指定会话执行菜单重命名、剪贴板粘贴、提交策略尝试和标题读回；普通 CLI 无法授权 | 新标题（可信宿主 API 另传 target context） | 否 / 可能改变编辑焦点 / 无 OS 物理输入 / target-bound 单次授权 |
| `python tools/desktop/codex-send --help` / `codex_send_cdp.py` | 原 Codex composer 算法；生产需可信桥接来源回执及授权 | 提示词、`--force-clear`（仅可信宿主受控调用） | 否 / 可能改变编辑焦点 / 无 OS 物理输入 / 来源 + 单次宿主授权 |
| `python tools/desktop/codex-continue --help` | 保留兼容入口；原直接 raw-prompt resume 被来源门禁阻塞 | THREAD、PROMPT、`--confirm` 不能授予来源 | 不执行 / 无 / 无 / 缺可信适配器时拒绝 |
| `python tools/desktop/recovery.py --check-cdp` | Windows 侧只读 CDP 可达性，不能证明模型或会话已恢复 | `--check-cdp` | 是 / 无 / 无 / 不会重启 |

所有工具 `--help` 均无网络与输入副作用。`--json` 是读取入口兼容参数，读取输出始终是 JSON。`gpt2codex` 默认返回 PROVENANCE 拒绝：DOM 文本、自我声明 `source=chatgpt` 无法证明实际 GPT-6/High 或会话来源。Node `PromptPipeline` 是可信宿主接入点；当前未交付能验证实际桌面模型/思考强度并完成自动双向发送的生产适配器。

## Project route and execution guards

`gpt_send_cdp.main` and `codex_send_cdp.main` are trusted-host APIs. The host must pass the project mapping returned by `ConversationRegistry` (including provider, registered session ID, project ID, and workspace/root paths) and issue a `DesktopAuthority` handle bound to `desktop_guards.binding_fingerprint(mapping)`. The desktop page must independently expose the exact active conversation ID and project ID through navigation metadata; titles are never used as ownership proof. If a session is shown in Recent, the bridge only tries repair when the page exposes a session-ID-bound `data-action="move-to-project"` and a project-ID-bound menu item, and the host supplies a separate `project_route_repair` approval. The bridge then rereads page state and blocks unless ownership matches. Unknown or unsupported UI metadata returns structured `unsupported`, `blocked`, or `verification_failed` results.

Production `PromptPipeline` adapters must implement `preflight(target, signal)`. It must collect the local Codex surface, execution-mode attribute, visible conversation/project/workspace values, and matching `.codex-global-state.json` thread assignment/root metadata. `local Codex` is allowed only when all IDs and paths match; Work/cloud, ordinary GPT, unknown, conflicting, stale, or missing evidence is rejected. Preflight runs twice before the prompt enters `DELIVERING`, and the target is passed into `deliver`; the Windows CDP sender repeats the check after paste immediately before submission. UI labels are observations, never authority; `/mnt/data` is only a risk clue. The bridge does not send a probe prompt.

The reusable clipboard module supports a Windows Unicode text clipboard state. It refuses clipboard contents containing other formats when it cannot preserve them, confirms focus and exact pasted text, and reports restoration failure. Rename submission uses only currently observed capabilities, tries each strategy at most once, verifies the target row twice, and returns `persistence: not independently verified after reload`; it does not claim the closed application has saved across restart. The diagnostic command is read-only and never grants authority. These code paths have Mock coverage only; the application must expose the documented identity attributes for writes to proceed, so incompatible UI versions fail closed.

## 退出码与安全入口

0 = 本地请求已完成（提交动作不等于执行/验收成功）；2 = 参数/配置/输入错误；3 = 授权、来源或桌面执行失败；4 = 状态/注入不一致；6 = Agent/依赖/前台授权未就绪；7 = CDP 超时。错误写 stderr，为结构化摘要，不回显私密响应。`argparse` 的参数错误为标准 stderr/exit 2。

`desktop_common.CAPABILITIES` 为读/写声明 `backgroundSafe`, `requiresForeground`, `usesPhysicalInput`, `requiresUserApproval`。写入口在任何 DOM/输入操作之前调用 guard。只有可信宿主持有的、不可由 JSON/参数重建的单次 `DesktopAuthority` handle 能通过授权；config flags、`--confirm` 或 `--force-clear` 不能授权。CDP 的 `.focus()`、逻辑输入事件和页面 `.click()` 不是 OS 物理键鼠，但可能影响应用编辑焦点，因此默认禁用。不存在 SetCursorPos、SendInput、窗口激活或 `shell=True` 执行路径。Chromium/Electron 控件不假定支持 BM_CLICK。

## 故障处理与验证范围

- `AGENT`：确认用户已授权的正确应用和唯一会话 target；不会替用户登录、启动或停止应用。
- `DEPENDENCY`：使用正确 Windows Python，按 requirements 安装可选依赖。WSL 回环不可达不等于 Windows CDP 失败。
- `AUTH` / `FOREGROUND_REQUIRED`：配置不授予权限；交由可信宿主请求明确授权，不切换焦点绕过。
- `PROVENANCE`：检查登记的项目/GPT/Codex 会话和 Prompt 来源、哈希；无法验证实际模型时保持待审核。
- `TIMEOUT` / `CDP`：应用响应不可用，如实报备，不重复提交不确定的操作。
- `codex-status`：历史 SQLite 表可能因应用版本不同而不存在；错误不是任务成功证据。

Mock 自动化覆盖默认拒绝、单次权限、目标限制、兼容 help、CDP 异常、退出码及恢复序列。真实登录桌面、实际发送、模型能力、MSIX 启动与焦点影响尚未验证。详见 [工作拓扑与恢复](../../docs/WORKSPACE_AND_RECOVERY.md)。后续可以把状态读取逐步封装到 TypeScript，保留经过验证的 Python 接口，不以全量重写作为迁移前提。

发送后的 composer 内容必须与原 Prompt 完全相等，包含首尾空白；不能用 strip 掩盖哈希链中的内容变化。GPT 输入框缺失时拒绝，不自动创建未登记对话；先恢复登记的同名 GPT 会话再继续。Mock 额外覆盖空白篡改不提交和不新建错配会话。
