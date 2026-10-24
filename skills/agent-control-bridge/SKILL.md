---
name: agent-control-bridge
description: Read, find, create and message ChatGPT and Codex conversations of the ChatGPT desktop app with the ACB MCP tools (mcp_acb_*). Each tool is independent - use only the ones the request needs. Load it for any task that involves ChatGPT, Codex, a workspace or ACB.
version: 0.5.0
license: MIT
metadata:
  hermes:
    tags: [mcp, codex, chatgpt]
---

# Agent Control Bridge

ACB exposes the ChatGPT desktop app (ChatGPT chats and Codex tasks) as independent MCP tools. Each tool does one thing. There is no required order and no workflow: call exactly the tools the user's request needs. Never write scripts or terminal commands to drive ChatGPT or Codex; the tools already do it.

## Pick the tool

| The user wants to... | Call |
|---|---|
| know what a conversation said | `acb_codex_read` / `acb_gpt_read` |
| find a conversation | `acb_codex_list` (by `cwd`), `acb_codex_find` (keyword), `acb_gpt_list`, `acb_threads` (both kinds) |
| check whether Codex finished | `acb_codex_read` (look at `status` of the newest turn) |
| ask Codex to do something | `acb_codex_send` |
| ask ChatGPT something | `acb_gpt_send` |
| start a new conversation | `acb_codex_create` (needs a folder; `acb_workspace_create` makes one), `acb_gpt_create` |
| show a ChatGPT chat on screen | `acb_gpt_open` |
| diagnose a failure | `acb_status` |

## Tools

**Codex** (background, no window, works without the ChatGPT window):

- `acb_codex_list(limit? 1-100, cwd?, cursor?)` -> `threads[{threadId, name, preview, cwd, status, updatedAt}]`, `nextCursor`.
- `acb_codex_find(searchTerm)` -> `[{threadId, name, cwd}]`.
- `acb_codex_read(threadId, turns? 1-20)` -> conversation info, `hasMore`, `turns[{turnId, status, prompt, reply, truncated, error}]` oldest first. Nothing is sent or resumed.
- `acb_codex_send(threadId, prompt)` -> `{reply, turnId, alreadySent, approvalsDeclined}`. Waits up to 240 s for the final reply.
- `acb_codex_create(cwd, title, prompt?)` -> new conversation; its first prompt (a short readiness check if omitted) is sent and answered so it is saved.
- `acb_workspace_create(name, path?)` -> folder registered as a Codex project; repeating it returns the same project.

**ChatGPT**:

- `acb_gpt_list()` -> `[{conversationId, title, projectId}]`. No window.
- `acb_gpt_read(conversationId, turns? 1-10, cursor?, window?)` -> `turns[{turnId, status, prompt, reply, replyInWindowOnly, ...}]` oldest first, `nextCursor` for older turns. Without `window` no window is touched.
- `acb_gpt_open(conversationId)` -> shows the chat (`navigation`: `current` or `sidebar`). Clicks, never types.
- `acb_gpt_create(title)` -> `{conversationId, title}`. Types into the window.
- `acb_gpt_send(conversationId, prompt)` -> `{reply, turnId, alreadySent, uiIdentity, navigation}`. Types into the window, waits up to 240 s.

**Desktop**: `acb_threads()` (sidebar inventory of both kinds), `acb_projects()`, `acb_status()`.

## Rules

