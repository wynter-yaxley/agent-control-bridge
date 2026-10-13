# Changelog

Versions follow Semantic Versioning. Development delivery remains pending independent acceptance; formal Release requires an accepted tag and evidence.

## Unreleased

- Synchronize original RUNNING_OBSERVED completion across task/run/request, check affected rows, and make completed reconciliation avoid duplicate feedback/notifications. Reject unrelated normal RUNNING recovery.
- Resume complete, unchanged, verified PENDING prompts after proven owner exit only when no dispatch/run exists; reuse the original prompt. Fix Windows missing-PID lookup so normal absence is not misclassified as query failure.
- Remove the fictitious Codex initialization-marker recovery contract. Preserve known formal thread IDs and native membership; lost IDs without a real original host receipt remain uncertain without probes or recreation.
- Retain CDP failure reasons during title-only UIA fallback and reduce the read-only Hermes sample timeout to its actual serial read budget (300 seconds). Latest live UIA observation was unavailable; no new live writes claimed.
- Add a minimal Windows composition entry: read-only MCP by default, protected ledger writes, and one separate durable worker. No implicit executor/GUI delegation or approval; missing real host bindings remain explicit blockers.
- Prefer current-instance CDP identity/body observation after listener/process/unique-target checks. Fall back to UIA titleOnly with null ID and no body, without repeated UUID scans. Existing-chat writes remain rejected where atomic exact targeting is unavailable.
- Permit only trusted-approved new blank ordinary-chat identity initialization with a unique non-engineering marker, native baseline/message/type/title correlation, and no retry on unknown outcome. Remove the unusable Codex UIA engineering fallback; native Codex creation requires a formal host callback.
- Recover dead/unknown process owners into original-operation reconciliation; retain resource phases and execution IDs, release unrelated GUI scheduling, and allow prepared backend tasks without a GUI/GPT host.
- Persist actual turn IDs immediately, renew leases during durable App Server execution, and observe original turns without resume/start or resending. Report RUNNING only with active-thread evidence; an unloaded saved inProgress turn remains uncertain. Bound individual RPC frames/requests rather than total task duration or cumulative event traffic.
- Separate protected Controller/Executor/Reviewer capabilities; remove inferred controller authority and overlapping review grants. Trusted target-bound command/file approval callbacks remain external; authentication requests are refused.
- Migrate explicitly to schema v6 for process ownership, GUI occupancy, project stages and explicit/default Codex routing. Add WAL-consistent online backup and integrity-checked restore to new files only; never overwrite an active ledger.
- Send GPT prompts once, wait for native completion, verify UI idle/message actions, reread final text and recheck turn/assistant identity. Persist completion evidence in existing audit/feedback records; uncertain results reconcile without resend.
- Default MCP entry is truly read-only (8 tools, existing current-schema ledger, no queue startup/migration/ACL changes). Hermes example follows this deployable fallback; protected write approval/executor binding is still external.
- Reuse the serial UIA worker with fresh window/elements and per-request mutex cleanup. One real read-only cold/hot sample: 1320/53ms. No new live writes or end-to-end acceptance.
- Move the same 37 CLI help contracts into the existing test, retaining demo/watch subprocess checks; remove the duplicate static-check process loop (measured 5780ms). Keep full history scans and both CI platforms.
- Default to README/CHANGELOG/AGENTS updates and PR/CI evidence; stop adding research, stage or test-summary Markdown without an explicit user request.

- User policy on 2026-10-13 permits normal current-instance UI interaction for native Workspace and ordinary GPT creation; fully silent creation is no longer an acceptance requirement. Per-run trusted authorization and existing identity/safety protections remain.
- Native read-only IPC reuses one serial Bridge-owned PowerShell worker, caches startup/type/signature work for the same live host and verifies every connected pipe identity. Cancellation/shutdown terminates only owned workers, without request replay.
- MCP descriptions are shorter; execution_result defaults to ID/hash/length summaries with includeContent for complete evidence. Existing names remain stable. Project operations return recorded resources; capabilities expose UI interaction requirements. Trusted writable embeddings retain the workflow tools; the default Hermes connection exposes 8 read tools.
- Preserve existing-instance UIA project/GPT creation and GPT review interfaces under exact identity requirements. GPT provenance, complete message and hash remain mandatory; unknown actual model/effort stay null and do not block.
- Original generation, execution receipts and GPT feedback support readback reconciliation without resend/rerun. Task delivery stays WAITING_APPROVAL; independent acceptance is the only success entry.
- Consolidate operational documentation in README; delete historical research/audits, experimental App Server project probes and second-profile prototypes. Retain current CDP dependencies, private runtime data and all owned-worktree changes.
- Node discovery already includes e2e/workflow; CI no longer repeats the subset. Clean-install checks compiled integration rather than rerunning the source matrix.
- A historical isolated GPT → native Codex → GPT loop required UI intervention/recovery. This round verified read-only title fallback and MCP connectivity; new GUI initialization, real delegated durable execution and Hermes/Feishu end-to-end remain unverified or blocked. Historical success does not establish current acceptance.

## 0.1.0 — baseline

- Local task ledger, CAS ownership, transactions and independent acceptance protections.
- This heading records the package baseline; no GitHub Release/tag is claimed.
