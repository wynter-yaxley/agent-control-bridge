# Changelog

Versions follow Semantic Versioning. A GitHub Release requires an accepted version tag; the changes below are development delivery, pending independent acceptance.

## Unreleased

- Windows native worker input-rejection tests allow 15 seconds for cold PowerShell startup after the PR's clean-install CI exceeded the previous 5-second test budget. Production budgets remain unchanged. Native creation notes now distinguish catalog advertisement from the real reachable `create_project` handler; silent fresh-workspace and ordinary GPT creation remain blocked.
- Publication hygiene checks scan the full ancestry of the published branch and distinguish uppercase Windows machine markers from lowercase desktop module filenames. Unpublished local history remains unchanged.
- Native provisioning capability diagnostics fingerprint the signed desktop catalog and verify an existing local saved project's exact identity, name and directory through a fixed read-only inventory call. Creation, ordinary mode and thread membership remain unverified. The unreleased ProjectHost contract now requires native-desktop evidence and independent Codex native membership on creation and reconciliation; isolated App Server or missing surface evidence cannot produce READY.
- Experimental official project API diagnostic creates two isolated projects and three-plus-one dormant Codex conversations with explicit project IDs, tests idempotency, exact Unicode rename and cold readback. These primitives passed locally; dormant thread listings remain incomplete and native desktop registration is unverified. Diagnostics disable their own default plugin sync and use bounded graceful shutdown; identity-only checks explicitly remain PARTIAL.
- Trusted ordinary GPT identity readback can use its exact ID, ordinary mode and exact project title with the protected bridge association; a shared native Codex project ID is not required on the GPT surface. Canonical Codex project reads opt into experimental fields and still reject missing evidence. Host model/effort and generation proof remain required for execution.
- Controller-scoped `acb_project_reconcile` rechecks only recorded complete uncertain bundles, without replacement creation, caller-supplied identities or execution. Host embedding types are exported. Catalog discovery retains new schemas while the native transport remains read-only.
- Priority-one verification separates trusted project identity creation from GPT generation parameters; missing actual GPT model/effort still refuses production generation. Conversation registration rejects shared native workspace IDs, reused GPT IDs and overlapping GPT/Codex identities within the same transaction.
- Isolated Codex provisioning diagnostic creates dormant threads in a new Codex home, compares model/effort receipts, checks exact IDs/cwd after reconnect and tests stored settings without overrides. Named zero-turn thread IDs could be read after reconnect locally; stored-settings/listing checks did not pass. Skipped checks remain PARTIAL; temporary cleanup errors are reported. No production native workspace or ordinary GPT creation host is installed.
- Windows native desktop read-only client and packaged diagnostic, with the current `callerSource` request field, hidden verified pipe worker, process-instance binding, bounded frames and absolute budgets. Catalog/current-task/specified ChatGPT backing reads passed locally without observed foreground changes; ordinary mode, actual generation parameters, native project creation and complete background workflow remain unverified. No production host capability or arbitrary native RPC proxy is installed.
- Controller/project-scoped `acb_native_target_check` reads the registered Codex/GPT pair; MCP input cannot override GPT identity, caller origin or native method. Installed Hermes SDK probes verify discovery and deny unknown targets without opening a desktop pipe.

- Official Codex app-server execution adapter with hidden stdio, independent native target/exclusion checks, scoped turn events, completed-status receipts and bounded interrupt attempts. Failed, rerouted or uncertain turns are never replayed; interactive grants are refused. Its own bridge MCP registration is disabled in the child to prevent recursive scheduling.
- Packaged read-only Codex target-check CLI and project/controller-scoped MCP tool, plus typed embedding exports. Canonical project assignment can be unavailable even when desktop grouping exists; it never grants execution authority. Isolated workflow tests cover the app-server adapter through independent review and notification receipts; production ordinary GPT bindings remain missing.