1. **Read rather than send.** A question about what a conversation said, or whether a task is done, is answered with a read tool. Never send a prompt just to find something out.
2. **Never resend.** After `TIMEOUT`, call the same send tool later with the **identical** prompt: ACB returns the reply and does not send again (`alreadySent: true`). Never reword, shorten or "nudge" a prompt that may already have been sent. To check progress meanwhile, use `acb_codex_read` / `acb_gpt_read`.
3. **Send only what the user asked, to the conversation they meant.** To pass one conversation's reply to another, read it, then send it verbatim. ACB never chains conversations by itself.
4. **Reuse before creating.** Find the existing conversation first; create one only when the user asks or nothing fits. ChatGPT titles must be unique (`CONFLICT` otherwise).
5. **Partial creation.** If `acb_gpt_create` fails with `status: "partial"`, report `conversationId`, `requestedTitle`, `title` and `stage`, then read that conversation. Never call create again or send its initialization marker yourself, even if its title is still "New chat".
6. **One send at a time.** Don't send to the same conversation twice in parallel. ACB serializes sends and window operations; reads may run any time.
7. **Approvals are the user's.** ACB declines every Codex command or file approval. If `approvalsDeclined > 0` or the turn failed for lack of approval, tell the user to approve in the app; never try to work around it.
8. **Don't modify ACB or write helper scripts.** Investigate only the direct cause of a failure. Anything beyond the user's task needs their approval.

## The ChatGPT window

- `acb_gpt_send`, `acb_gpt_create` (and `acb_gpt_open`, `acb_gpt_read` with `window: true`, when they must click) use the ChatGPT window. With `--allow-foreground-input` ACB brings it to the front once and types. **Tell the user before such a call** that ChatGPT will come to the front and that they should not type until it finishes.
- A minimized window is restored first (without focus) and must then be identified as a ChatGPT-mode window; a Codex-mode or unidentified window is refused (`OWNER`). Ask the user to show the window in ChatGPT mode.
- On `FOCUS_REQUIRED` stop. Never retry activation in a loop or try to take focus back. Report `diagnostics.focusReason` (`activationDenied`, `foregroundChanged`, `composerFocusLost`, `foregroundNotAuthorized`) and `typedLength`; a nonzero length means some text may remain in the input box, unsent. Do not clear it yourself.
- `uiIdentity: "titleOnly"` means the page shows no ID and the chat was identified by its unique title plus the app's inventory. That is the normal case.
- The app's transcript usually keeps a ChatGPT reply only as a reference. `replyInWindowOnly: true` with `reply: null` means: call `acb_gpt_read` again with `window: true` (newest turn only; it may switch the shown chat). Never report the reference text as the reply.

## Errors

Every failure is `{"ok": false, "code", "message", ...details}`. Act once on the code; if the same failure repeats, stop and report.

| Code | Meaning | Do |
|---|---|---|
| `TIMEOUT` | Reply not finished (the task continues) | Later, call again with the identical prompt; or read to check progress |
| `CONFLICT` | Busy conversation, a user draft in the input box, duplicate title | Wait or ask the user; pick a unique title |
| `PROVENANCE` | The target can't be identified (duplicate title, not in the latest 50, page changed) | Report it; ask the user to open the chat in the app. Never guess another ID |
| `STATE` | The page didn't look as expected (blank chat, input text mismatch) | Report `stage` and diagnostics; don't resend |
| `FOCUS_REQUIRED`, `AUTH` | Focus lost / activation refused, or foreground input not authorized | Stop and tell the user (see above) |
| `OWNER` | App not running, or no ChatGPT-mode window | Ask the user to open the app in ChatGPT mode |
| `CONFIG`, `DEPENDENCY`, `IO`, `IPC_CONFIG` | Codex not found, app not responding, ChatGPT signed out, or the app refused a request | Call `acb_status` once; pass its `fix` (and `nativeError` if present) to the user |
| `EXECUTION` | Codex turn failed, or an approval was declined | Report the message and `approvalsDeclined` |
| `INPUT` | Invalid argument (bad ID, too long, wrong conversation kind) | Fix the argument; `acb_gpt_read` is for ChatGPT, `acb_codex_read` for Codex |

## Limits

- The app lists only the latest 50 conversations plus pinned ones; older chats can't be targeted until the user opens them.
- ChatGPT has no navigation by ID: a chat is reached only if it is shown or has a unique sidebar title.
- ACB can't create ChatGPT projects or move chats into them, switch the window's mode, or approve Codex actions.
- Sends wait at most 240 s per call; Codex tasks may take longer (see `TIMEOUT`).

## Reporting

Keep it short: which conversation (ID and title), the reply or result, and anything the user must do. No raw tool output or long logs.
