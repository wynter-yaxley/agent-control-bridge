# Changelog

Versions follow Semantic Versioning. Development delivery remains pending independent acceptance; formal Release requires an accepted tag and evidence.

## Unreleased

- Native read-only IPC reuses one serial Bridge-owned PowerShell worker, caches startup/type/signature work for the same live host and verifies every connected pipe identity. Cancellation/shutdown terminates only owned workers, without request replay.
- MCP descriptions are shorter; execution_result defaults to ID/hash/length summaries with includeContent for complete evidence. Existing names remain stable. Project operations return recorded resources; capabilities expose UI interaction requirements. Hermes defaults to 15 workflow tools with optional diagnostics.
- Preserve existing-instance UIA project/GPT creation and conversation execution/review. Real GPT provenance, complete message, exact identity and hash remain mandatory; unknown actual model/effort are null and do not block under the latest user policy.
- Original generation, execution receipts and GPT feedback support readback reconciliation without resend/rerun. Task delivery stays WAITING_APPROVAL; independent acceptance is the only success entry.
- Consolidate operational documentation in README; delete historical research/audits, experimental App Server project probes and second-profile prototypes. Retain current CDP dependencies, private runtime data and all owned-worktree changes.
- Node discovery already includes e2e/workflow; CI no longer repeats the subset. Clean-install checks compiled integration rather than rerunning the source matrix.
- Actual isolated GPT → native Codex → GPT feedback completed with UI intervention and recovery. Native initialization components were exercised; fully silent unattended operation, the new UIA Codex creation branch, and Hermes stdio/Feishu end-to-end remain unverified.

## 0.1.0 — baseline

- Local task ledger, CAS ownership, transactions and independent acceptance protections.
- This heading records the package baseline; no GitHub Release/tag is claimed.