- Existing Hermes gateway integration library for verified Feishu text events, with trusted user/chat/project routing and message-ID deduplication. No competing Bot event consumer is started. Named Feishu application secrets/tokens are rejected before requirement persistence.
- Schema 4 adds durable notification delivery fencing. Unknown/rejected sends stop automatic replay; committed receipts survive acknowledgement failure. A read-only MCP notification status tool exposes unresolved sends. Existing databases still require an explicit migration.
- Official Codex app-server readiness diagnostic uses hidden stdio and read-only account/model requests; no login, credential export, new conversation or model turn. An isolated Python probe verifies the installed Hermes MCP SDK against the compiled bridge without altering its live profile.
- MCP connections must match the bridge caller context; accepted/rejected/cancelled task state is reflected in request queries after independent review.

- Feishu authentication/Bot diagnostic, with official API origins and bounded requests from unified configuration. Credential input is stdin only; tokens and raw API diagnostics are omitted from results. Read-only by default; an explicit user-authorized target permits one deduplicated test message. No Agent or incoming-event consumer is started.

- 0.2.0 development: stdio MCP server with strict schemas, OS-policy identities, scoped request queries and receipt-based notification delivery. No source-import or arbitrary role-grant tools.
- Durable serial background requests and project provisioning, ordinary GPT host capability/readback contracts, and a separate Codex runner that claims before execution. Missing native GPT/workspace bindings return BLOCKED; no browser/profile fallback is implemented.
- Prompt generation and task-attempt dispatch fencing; cross-project session creation is rejected. Background Codex uses stdin and requires a completed turn; timeout/identity drift retain uncertain outcomes.
- Controller capability is separate from reviewer authorization. Legacy trusted Hermes reviewer policies retain controller compatibility; new policies can explicitly grant controller without review.
- Schema 3 adds request/run/provisioning records, exact selected Prompt, native project identity, progress events and receipt outbox. Existing databases require backup plus explicit migration; this development run does not migrate business data.
- Watcher callback failures are replayable; uncooperative inspections and notification callbacks are bounded. Host callback acceptance is distinct from real Feishu delivery acknowledgement.
- CLI regression tests run without the live deployment policy; invalid OS identities/policies return AUTH. Codex diagnostics omit private stderr, and fixtures use synthetic executable names.
- Windows Node/Python capability tests use file URLs and hidden subprocesses; generator failures fail the test rather than being counted as skips.

- Desktop CDP delivery now requires bridge-registry session binding, app-observed project ownership, and local Codex execution preflight corroborated by Codex app metadata and workspace path; cloud Work and unknown states fail closed, with a fresh pre-submit check.
- Added bounded text-only clipboard paste with exact editor readback and clipboard restoration for desktop senders; ChatGPT rename uses native input/textarea setters and bubbling input events, then requires a human physical Enter handoff and separate target-bound title verification.
- Added read-only desktop guard diagnostics and Mock regressions for route drift, unsupported/verified repair, rename commit failure, clipboard mismatch, cloud routing, and execution-state changes.
- Windows ACL verification uses SID rules and .NET file APIs, avoiding module auto-loading and account-name resolution in controlled environments; failures expose fixed stages only.
- Desktop sends verify prompt content exactly, including whitespace, and refuse to create an unregistered GPT conversation when its editor is missing; three Mock regressions added.

- Validated portable configuration, event-driven watcher with polling fallback and overdue blocked-work notifications.
- Trusted prompt provenance, project/workspace/conversation identity and GPT conversation naming checks.
- Controlled SQLite migration, independent review boundary, CLI contracts and bounded inputs.
- Desktop source migration with default-deny focus/input safeguards and incident-bound recovery authorization.
- Complete isolated Mock workflow, clean-install tests, bilingual user guides, vector architecture and cross-platform CI.
- MIT license and publication/credential hygiene checks.

## 0.1.0 — baseline

- Local task ledger, CAS ownership, transactions and independent acceptance protections.
- This heading records the package baseline; no GitHub Release/tag is claimed.
