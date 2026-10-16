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

- `--allow-foreground-input` authorizes ACB to restore a minimized, verified ChatGPT window and try to activate it once before typing. Tell the user that ChatGPT may come to the front and that switching away stops input. No manual switching is required for each prompt. Without this authorization, ACB never activates or types; an identical draft can only be submitted while ChatGPT is already in front.
- ACB verifies the actual Windows foreground handle and composer focus. On `FOCUS_REQUIRED` (Windows refused activation, or the user switched window/focus), stop. Do not loop or try to take focus back. Partial text may remain in the composer and is not submitted.
- GPT creation uses only the verified ChatGPT window's left-sidebar New chat button. Success requires the exact initialization marker's ID, completion, and the new title read back by ID, listed for that same ID in the inventory and shown on the app page. The native sidebar inventory can take about a minute to reflect a rename; ACB waits within the original timeout budget, so do not interrupt and repeat creation. If an error has `status: "partial"`, report `conversationId`, `requestedTitle`, `title` and `stage`; read that conversation before further action. Do not call create again or resend an initialization marker, even if its title is still New chat.
- Codex tools and the list/find tools run in the background and do not disturb the user.

## When a tool fails

Read the `code`, act once, and stop if it fails again:

| Code | Meaning | Do |
|---|---|---|
| `TIMEOUT` | The reply is not finished | Later call again with the **same** prompt: it returns the reply and is not resent. Never reword and resend. |
| `CONFLICT` | The conversation is busy, or the user has a draft | Wait, or ask the user. |
| `PROVENANCE` | Conversation identity, title uniqueness, persistence or project cannot be confirmed | Report the known ID and any partial completion. Do not guess or create a replacement. The native inventory has a host limit of 50 non-pinned chats and no pagination; sidebar sorting can keep a new chat outside it. |
| `STATE` | Blank-page recognition or exact composer text verification failed | Report the stage and diagnostics; do not resend. |
| `FOCUS_REQUIRED`, `AUTH` | Activation/focus failed, or foreground input is not authorized | Stop and tell the user; never repeatedly activate the window. |
| `OWNER`, `DEPENDENCY`, `CONFIG`, `IO` | An app is not running or not found | Call `acb_status` once and pass its `fix` to the user. |
| `EXECUTION` with `approvalsDeclined` | Codex needed an approval | Tell the user to approve in the Codex app; the bridge never approves. |

Investigate only the direct cause. Do not write diagnostic scripts, run broad tests or change ACB itself.

## Limits

- ChatGPT projects cannot be created, and existing chats cannot be moved into a project: ask the user to do it in ChatGPT. A new chat can start inside an existing project (`project` argument).
- Developing anything beyond the user's task (new tools, changes to ACB, extra features) needs the user's approval first.
