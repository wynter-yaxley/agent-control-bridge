# Changelog

Versions follow Semantic Versioning. Development delivery remains pending independent acceptance; formal Release requires an accepted tag and evidence.

## Unreleased

- Require exact public UI conversation identity before draft changes/submission; remove title-only navigation. Unknown identity rejects PROVENANCE, including initialization; the current desktop exposes no usable UI ID.
- Send GPT prompts once, wait for native completion, verify UI idle/message actions, reread final text and recheck turn/assistant identity. Persist completion evidence in existing audit/feedback records; uncertain results reconcile without resend.
- Default MCP entry is truly read-only (8 tools, existing current-schema ledger, no queue startup/migration/ACL changes). Hermes example follows this deployable fallback; protected write approval/executor binding is still external.
- Reuse the serial UIA worker with fresh window/elements and per-request mutex cleanup. One real read-only cold/hot sample: 1320/53ms. No new live writes or end-to-end acceptance.
- Move the same 37 CLI help contracts into the existing test, retaining demo/watch subprocess checks; remove the duplicate static-check process loop (measured 5780ms). Keep full history scans and both CI platforms.
- Default to README/CHANGELOG/AGENTS updates and PR/CI evidence; stop adding research, stage or test-summary Markdown without an explicit user request.

- User policy on 2026-10-13 permits normal current-instance UI interaction for native Workspace and ordinary GPT creation; fully silent creation is no longer an acceptance requirement. Per-run trusted authorization and existing identity/safety protections remain.
- Native read-only IPC reuses one serial Bridge-owned PowerShell worker, caches startup/type/signature work for the same live host and verifies every connected pipe identity. Cancellation/shutdown terminates only owned workers, without request replay.
- MCP descriptions are shorter; execution_result defaults to ID/hash/length summaries with includeContent for complete evidence. Existing names remain stable. Project operations return recorded resources; capabilities expose UI interaction requirements. Trusted writable embeddings retain the workflow tools; the default Hermes connection exposes 8 read tools.
- Preserve existing-instance UIA project/GPT creation and conversation execution/review. Real GPT provenance, complete message, exact identity and hash remain mandatory; unknown actual model/effort are null and do not block under the latest user policy.
- Original generation, execution receipts and GPT feedback support readback reconciliation without resend/rerun. Task delivery stays WAITING_APPROVAL; independent acceptance is the only success entry.
- Consolidate operational documentation in README; delete historical research/audits, experimental App Server project probes and second-profile prototypes. Retain current CDP dependencies, private runtime data and all owned-worktree changes.
- Node discovery already includes e2e/workflow; CI no longer repeats the subset. Clean-install checks compiled integration rather than rerunning the source matrix.
- Actual isolated GPT → native Codex → GPT feedback completed with UI intervention and recovery. Native initialization components were exercised; fully silent unattended operation, the new UIA Codex creation branch, and Hermes stdio/Feishu end-to-end remain unverified.

## 0.1.0 — baseline

- Local task ledger, CAS ownership, transactions and independent acceptance protections.
- This heading records the package baseline; no GitHub Release/tag is claimed.
