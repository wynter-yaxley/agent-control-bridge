---
name: agent-control-bridge
description: Read, find, create and message ChatGPT and Codex desktop conversations with the ACB MCP tools (mcp_acb_*). Each tool is independent - use only the ones the task needs. Load it for any task that involves ChatGPT, Codex, a workspace or ACB.
version: 0.5.0
license: MIT
metadata:
  hermes:
    tags: [mcp, codex, chatgpt]
---

# Agent Control Bridge

ACB exposes the ChatGPT / Codex desktop app as independent tools. Each tool does one thing; there is no required order or workflow. Use exactly the tools the user's request needs: to look at a conversation, read it; to get work done in one, send to it. Do not write Python, PowerShell or Node scripts, or terminal commands, to drive ChatGPT or Codex: the tools already do it.

## Tools

**Codex conversations** (background, no window; work without the ChatGPT window):

- `acb_codex_list` (`limit?`, `cwd?`, `cursor?`): recently updated conversations. `acb_codex_find` (`searchTerm`): full-text search.
- `acb_codex_read` (`threadId`, `turns?` 1-20): prompt and reply text of the newest turns. Read-only: nothing is sent or resumed.
- `acb_codex_send` (`threadId`, `prompt`): send one prompt, get the final reply. `acb_codex_create` (`cwd`, `title`, `prompt?`): new conversation (its first prompt is answered). `acb_workspace_create` (`name`, `path?`): directory registered as a Codex project; repeating it is harmless.

**ChatGPT conversations**:

- `acb_gpt_list`: conversations of the desktop inventory. `acb_gpt_read` (`conversationId`, `turns?` 1-10, `cursor?`): prompt and reply text by ID; `nextCursor` reads older turns. Both touch no window. A reply the transcript keeps only as a reference comes back as `reply: null, replyInWindowOnly: true`; to get it, call `acb_gpt_read` with `window: true` (shows the chat like `acb_gpt_open`, then reads the newest reply; never types).
- `acb_gpt_open`, `acb_gpt_create` (unique title; `project` = an existing ChatGPT project name), `acb_gpt_send`: use the ChatGPT window (see below).

**Desktop**: `acb_threads` (sidebar inventory of both kinds), `acb_projects`, `acb_status` (self-check).

## Rules

- Prefer reading to sending. A question about what a conversation said is answered with a read tool, never by sending a prompt.
- Reuse an existing conversation (list, find, read) before creating one. Create only when the user asks or nothing fits.
- Send only what the user asked to send, to the conversation they meant. To pass one conversation's reply to another, read it, then send it verbatim; ACB never chains conversations by itself.
- Report briefly: conversation IDs, the reply or result, open items. No long logs or raw tool output.

## Foreground and the user's keyboard

- `--allow-foreground-input` authorizes ACB to restore a minimized, verified ChatGPT window and try to activate it once before typing. ACB waits for restoration to complete, then requests focus once on the sole usable composer inside that verified window without writing or clearing its draft; it still requires the actual foreground handle to match. Tell the user that ChatGPT may come to the front and that switching away stops input. If the app's only window is minimized (its UI cannot be read), ACB first restores it once to identify it, and still refuses a Codex or unidentified window. Without this authorization, ACB never restores, activates or types; an identical draft can only be submitted while ChatGPT is already in front.
- ACB verifies the actual Windows foreground handle and composer focus. On `FOCUS_REQUIRED` (Windows refused activation, or the user switched window/focus), stop. Do not loop or try to take focus back. Partial text may remain in the composer and is not submitted.
- Report `diagnostics.focusReason` (`activationDenied`, `foregroundChanged`, `composerFocusLost`, or `foregroundNotAuthorized`), `targetHandle`, `foregroundHandle`, and `typedLength` when present. The length counts the completed input prefix in UTF-16 units. A nonzero length proves input started; activation denial before input is a different case. Do not clear the draft after focus loss or treat missing evidence as a successful interruption test.
- Include `diagnostics.activation` when present. Its `requestCompleted` only means the UIA focus call returned, not that activation succeeded; `restoreAccepted` means the asynchronous restore was accepted, and `hresult` identifies an exception. Do not retry activation based on these fields.
- GPT creation uses only the verified ChatGPT window's left-sidebar New chat button. Success requires the exact initialization marker's ID, completion, and the new title read back by ID, listed for that same ID in the inventory and shown on the app page. The native sidebar inventory can take about a minute to reflect a rename; ACB waits within the original timeout budget, so do not interrupt and repeat creation. If an error has `status: "partial"`, report `conversationId`, `requestedTitle`, `title` and `stage`; read that conversation before further action. Do not call create again or resend an initialization marker, even if its title is still New chat.
- Codex tools and the list/find/read tools run in the background and do not disturb the user.

## When a tool fails

Read the `code`, act once, and stop if it fails again:

| Code | Meaning | Do |
|---|---|---|
| `TIMEOUT` | The reply is not finished | Later call again with the **same** prompt: it returns the reply and is not resent. Never reword and resend. |
| `CONFLICT` | The conversation is busy, or the user has a draft | Wait, or ask the user. |
| `PROVENANCE` | Conversation identity, title uniqueness, persistence or project cannot be confirmed | Report the known ID and any partial completion. Do not guess or create a replacement. The native inventory has a host limit of 50 non-pinned chats and no pagination; sidebar sorting can keep a new chat outside it. |
| `STATE` | Blank-page recognition or exact composer text verification failed | Report the stage and diagnostics; do not resend. |
| `FOCUS_REQUIRED`, `AUTH` | Activation/focus failed, or foreground input is not authorized | Stop and tell the user; never repeatedly activate the window. |
| `OWNER`, `DEPENDENCY`, `CONFIG`, `IO`, `IPC_CONFIG` | An app is not running or not found, or the desktop app refused the request | Call `acb_status` once and pass its `fix` (and `nativeError`, if any) to the user. |
| `EXECUTION` with `approvalsDeclined` | Codex needed an approval | Tell the user to approve in the Codex app; the bridge never approves. |

Investigate only the direct cause. Do not write diagnostic scripts, run broad tests or change ACB itself.

## Limits

- ChatGPT projects cannot be created, and existing chats cannot be moved into a project: ask the user to do it in ChatGPT. A new chat can start inside an existing project (`project` argument).
- Developing anything beyond the user's task (new tools, changes to ACB, extra features) needs the user's approval first.
