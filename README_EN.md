# Agent Control Bridge

[中文](README.md) · [Code audit](docs/audit/CODE_AUDIT_REPORT.md) · [Repairs and acceptance record](docs/audit/REPAIR_STATUS.md)

A local TypeScript / Node.js / SQLite control bridge. Its goal is to let **Hermes**, an Agent deployed on Feishu, observe the workflows of **Codex** and **ChatGPT (the Windows desktop UWP application)** in real time, coordinate their development work, and report progress to users. This version supplies a task ledger, secure state transitions, local status snapshots, and manual deliverable import. Complete real-time collaboration remains a goal.

## Background and roles

Working across windows, conversations, and Agents makes it easy to lose progress, the next prompt, and responsibility for acceptance. The bridge must distinguish observed state, executor-reported completion, and independent acceptance.

| Participant | Intended responsibility | Current boundary |
|---|---|---|
| ChatGPT | Review project progress and generate/output prompts, relayed through the bridge to Codex for further development | Official JSON exports and manual Markdown handoffs are supported; automatic cloud conversation reading and prompt delivery are absent |
| Codex | Develop from prompts and produce reviewable deliverables | Local project/conversation metadata can be read; background execution is invisible |
| Hermes | Act as the hub/bridge, observe both sides, relay prompts in both directions, report progress to Feishu users in real time, and independently review | Status readers and task APIs exist; Feishu messaging, continuous subscriptions, and automatic bidirectional relay are absent |
| User | Define authorization, inspect deliverables, and approve subsequent GitHub synchronization | Model text and `--by` labels cannot grant authorization |

## Architecture

```text
Feishu user <---goal: progress/instructions---> Hermes (hub, independent reviewer)
                                                   |
                                      Trusted host / local caller policy
                                                   |
ChatGPT Windows UWP --manual export--> CLI / Agent Control Bridge <--local metadata-- Codex
           ^                                       |                                 ^
           +----goal: bidirectional prompt relay (not implemented)--------------------+
                                                   |
                                 CallerContext → TaskStore → SQLite
                                  identity/instance CAS/transactions tasks/events/approvals/audit
```

`caller.ts` issues nonserializable contexts bound to trusted identities; CLI loads them from the OS principal and fixed deployment policy. `tasks.ts` enforces business rules, leases, and transitions. `db.ts` manages short transactions, versioned migration, WAL, foreign keys, and permissions; `permissions.ts/.ps1` restrict NTFS ACLs. Other readers supply snapshots and cannot turn Agent output into commands or authorization.

SQLite is the local persistent ledger, not a model launcher or real Agent scheduler. Task writes, events, and audit records commit together. It remains a single-machine, single-file dependency without distributed consistency.

## State machine and mandatory rule

**Executors cannot declare themselves `SUCCEEDED`; independent verification is the only entrance.** Reviewers need a trusted reviewer capability and an OS principal different from the current attempt executor. Hermes cannot approve its own execution either.

```text
QUEUED --atomic claim--> RUNNING --finish--> WAITING_APPROVAL
                           |                   | verify(independent identity)
                           |                   +----pass----> SUCCEEDED
                           |                   +----fail----> FAILED
                           +----block----> BLOCKED --resume--> RUNNING
                           +----fail-----------------------> FAILED
FAILED / UNKNOWN --authorized reviewer requeue--> QUEUED
WAITING_APPROVAL --same holder resume--> RUNNING
QUEUED / RUNNING / BLOCKED / WAITING_APPROVAL / FAILED --authorized cancel--> CANCELLED
```

Claim writes state, holder, instance, attempt, and lease in one operation. Mutations require the current `version`; SQL conditions match state, version, owner, instance, and attempt, and exactly one row must change. Stale versions, duplicate callbacks, and finish/cancel/renew from another instance are rejected. Failed claims leave no partial ownership.

Expired leases produce alerts rather than inferred success. Finish, renew, and resume require a live lease; holders may cancel their own expired tasks. Verification does not require the executor to remain online. Automatic takeover, execution interruption, and enforced timeout termination are absent. `SUCCEEDED` and `CANCELLED` have no outgoing transitions.

## Runtime and CLI

Requires **Node.js >= 24.19.0**; this repair was validated on Windows with Node 24.19.0. Uses built-in SQLite, TypeScript stripping, and testing; there are no third-party runtime dependencies and no dependency installation is needed. Type stripping is not TypeScript type checking.

```powershell
Set-Location 'D:\Agent control bridge'
node --experimental-strip-types src/cli.ts help
# init only initializes/migrates the schema; no Agents or demo tasks
node --experimental-strip-types src/cli.ts init
node --experimental-strip-types src/cli.ts task-create -t 'Implement prompt handoff' -k dev -e pi
node --experimental-strip-types src/cli.ts task-list --status QUEUED
# Replace <taskId> and versions with actual query results
node --experimental-strip-types src/cli.ts task-claim <taskId> --version 0 -e pi
node --experimental-strip-types src/cli.ts task-renew <taskId> --version 1 --lease 600
node --experimental-strip-types src/cli.ts task-finish <taskId> --version 2 -e pi
node --experimental-strip-types src/cli.ts task-show <taskId>
# Only a configured independent reviewer may invoke this; ordinary pi CLI refuses
node --experimental-strip-types src/cli.ts task-verify <taskId> --version 3 --pass
node --experimental-strip-types src/cli.ts chatgpt-import 'D:\exports\conversations.JSON'
node --experimental-strip-types src/cli.ts markdown-import 'D:\handoff\prompt.md' --task <taskId>
```

