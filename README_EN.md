# Agent Control Bridge

Lets Hermes forward one prompt over MCP to an **existing** ChatGPT or Codex desktop conversation and return the real reply. Nothing else: no workspace or conversation creation, task management or ledger.

- ChatGPT: UIA writes the prompt into the open chat and clicks Send; Native IPC `read_thread` confirms the turn completed, then UIA reads the reply correlated to that prompt. The target title comes from the native read of the target ID; a different current chat is refused before the composer is touched. Without a `/c/<UUID>` route the match is `titleOnly` (reported as `uiIdentity`). The user opens the target chat first.
- Codex: local `codex app-server` (`thread/resume`, `turn/start`, then `thread/read` until the turn ends). Command/file approval requests are declined.
- No duplicate sends: if the target's latest turn already carries the same prompt it is not sent again; its reply is returned (CONFLICT while running). A busy conversation or a foreign draft is refused. Sends run one at a time.

Tools: `acb_threads`, `acb_gpt_send {conversationId, prompt}`, `acb_codex_send {threadId, prompt}`. Configure `carrierThreadId` (an existing Codex thread ID) and `codexExecutable`; see [config.example.json](config.example.json). Requires Windows and Node >= 24.19.0. `npm ci && npm run build`, then `node dist/mcp.js --config <file>`.
