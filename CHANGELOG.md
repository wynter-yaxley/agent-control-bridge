# Changelog

Versions follow Semantic Versioning. Desktop behavior is verified manually on Windows (`npm run smoke`); unit tests use mocks.

## 0.4.0 (Unreleased)

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
