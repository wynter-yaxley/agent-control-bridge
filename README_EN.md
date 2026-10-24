# agent-control-bridge (ACB)

[![CI](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF)](https://modelcontextprotocol.io/)
[![Hermes Skill](https://img.shields.io/badge/Hermes-skill%20included-F59E0B)](skills/agent-control-bridge/SKILL.md)

[中文](README.md)

Agent Control Bridge (ACB) is an MCP server that splits the ChatGPT / Codex desktop app into **independent tools**: list, find and read Codex conversations; list and read ChatGPT conversations; create a conversation; send one prompt to a conversation and return its real reply. Each tool does one thing. The caller (Hermes or any MCP client) picks and combines them as the task requires; ACB prescribes no workflow.

![Architecture](docs/images/architecture.svg)

## Requirements

Windows 10/11 (ChatGPT tools are Windows-only), Node.js 24.19+ on Windows, the ChatGPT / Codex desktop app (signed in; current builds ship as "ChatGPT", Store package `OpenAI.Codex`, main program `app\ChatGPT.exe`, and host both ChatGPT chats and Codex tasks; its bundled `codex.exe` is found automatically) and an MCP client such as Hermes on Windows or in WSL. The Codex tools only need `codex app-server` and may work on macOS/Linux, untested.

## Install and connect Hermes

```powershell
git clone https://github.com/wynter-yaxley/agent-control-bridge.git
cd agent-control-bridge
npm install        # installs and builds dist/
npm run check      # read-only self-check; prints the Hermes commands for this machine
```

Run the `hermes` commands printed by `npm run check` (one MCP registration and one skill copy, for Hermes on Windows or in WSL), for example:

```bash
hermes mcp add acb --command '/mnt/c/Program Files/nodejs/node.exe' --args 'D:\agent-control-bridge\dist\mcp.js' --allow-foreground-input
cp -r '/mnt/d/agent-control-bridge/skills/agent-control-bridge' ~/.hermes/skills/
```

Then start a new Hermes session (or `/reload-mcp`). Keep the server name `acb`. `--allow-foreground-input` authorizes restoring/activating the verified ChatGPT window and typing; without it ACB never activates or types and can only submit an identical draft while ChatGPT is already in front. A manual alternative is [config/hermes-mcp.example.yaml](config/hermes-mcp.example.yaml).

The skill [skills/agent-control-bridge/SKILL.md](skills/agent-control-bridge/SKILL.md) describes what each tool does, when a read tool is enough, and the safety rules that must not be weakened (no resend, no approvals, stop on focus loss, act on the error code). It assigns no roles and prescribes no workflow. Hermes lists skills in every prompt and loads matching ones; check with `hermes skills list` or load it with `/agent-control-bridge`.

Configuration is optional: options, then `ACB_CODEX`, `ACB_CARRIER_THREAD`, `ACB_WORKSPACE_ROOT`, `ACB_ALLOW_FOREGROUND_INPUT=1`, `ACB_DEBUG=1`, `ACB_CONFIG`, then a JSON file ([config/config.example.json](config/config.example.json)), then discovery. Defaults: newest desktop `codex.exe`, the most recent Codex conversation as desktop context, `%USERPROFILE%\acb-workspaces`, a 240 s send timeout (below Hermes' 300 s tool timeout), no logs.

## Tools

The tools are independent: reading a Codex conversation needs only the Codex group; reading a ChatGPT reply needs only `acb_gpt_read`.

| Group | Tool | Arguments | Mode |
|---|---|---|---|
| Codex (`codex app-server`, background, no window) | `acb_codex_list` | `limit?` (1-100), `cwd?`, `cursor?` | read-only: recently updated conversations, `nextCursor` |
| | `acb_codex_find` | `searchTerm` | read-only full-text search |
| | `acb_codex_read` | `threadId`, `turns?` (1-20) | read-only: prompt/reply text of the newest turns, oldest first |
| | `acb_codex_create` | `cwd`, `title`, `prompt?` | creates and answers a first turn |
| | `acb_codex_send` | `threadId`, `prompt` | sends one prompt |
| | `acb_workspace_create` | `name`, `path?` | directory + Codex project, idempotent |
| ChatGPT | `acb_gpt_list` | — | read-only native inventory, no window |
| | `acb_gpt_read` | `conversationId`, `turns?` (1-10), `cursor?`, `window?` | read by ID, no window; `nextCursor` reads older turns. The desktop transcript often keeps a reply only as a content reference (`replyInWindowOnly: true`); `window: true` shows the chat (as `acb_gpt_open`) and reads the newest reply through UIA. Never types or sends |
| | `acb_gpt_open` | `conversationId` | clicks in the ChatGPT window |
| | `acb_gpt_create` | `title`, `project?` (an existing ChatGPT project) | foreground typing |
| | `acb_gpt_send` | `conversationId`, `prompt` | foreground typing |
| Desktop | `acb_threads`, `acb_projects` | — | read-only sidebar inventory (both kinds) and projects |
| | `acb_status` | — | read-only self-check with diagnostics |

Errors are `{"ok":false,"code","message"}`, with `fix` and diagnostics where known. A repeated prompt is never resent: after `TIMEOUT`, call again with the same prompt to read the reply. Tools are never chained automatically: to pass a ChatGPT reply to Codex, read it, then send it.

## After a desktop app update

- The auto-discovered `codex.exe` is discovered again before every use, so a long-running server follows the app's version folder after an update instead of failing with `DEPENDENCY`. A configured path is used as given; if that file is gone, the error says so.
- Since v26.1021 the app serves its app tools (`tools/call`: inventory, read, rename) on a dedicated `codex-app-tools-<uuid>` pipe; `codex-browser-use-<uuid>` only answers browser automation and `ping`. ACB prefers the new pipe and falls back to the old one for older builds; host verification (same session and user, OpenAI signature, one process) is unchanged. After a failed request the helper rediscovers the pipe, so an app restart needs no server restart.
- A rejected request keeps the host's code and message (`nativeError`, e.g. `[-1] No handler registered for method: tools/call`). `acb_status` reports `server.pid/startedAt`, the Codex path, `nativeIpc.host.appVersion/pipe` and the pipe counts.
- If the app-server warns that `computer_use.windows.always_allowed_app_ids` is ignored, remove that deprecated key from `~/.codex/config.toml` (ACB does not edit it).

## Foreground and background

Codex, list and read tools run in the background. `--allow-foreground-input` explicitly authorizes ACB to restore a minimized, verified ChatGPT window and try to activate it once before GPT navigation/typing. It waits for restoration to complete, then requests focus once on the sole usable composer inside that verified window, without writing or clearing its draft. It checks the actual Windows foreground handle and composer focus. If Windows refuses or the user changes windows/focus during input, ACB stops with `FOCUS_REQUIRED`, never repeatedly takes focus, and never submits the partial text. Without authorization it never activates or types; an identical draft can only be submitted while ChatGPT is already in front. No mouse, clipboard or focus-lock workaround is used. A Codex or unidentified window is refused. A minimized window exposes no UI tree; when it is the app's only window and input is authorized, ACB restores it once (no focus, no typing) and then identifies it as usual. The user still approves Codex commands, creates ChatGPT projects, moves existing chats into projects and opens chats missing from the sidebar.

Single-line input uses SendInput. The editor collapses consecutive Shift+Enter breaks, so multiline input uses the verified composer's supported UIA ValuePattern in chunks, replacing only the exact prefix written by this operation and checking its text, foreground and focus after every write. Blank lines must read back exactly before submission.

Focus errors include `diagnostics.focusReason`: `activationDenied`, `foregroundChanged`, `composerFocusLost`, or `foregroundNotAuthorized`. They also include the actual `targetHandle`, `foregroundHandle`, and `typedLength` of the completed prefix in UTF-16 units, without prompt text. Foreground checks run immediately before writes, submission and failure cleanup; a focus loss leaves the draft untouched.

After an activation attempt, focus errors also include `diagnostics.activation`: `method`, restore-request acceptance (`restoreAccepted`), UIA request completion (`requestCompleted`), and an exception's `hresult`, as applicable. A completed request does not prove that the window became foreground.

## Limits

ChatGPT projects cannot be created and existing chats cannot be moved into one (the project list is invisible to UIA); a new chat can start in an existing project. Known issue: desktop app v26.1021 shows no project picker on the blank chat page, so `acb_gpt_create` with `project` stops with `PROVENANCE` at `gpt-project` before typing; creation without `project` works. ChatGPT exposes no conversation UUID in the window, so identity is "unique title + desktop inventory" (`uiIdentity: "titleOnly"`).

The native host returns at most 50 non-pinned chats plus pinned chats, uses sidebar sorting and has no pagination parameter. Missing inventory entries are never treated as proven identities. Creation uses only the left-sidebar New chat button, checks the blank page, sends one initialization marker, verifies its real ID and completion, then renames and checks native readback, the inventory entry for the same ID and the app page twice; a correct page UUID does not replace the inventory check. The sidebar can lag by about a minute; creation waits within its original timeout budget for agreement and writes no title once that budget is spent. Failure after submission returns `status: "partial"`, the known `conversationId` (null if unknown), actual `title`, `requestedTitle`, `identityVerified`, `stage` and relevant title verification results. Read that chat before further action; never create a replacement or resend the marker. `STATE` covers blank-page/composer verification; `PROVENANCE` covers conversation identity/persistence; `FOCUS_REQUIRED` covers activation/focus.

## Development

`npm ci`, `npm run typecheck`, `npm test` (mocks only), `npm run smoke -- --name ACB-smoke --path C:\temp\acb-smoke` (real Windows run, sends real messages). `--scope codex|gpt` limits the smoke run to one group. The PowerShell workers must stay UTF-8 with BOM; the build checks it. MIT licensed. Upgrading from 0.4: tool names and arguments are unchanged; `acb_codex_list`, `acb_codex_read`, `acb_gpt_list` and `acb_gpt_read` are new; the `codex-app-tools` pipe is supported; the skill no longer prescribes a Hermes → GPT → Codex workflow. Upgrading from 0.3: `--carrier-thread` and `--codex` are optional, the default timeout is 240 s, `acb_status` is new, `scripts/acceptance.mjs` is now `npm run smoke`; existing tool names and arguments are unchanged.

After a smoke failure, `--gpt-conversation <known ID> --codex-thread <known ID>` resumes those isolated chats without recreating them or resending initialization markers. The optional project test is skipped without `--gpt-project`.
