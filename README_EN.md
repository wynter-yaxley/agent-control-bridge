# Agent Control Bridge

Lets Hermes, over MCP, create a local workspace and Codex project, create Codex and ChatGPT conversations, locate a target, forward a prompt and return the real reply. No task management or ledger.

- Codex: local `codex.exe app-server` (`project/create`, `thread/start {cwd}`, `turn/start`, `thread/read`, `thread/name/set`, `thread/search`, `thread/unarchive`), addressed by thread ID. The bridge never grants command/file approvals; they are declined and counted.
- ChatGPT: desktop UIA plus Codex desktop Native IPC. A chat is located only if it is already shown or its natively read title is unique in the inventory (then its single sidebar entry is opened); ambiguity fails. An identical user-written draft is just sent; otherwise the prompt is typed with SendInput only with `--allow-foreground-input` and ChatGPT already in front (else `FOCUS_REQUIRED`). Native readback confirms the turn landed in the target ID.
- No duplicate sends: a prompt that is already the latest turn is not resent; busy targets and foreign drafts are refused.

Tools: `acb_threads`, `acb_projects`, `acb_workspace_create`, `acb_codex_create`, `acb_codex_find`, `acb_codex_send`, `acb_gpt_create`, `acb_gpt_open`, `acb_gpt_send`. ChatGPT-native projects are not implemented (no verified interface). Requires Windows and Node >= 24.19.0. Live acceptance: `node scripts/acceptance.mjs`.
