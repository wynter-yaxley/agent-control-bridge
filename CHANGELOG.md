# Changelog

Versions follow Semantic Versioning. A GitHub Release requires an accepted version tag; the changes below are development delivery, pending independent acceptance.

## Unreleased

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
