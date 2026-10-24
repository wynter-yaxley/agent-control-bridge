# Changelog

Versions follow Semantic Versioning. Desktop behavior is verified manually on Windows (`npm run smoke`); unit tests use mocks.

## 0.5.0 (Unreleased)

- Independent tools instead of one workflow: new read-only `acb_codex_list` (thread/list, by `cwd`, with a cursor) and `acb_codex_read` (newest 1-20 turns through the App Server), `acb_gpt_list` and `acb_gpt_read` (newest 1-10 turns by ID through native IPC, `nextCursor` for older turns, no window). The server instructions, README and skill describe each tool and the safety rules; the Hermes → GPT → Codex roles and workflow diagram are removed. Existing tool names and arguments are unchanged.
- Desktop app v26.1021: app tools (`tools/call`) moved from `codex-browser-use-<uuid>` (now ping and browser automation only, "No handler registered for method: tools/call") to `codex-app-tools-<uuid>`. The pipe worker prefers the new pipe and falls back to the old one; host verification is unchanged. `read_thread` accepts `turnLimit` 1-10 and an opaque `cursor`.
- A rejected native request keeps the host's error code and message (`nativeError`), a failed tool keeps its text, and a refused request restarts the pipe worker so a restarted app is found again. A host that cannot list its ChatGPT chats is a `DEPENDENCY` error, not an empty inventory.
- The auto-discovered `codex.exe` is discovered again before every use, so a server started before a desktop app update no longer fails with `DEPENDENCY` (2026-10-21 incident); a configured path that no longer exists fails fast with a fix.
- `acb_gpt_read`: the host empties message text when outputs are excluded, so reads keep outputs on; a reply kept in the transcript only as `::chatgpt-content-reference{…}` is reported as `reply: null, replyInWindowOnly: true`, and `window: true` reads the newest reply from the shown chat through the same UIA path as `acb_gpt_send`.
- A minimized ChatGPT window exposes no UI tree in the current app, so it could never be identified and the documented restore never happened (`OWNER` at `chatgpt-window`). With `--allow-foreground-input`, the app's only window is now restored once when minimized and unreadable, then identified as before; a Codex or unidentified window is still refused. Window-choice failures report window counts in `diagnostics` and a fix.
- Removed `acb_gpt_create`'s `project` argument (start a chat inside a ChatGPT project). Creating a ChatGPT conversation does not need it, and v26.1021 no longer shows the project picker (更改项目) it relied on. Clients passing `project` now get an invalid-arguments error.
- Archived Codex conversations were never unarchived: the App Server already refuses `thread/resume`, before `turn/start`. Resume and start are now retried together once after unarchiving.
- Faster: read-only tools no longer wait behind a running send; the App Server, desktop context and pipe/UI workers start in the background when a client connects (first call 5.1 s -> 0.4 s); Codex sends and reads load thread metadata and the newest turns instead of the whole history, which also keeps long conversations under the frame limit.
- `acb_status` reports the server's pid and start time, the native host's app version and pipe type, and the pipe counts. `npm run smoke -- --scope codex|gpt` checks one group.
- The repository and its folder are named `agent-control-bridge`.

## 0.4.0

- Housekeeping: the unused native tool catalog (`tools/list`) is removed from the client and the pipe worker's request allowlist; both configuration examples live in `config/`.
- Installable MCP tool: `npm install` builds it, `npm run check` (or `--check`) runs a read-only self-check and prints the Hermes `mcp add` and skill commands for the machine. No configuration is required: `codex.exe` is discovered from the Codex desktop app (or PATH) and the desktop context thread from the most recent Codex conversation; options, `ACB_*` variables and an optional JSON file still override.
- Hermes skill `skills/agent-control-bridge` with the working rules (roles, reuse, short reports, failure handling, approval for non-core work).
- One Codex App Server process is reused across calls (closed after 10 idle minutes or on failure) and a `turn/completed` notification ends a reply wait without waiting for the next poll.
- New `acb_status` tool. UIA stage lines are logged only with `--debug` / `ACB_DEBUG=1`. Child processes are closed when the client disconnects.
- Default send timeout 240 s, below Hermes' 300 s tool timeout, so a long reply returns a clean `TIMEOUT` (read it later with the same prompt; it is not resent).
- `scripts/acceptance.mjs` is now `npm run smoke`; carrier thread and Codex path are optional there too. Obsolete review templates and duplicate rule documents are removed; README rewritten with architecture and workflow diagrams.

## 0.3.0

- Reduced to the core bridge: workspaces and Codex projects, GPT/Codex conversations, locating a target, sending one prompt and returning the real reply. Codex goes through the App Server (`project/create`, `thread/start`, `turn/start`, `thread/search`, archived threads unarchived once, approvals declined). ChatGPT is located through the native inventory and its single sidebar entry, typed into with authorized SendInput (never taking the foreground), and new chats are identified by a one-time marker.
- Windows fixes from real runs: offscreen sidebar entries, the new-chat composer, transient Codex readback errors, ChatGPT/Codex window choice, PowerShell workers with UTF-8 BOM, and new chats inside an existing ChatGPT project with read-back confirmation.
- Removed: SQLite ledger, caller policy and roles, approvals, tasks and background worker, notifications, CDP/Python tools. The previous architecture remains in the Git history.

## 0.2.0 and 0.1.0

Earlier architecture with task ledger, roles and approvals; see the Git history.
