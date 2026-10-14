# Agent Control Bridge

A configurable Windows 10/11 local stdio MCP tool. Hermes/Feishu is the preferred controller; other compatible MCP clients can use the same protocol. GPT produces engineering prompts; the bridge verifies conversation/message provenance and hashes; Codex executes; GPT reviews results; an independent authorized reviewer accepts delivery. No extra token-billed inference API is introduced.

Each project has a native Codex workspace, one same-name ordinary GPT chat, and registered Codex chats. Version 0.2.0 remains pending independent acceptance. A historical isolated loop needed UI intervention and recovery; it does not establish acceptance of the current stricter path. Workspace/GPT creation may change pages and editor focus with trusted approval. The latest read-only check found no configured CDP listener and UIA returned unavailable; an earlier titleOnly observation does not establish current availability. No live GUI writes or Hermes/Feishu loop were performed. Unknown GPT model/effort values stay null.

## Install

Node >=24.19.0, npm and Git. Windows IPC/UIA use OS PowerShell 5.1. Python/websocket-client are only needed for the retained current-instance CDP adapter.

    npm ci --ignore-scripts
    npm run build
    node dist/cli.js demo

Copy config.example.json to .bridge.config.json and protect config/caller-policy.json. Examples grant no roles/UI permissions. Back up existing databases before explicit migration.

## MCP and automation boundaries

Default dist/mcp.js --read-only and dist/windows-host.js expose 8 read tools against an existing schema-v6 database, without migration or queue startup. dist/windows-host.js --write permits protected controller ledger operations but does not grant GUI/executor authority. runWindowsHost(args, createBindings) installs real trusted callbacks. Run one separate --worker runtime with the same ledger for durable execution independent of MCP disconnection. Without an embedding, the executor comes only from a protected-policy entry whose "host" names this controller, and Codex command/file approvals are ledger approvals decided by an independent reviewer (acb_approvals_pending / acb_approval_decide); out-of-workspace scope, foreign turns, secrets or timeouts decline. Missing prerequisites are listed in CODEX_EXECUTOR_HOST_MISSING. --preflight prints a read-only deployment report. Migrated projects regain access only through acb_project_adopt after native readback. An uncertain workspace step is only read back; acb_project_restart_workspace is an explicit, approved, audited retry when its own directory is empty and no native workspace exists. acb_project_prepare accepts 1-4 Codex conversations, each with its own formal receipt. With desktop.enabled, a controller connection may create bundles: each attempt (prepare, restart, reconcile, one added Codex) asks an independent reviewer through one gui-initialization ledger approval naming its operationId, attempt and effects; reuse is limited to that attempt, its listed effects and an operation row that still matches this controller, name and path, so a retry asks again. A read-only probe requires the native add-project entry to be unique, enabled, on screen and invokable (one ScrollItemPattern scroll is tried) before any approval, directory or restart budget; hidden controls are never invoked. Formal Codex creation uses native create_thread only when its advertised schema accepts exactly title, prompt and a project target; the pipe worker re-checks the fixed request shape. The initial prompt ACB_CODEX_INIT_<operationId>_<index> is the durable receipt used to recover a lost reply without resending. This path has no live Windows evidence yet. Without a formal creator the operation waits in codex.attach and acb_project_attach_codex accepts only threads read back as Codex members of that workspace and directory. READY projects can add Codex conversations (up to 4) by attach or acb_project_create_codex without changing the request fingerprint; a pending creation index is recorded first and recovered from its receipt. The writable tool surface has 26 tools; existing-chat GUI approval still needs a trusted embedding.

Native IPC is read-only except the fixed-shape create_thread, and verifies the signed same-user peer. CDP verifies listener ownership and a unique existing ChatGPT WebView before observing /c/UUID. Unavailable CDP falls back to UIA Document.Current.Name with titleOnly, null ID and no messages; unavailable UI is reported separately. UIA requires an interactive desktop and per-run approval. Formal App Server execution can continue without GUI, but needs native membership, a delegated executor and target-bound command/file approval callbacks; it cannot establish native desktop ownership alone.

