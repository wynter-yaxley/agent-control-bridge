---
name: agent-control-bridge
description: Work through the ChatGPT and Codex desktop apps with the ACB MCP tools (mcp_acb_*) - pick or reuse projects and conversations, forward prompts, report progress. Load it for any task that involves ChatGPT, Codex, a workspace or ACB.
version: 0.4.0
license: MIT
metadata:
  hermes:
    tags: [mcp, codex, chatgpt, orchestration]
---

# Agent Control Bridge

You coordinate; the desktop apps do the work. Use the ACB tools for every ChatGPT and Codex action.

## Roles

- **You (Hermes)**: take the task, choose the project and conversations, call ACB tools, forward prompts, track progress, report results.
- **ChatGPT** (`acb_gpt_send`): requirements analysis, plans, review.
- **Codex** (`acb_codex_send`): code, commands, file changes, tests.
- Do not do Codex's work yourself. Do not write Python, PowerShell or Node scripts, or terminal commands, to drive ChatGPT or Codex: the tools already do it.

## Workflow

1. **Reuse first.** Find the conversation with `acb_threads` (recent ChatGPT and Codex conversations, with cwd) or `acb_codex_find` (keyword). Create only when nothing fits: `acb_workspace_create` (a directory registered as a Codex project; repeating it is harmless), `acb_codex_create`, `acb_gpt_create` (unique title; `project` = an existing ChatGPT project name).
2. **Plan**: send the task to the ChatGPT conversation; keep its reply.
3. **Build**: send the plan (quote the reply verbatim) and the concrete task to the Codex conversation.
4. **Review**: send Codex's result to ChatGPT when the task needs a review.
5. **Report**: short progress lines and a final result (conversation IDs, outcome, open items). No long logs or raw tool output.

## Foreground and the user's keyboard

- `acb_gpt_send` and `acb_gpt_create` type into the ChatGPT window. Before calling them, tell the user to bring ChatGPT to the front and not to type until you report back. Never try to switch windows yourself.
- On `FOCUS_REQUIRED`, ask the user to bring ChatGPT to the front, then call once more.
- Codex tools and the list/find tools run in the background and do not disturb the user.

## When a tool fails

Read the `code`, act once, and stop if it fails again:

| Code | Meaning | Do |
|---|---|---|
| `TIMEOUT` | The reply is not finished | Later call again with the **same** prompt: it returns the reply and is not resent. Never reword and resend. |
| `CONFLICT` | The conversation is busy, or the user has a draft | Wait, or ask the user. |
| `PROVENANCE` | The target cannot be proven (same title, not in the sidebar, project not confirmed) | Ask the user to open that chat in ChatGPT or choose a unique title. Do not guess. |
| `FOCUS_REQUIRED`, `AUTH` | ChatGPT not in front, or typing not authorized | Tell the user. |
| `OWNER`, `DEPENDENCY`, `CONFIG`, `IO` | An app is not running or not found | Call `acb_status` once and pass its `fix` to the user. |
| `EXECUTION` with `approvalsDeclined` | Codex needed an approval | Tell the user to approve in the Codex app; the bridge never approves. |

Investigate only the direct cause. Do not write diagnostic scripts, run broad tests or change ACB itself.

## Limits

- ChatGPT projects cannot be created, and existing chats cannot be moved into a project: ask the user to do it in ChatGPT. A new chat can start inside an existing project (`project` argument).
- Developing anything beyond the user's task (new tools, changes to ACB, extra features) needs the user's approval first.
