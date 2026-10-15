# Agent Control Bridge

Lets Hermes, over MCP, create a local workspace and its native project, create ChatGPT and Codex conversations, open a target conversation, forward a prompt and return the real reply. No task management or ledger.

- ChatGPT: the target is opened by ID with the app's own navigation (a sidebar click only when its title is unique in the native inventory) and confirmed against the natively read title (UUID when exposed, else `titleOnly`). The prompt is typed with foreground SendInput only with `--allow-foreground-input`; window and focus are checked before every chunk and the text must read back before Send. Native IPC `read_thread` confirms the turn landed in that ID; UIA reads the reply.
- New chats are identified by a one-time marker turn, never by title, and named with native `set_thread_title`. Codex conversations are created with native `create_thread`; Codex prompts go through local `codex app-server` and command/file approvals are declined.
- No duplicate sends: a prompt that is already the latest turn is not sent again; busy targets and foreign drafts are refused; calls run one at a time.

Tools: `acb_threads`, `acb_projects`, `acb_workspace_create`, `acb_gpt_create`, `acb_codex_create`, `acb_gpt_open`, `acb_gpt_send`, `acb_codex_send`. Configure `carrierThreadId`, `codexExecutable`, `workspaceRoot`; see [config.example.json](config.example.json). Requires Windows and Node >= 24.19.0. `npm ci && npm run build`, then `node dist/mcp.js --config <file> --allow-foreground-input`. Live acceptance: `node scripts/acceptance.mjs`.