No second instance/profile/browser/WebView, application restart/termination, injection, credential extraction, private-state edits or physical input takeover. Existing-chat writes require exact identity before draft changes and submission, followed by native receipt verification; atomic cross-CDP/UIA targeting is not implemented, so that route remains blocked. A trusted-approved newly created blank ordinary chat may send one identity-only marker and correlate its new native ID/user message/type/title. Uncertainty never resends. Codex UIA Work creation/execution is refused; native creation requires a formal host callback. GPT final text is read only after native completion with matching message IDs and independent end-of-stream evidence. Positive paths are component-tested, not live acceptance.

Execution-result MCP calls now return IDs/hashes/lengths by default. Add includeContent:true for complete output/feedback. Project operations return recorded resources directly. Prefer notifications; reconcile uncertain original generation/execution/feedback without resending/rerunning.

Only independent acceptance produces SUCCEEDED. Controller, Codex executor and reviewer do not overlap. No policy hot reload or authority from config/env/MCP text. Same-OS malicious code is outside the strong-isolation claim. Crash recovery preserves original IDs/phases and observes original turns without rerun; uncertainty in one project no longer freezes unrelated prepared background work. Tasks use an explicit registered Codex target/default rather than lexical ordering.

Recovered RUNNING_OBSERVED executions synchronize task/run/request completion and send feedback once; ordinary RUNNING work is not eligible. A saved verified PENDING prompt resumes without GPT regeneration only after proven process exit, with COMPLETE generation, a queued task and no dispatch/execution evidence. Known Windows PID absence is distinct from query failure. Native Codex creation carries its own initialization prompt as receipt; a missing original ID is recovered only from that exact prompt in the same workspace and directory, otherwise it remains uncertain without replacement creation. CDP fallback retains cdpError.

The read-only Hermes sample uses a 300-second timeout: two 120-second CDP/UIA budgets, 30-second native verification and 30-second client margin. Recalculate from unified configuration when budgets change; engineering runs in the independent worker, not a longer MCP request.

## Data and deployment

    node dist/cli.js db-backup --config <file> --file <new-backup-path>
    node dist/cli.js db-restore --file <backup> --db <new-ledger-path>

SQLite online backup includes committed WAL data. Both commands reject existing destinations; restore checks integrity and writes a new ledger only. Stop the owned Bridge runtime, inspect the recovered ledger/mappings, then switch configuration under operator control. Do not overwrite live state, stop desktop apps, upload the database by default, or delete unknown resources. Schema-v6 migration is explicit; old multi-chat mappings need an explicit default.

## Verify

    npm run typecheck
    npm run build
    npm test
    npm run test:desktop
    npm run check
    npm audit --audit-level=high
    npm run test:install

Node discovery includes e2e/workflow. Clean-install checks dependency/build/compiled-entry behavior without repeating the source matrix. Native reads reuse one serial Bridge-owned worker. Direct API users close it with closeNativeReadWorker() or NativeReadWorker.close(); runMcp handles shutdown. UIA now reuses one serial worker with fresh elements per request (one cold/hot read sample: 1320/53ms); direct users close it with ui.close() or closeWindowsNativeUiWorkers().

Historical scan registration is limited to the two exact file paths/blobs in the published initial import. Baseline expansion, later blob reuse, private-path copies and current-tree findings fail. The checker reports PENDING_HERMES_POLICY_REVIEW; technical acknowledgement does not approve the policy exception. Changes to the checker itself require independent review.

See the [main README](README.md) for capability matrices, configuration, host integration, workflow/recovery and measured limits. [Rules](docs/PROJECT_RULES.md), [acceptance template](docs/ACCEPTANCE_TEMPLATE.md), [license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md).

The installed Hermes MCP SDK connected to the Windows entry and real OS policy with an isolated ledger (8 read tools, HOST_MISSING). The local controller/reviewer overlap was removed; a real independent reviewer is still not configured. The existing production ledger remains v2 and was not migrated. Gateway/Feishu, actual durable App Server deployment and protected GUI approval binding remain unverified or externally blocked. No new research/stage/test-summary Markdown by default.