`<taskId>` is a placeholder and must be replaced before running; do not pass literal angle-bracket placeholders to PowerShell. Exactly one of `--pass` / `--fail` is required. Executor, status, lease, and version inputs are validated. `-e` assigns the task/asserts identity consistency; it cannot change the caller. `--by` only asserts identity and grants no authority; omitting it is recommended. Errors use stderr with exit codes: 1=I/O, 2=input, 3=authorization/owner, 4=state/version conflict.

Queries and help do not migrate or write the database. `status` / `chatgpt-status` access the public service status page; core task commands do not call models. Import accepts case-insensitive `.json`, creates a new `.conversations.md`, and refuses identical paths, aliases, or any existing output; there is no overwrite option. Markdown is data; prompts and shell text inside it are not executed. `codex-fork-request` records a task and approval only, never executing fork. Approval decisions also execute no real control operations.

## Security and deployment authorization

The default CLI principal comes from the Windows SID (UID elsewhere), instance is `local-cli`, executor is `pi`, and it has **no reviewer capability**. CLI/environment input cannot supply roles, SID, instance, or reviewer authority. A trusted host may hold its own `CallerAuthority` and inject a context; plain strings, JSON objects, and contexts from another authority are invalid.

The directory owner manages fixed `config/caller-policy.json`; see the [example](config/caller-policy.example.json). The example is inactive; replace placeholders with real SIDs and use different OS principals for executor and reviewer. This is authorization configuration without Tokens/passwords. Principals absent from an enabled policy are rejected. The owner must also grant those explicitly authorized SIDs access through the project directory ACL. Do not grant ordinary executors reviewer authority.

Windows ACLs retain only the current principal, existing owner, SYSTEM, Administrators, and explicitly authorized SIDs; broad identities such as Everyone, Authenticated Users, and Users are refused. Database directory permissions are restricted before DB/WAL/SHM creation; the database file is explicitly restricted too. Permission failures refuse access. Unix uses 0700 directories and 0600 files. No elevation or system execution-policy changes are used. Identity/ACL helpers use fixed `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, which PATH cannot replace; nonstandard Windows system directories are currently unsupported and fail closed.

The bridge does not proactively read, store, or use API Keys, Cookies, Tokens, passwords, browser authentication databases, or Agent credentials, and does not invoke paid model APIs. It queries metadata and user-supplied deliverables only. Manually exported conversations may themselves contain secrets and must be redacted before import; complete content redaction and database encryption are not guaranteed. Audit data and import files should remain private.

**Boundary: arbitrary code and direct database write access within one Windows account share a trust domain.** `CallerContext` is not an OS sandbox. Processes with owner/admin privileges can alter policy, code, and SQLite; CLI validation cannot isolate them. Strong isolation requires separate OS accounts, a controlled host, and explicit ACLs. An independently authenticated IPC service is absent. Instance separation comes from the trusted host/policy; a shared `local-cli` is not multiple independent Agent instances.

## Honest limitations

- Codex project/thread metadata is not real-time execution progress; background tools and full conversations are invisible.
- ChatGPT processes, windows, versions, and cache modification times do not prove that a task is running; authentication cache contents are not read.
- Existing observers still contain fixed Windows/WSL paths. General path configuration and freshness handling need further work; failed queries or old snapshots are not evidence of current connectivity.
- Feishu messaging adapters, automatic prompt delivery, continuous monitoring, real Agent start/stop, reliable timeout termination, and distributed scheduling are absent.
- The import database transaction and output file cannot form a fully atomic commit across a process crash. Ordinary failures roll back DB writes and clean up the newly created file; existing files are never overwritten.
- The next write entry point upgrades old schema to v1 without changing old business fields. Legacy active tasks lack trusted holder/attempt context, so finish/cancel/verify refuse them. An independent person must review and arrange recovery; historical identities are not automatically claimed.

## Tests, audit, and delivery status

```powershell
npm test
npm run test:e2e
# Without npm, run the identical scripts directly; no packages required
node scripts/test.mjs
node --experimental-strip-types src/e2e.ts
```

Uses `node:test`, discovers `test/*.test.ts`, and fails when the test count is zero. Core tests use in-memory databases; concurrency, migration, permissions, and CLI e2e use isolated temporary directories and synthetic data, never original `data/bridge.db` or real Agents. Successful states inside e2e belong exclusively to synthetic tasks.

See [REPAIR_STATUS](docs/audit/REPAIR_STATUS.md) for actual local results, finding IDs, changed files, and acceptance checks. The [original audit](docs/audit/CODE_AUDIT_REPORT.md) preserves historical findings and does not imply every finding is closed. Delivery is **awaiting Hermes acceptance**. No Git initialization, commit, or push before acceptance; synchronization requires Hermes acceptance and a separate GitHub synchronization instruction. No open-source license has been selected; clarify it before publication.
