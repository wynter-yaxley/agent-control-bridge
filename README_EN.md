# Agent Control Bridge

Hermes coordinates existing signed-in ChatGPT/Codex desktop applications through Feishu. GPT produces engineering prompts; the bridge verifies authentic conversation/message provenance and hashes; Codex executes; GPT reviews results; an independent authorized reviewer accepts delivery.

Each project has a native Codex workspace, one same-name ordinary GPT chat, and registered Codex chats. Version 0.2.0 is development delivery pending acceptance. A real isolated loop completed with UI interaction and recovery. Under the 2026-10-13 user instruction, workspace and ordinary GPT creation may use normal UIA, directory confirmation and page/editor focus changes; fully silent creation is no longer an acceptance requirement. Hermes/Feishu deployment remains unverified. Unknown model/effort values stay null and no longer block authentic prompts.

## Install

Node >=24.19.0, npm and Git. Windows IPC/UIA use OS PowerShell 5.1. Python/websocket-client are only needed for the retained current-instance CDP adapter.

    npm ci --ignore-scripts
    npm run build
    node dist/cli.js demo

Copy config.example.json to .bridge.config.json and protect config/caller-policy.json. Examples grant no roles/UI permissions. Back up existing databases before explicit migration.

## MCP and automation boundaries

Default dist/mcp.js --read-only exposes 8 read tools against an existing current-schema database; it neither migrates nor starts queued tasks. A trusted Windows embedding installs ProjectHost, ConversationHost and a real executor context through runMcp(args, createHost). Hermes tools.include defaults to the 8 read tools; writes require a protected per-run host approval binding; reviewer uses a separate protected connection.

Native IPC is read-only and verifies the signed same-user peer. UIA uses the interactive desktop and may change pages/editor focus; it needs approval for that run. CDP needs an already exposed endpoint. App Server supports background execution but cannot establish native desktop project ownership alone.

No second instance/profile/browser/WebView, application restart/termination, injection, credential extraction, private-state edits or physical input takeover. Existing UIA remains one adapter. Title-only navigation has been removed: the public accessibility document URI must prove the exact /c/UUID before submission. The current application exposes only a generic index URI, so UIA sending/initialization is blocked with PROVENANCE. GPT final text is reread after native completion and independent UI idle/reply-action checks, then correlated again. This positive path has component tests, not a new live write acceptance.

Execution-result MCP calls now return IDs/hashes/lengths by default. Add includeContent:true for complete output/feedback. Project operations return recorded resources directly. Prefer notifications; reconcile uncertain original generation/execution/feedback without resending/rerunning.

Only independent acceptance produces SUCCEEDED. Test results and GPT review cannot grant that authority.

## Verify

    npm run typecheck
    npm run build
    npm test
    npm run test:desktop
    npm run check
    npm audit --audit-level=high
    npm run test:install

Node discovery includes e2e/workflow. Clean-install checks dependency/build/compiled-entry behavior without repeating the source matrix. Native reads reuse one serial Bridge-owned worker. Direct API users close it with closeNativeReadWorker() or NativeReadWorker.close(); runMcp handles shutdown. UIA now reuses one serial worker with fresh elements per request (one cold/hot read sample: 1320/53ms); direct users close it with ui.close() or closeWindowsNativeUiWorkers().

See the [main README](README.md) for capability matrices, configuration, host integration, workflow/recovery and measured limits. [Rules](docs/PROJECT_RULES.md), [acceptance template](docs/ACCEPTANCE_TEMPLATE.md), [license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md).

The installed Hermes MCP SDK connected to the real Windows entry and OS policy with an isolated ledger (8 read tools, HOST_MISSING). Gateway/Feishu writes remain unverified; production ledger v2 requires an explicitly authorized migration, and the current controller/reviewer policy needs separation before write deployment. Hermes elicitation is present, but no protected Windows approval binding exists. No new research/stage/test-summary Markdown by default.
