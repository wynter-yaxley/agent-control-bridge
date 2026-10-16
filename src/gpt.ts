import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, asBridgeError } from './errors.ts';
import type { NativeChatPage, NativeProject, NativeThread } from './native.ts';
import type { UiResult } from './windows-ui.ts';

export interface GptDeps {
  native: {
    readThread(id: string): Promise<NativeChatPage>;
    listThreads(): Promise<NativeThread[]>;
    setThreadTitle(id: string, source: 'chatgpt', title: string): Promise<void>;
    listProjects?(): Promise<NativeProject[]>;
  };
  ui: { call(operation: 'snapshot' | 'chat-open-title' | 'chat-send' | 'chat-read-reply' | 'gpt-create', fields: { name: string; conversationId?: string; prompt?: string; project?: string }, signal: AbortSignal): Promise<UiResult> };
  timeoutMs: number;
  pollMs: number;
}
export type Navigation = 'current' | 'sidebar';
export interface GptReply { conversationId: string; title: string; turnId: string; reply: string; alreadySent: boolean; inputMode: 'drafted' | 'typed' | null; uiIdentity: 'uuid' | 'titleOnly'; navigation: Navigation }

type Turn = NativeChatPage['turns'][number];
const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();
const asks = (turn: Turn | undefined, prompt: string) => !!turn?.items.some(item => item.type === 'userMessage' && item.content.some(part => part.type === 'text' && !part.truncated && normalize(part.text ?? '') === prompt));
const done = (page: NativeChatPage, turn: Turn) => page.thread.status.type === 'idle' && turn.status === 'completed' && !turn.error && turn.items.some(item => item.type === 'agentMessage');
const signal = (deps: GptDeps) => AbortSignal.timeout(deps.timeoutMs + 60000);
async function until<T>(read: () => Promise<T | undefined>, ms: number, pollMs: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value !== undefined) return value; if (Date.now() >= deadline) return undefined; await delay(pollMs); }
}

/** Brings the target chat into the ChatGPT window. The app offers no ID navigation for
 * ChatGPT (navigate_to_codex_page does not apply), so a chat counts as located only when
 * its natively read title is unique in the native inventory (or the page shows its UUID);
 * a closed chat is opened by its single sidebar entry. Anything ambiguous fails. */
export async function openGpt(deps: GptDeps, id: string, title: string): Promise<Navigation> {
  const current = (await deps.ui.call('snapshot', { name: '' }, signal(deps))).snapshot;
  if (current?.title === title && current.ordinaryComposer && current.conversationId === id) return 'current';
  const inventory = await deps.native.listThreads(), same = inventory.filter(thread => thread.kind === 'chatgpt' && thread.title === title);
  if (same.some(thread => thread.id !== id)) throw new BridgeError('PROVENANCE', 'Another conversation has the same title; the target cannot be located reliably');
  // A target outside the recent inventory cannot be proven unique by title.
  const unique = same.length === 1;
  const showing = async () => {
    const view = (await deps.ui.call('snapshot', { name: '' }, signal(deps))).snapshot;
    return view?.title === title && (view.conversationId ? view.conversationId === id : true) && view.ordinaryComposer ? true : undefined;
  };
  // An already open chat counts only by UUID or by a title proven unique.
  if (current?.title === title && current.ordinaryComposer && (current.conversationId === id || (!current.conversationId && unique))) return 'current';
  if (!unique) throw new BridgeError('PROVENANCE', 'Target is not in the native inventory (host limit: 50, sidebar sort order, no pagination); its title cannot be proven unique');
  await deps.ui.call('chat-open-title', { name: title }, signal(deps));
  if (await until(showing, 10000, 500)) return 'sidebar';
  throw new BridgeError('PROVENANCE', 'Target conversation could not be opened reliably; open it in the ChatGPT app first');
}

/** Sends one prompt to an existing ChatGPT conversation and returns its reply. A
 * prompt that is already the latest turn is never sent again: its reply is read. */
export async function sendGpt(deps: GptDeps, conversationId: string, text: string): Promise<GptReply> {
  if (typeof text !== 'string' || !text.trim() || text.length > 65536) throw new BridgeError('INPUT', 'Prompt must be 1..65536 characters');
  const prompt = normalize(text);
  const before = await deps.native.readThread(conversationId);
  if (before.thread.kind !== 'chatgpt' || !before.thread.title.trim()) throw new BridgeError('PROVENANCE', 'Target is not a titled ChatGPT conversation');
  const title = before.thread.title, latest = before.turns[0], alreadySent = asks(latest, prompt);
  if (alreadySent && !done(before, latest)) throw new BridgeError('CONFLICT', 'This prompt was already sent and is still running; call again later to read the reply');
  if (!alreadySent && before.thread.status.type !== 'idle') throw new BridgeError('CONFLICT', 'GPT conversation is busy');
  const navigation = await openGpt(deps, conversationId, title);
  let inputMode: 'drafted' | 'typed' | null = null;
  if (!alreadySent) inputMode = (await deps.ui.call('chat-send', { name: title, conversationId, prompt }, signal(deps))).inputMode ?? null;
  // Native completion of a new turn carrying this exact prompt, in this conversation.
  const deadline = Date.now() + deps.timeoutMs;
  let turn: Turn | undefined;
  for (;;) {
    const page = await deps.native.readThread(conversationId);
    if (page.thread.kind !== 'chatgpt' || page.thread.title !== title) throw new BridgeError('PROVENANCE', 'Conversation changed during the send');
    const current = page.turns[0];
    if (asks(current, prompt) && (alreadySent || current.id !== latest?.id)) {
      if (current.error || ['failed', 'interrupted'].includes(current.status)) throw new BridgeError('EXECUTION', 'GPT turn failed or was interrupted');
      if (done(page, current)) { turn = current; break; }
    }
    if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Sent, but the reply is pending or the prompt did not reach this conversation; call again with the same prompt to read it (it is not resent)');
    await delay(deps.pollMs);
  }
  const body = await deps.ui.call('chat-read-reply', { name: title, conversationId, prompt }, signal(deps));
  const identity = body.conversationId === conversationId ? 'uuid' : !body.conversationId && body.identity === 'titleOnly' ? 'titleOnly' : null;
  if (!identity || body.completionVerified !== true || !body.body?.trim()) throw new BridgeError('PROVENANCE', 'Reply body could not be read from the target conversation');
  const after = await deps.native.readThread(conversationId);
  if (after.turns[0]?.id !== turn.id || !done(after, after.turns[0])) throw new BridgeError('PROVENANCE', 'GPT turn changed while reading the reply');
  return { conversationId, title, turnId: turn.id, reply: body.body, alreadySent, inputMode, uiIdentity: identity, navigation };
}

/** Starts a new ordinary ChatGPT chat with a one-time identity marker, finds its exact
 * UUID in the native inventory, then names it natively. Titles must be unique so later
 * location stays unambiguous. With `project`, the chat is started in that existing
 * ChatGPT project; the UI must read the project back before anything is sent. */
const oneLine = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n]/.test(value)) throw new BridgeError('INPUT', `${field} must be one line of 1..200 characters`);
};

export async function createGpt(deps: GptDeps, title: string, project?: string): Promise<{ conversationId: string; title: string; project?: { name: string; confirmedBy: 'ui' | 'ui+native'; projectId: string | null } }> {
  oneLine(title, 'Title');
  if (project !== undefined) oneLine(project, 'Project');
  const deadline = Date.now() + deps.timeoutMs;
  const budget = (cap: number) => Math.max(0, Math.min(cap, deadline - Date.now()));
  const inventory = await deps.native.listThreads();
  if (inventory.some(thread => thread.title === title)) throw new BridgeError('CONFLICT', 'A conversation with this title already exists; choose a unique title');
  const baseline = new Set(inventory.map(thread => thread.id));
  const prompt = `这是 Agent Control Bridge 新建对话的身份标记，不执行任务。请只回复：ACB_INIT_${randomUUID()}`;
  let id: string | null = null, actualTitle: string | null = null, stage = 'initialization', submitted = false, identityVerified = false;
  let verification: Record<string, unknown> | undefined;
  try {
    const sent = await deps.ui.call('gpt-create', project ? { name: '', prompt, project } : { name: '', prompt }, signal(deps));
    submitted = true;
    id = sent.conversationId ?? null;
    if (project && sent.project !== project) throw new BridgeError('PROVENANCE', 'The project selection was not confirmed by the app');
    stage = 'identity';
    const row = await until(async () => {
      const rows = await deps.native.listThreads();
      // A public UI UUID can be read directly even when manual sorting keeps it
      // outside the host's bounded list. It is still verified by the exact marker.
      const candidates = [...new Set([...(id ? [id] : []), ...rows.filter(t => !baseline.has(t.id) && t.kind === 'chatgpt').map(t => t.id)])];
      for (const candidate of candidates) {
        const page = await deps.native.readThread(candidate);
        if (page.thread.id !== candidate || page.thread.kind !== 'chatgpt' || !asks(page.turns[0], prompt)) continue;
        id = candidate; actualTitle = page.thread.title; identityVerified = true;
        if (baseline.has(candidate)) throw new BridgeError('PROVENANCE', 'The initialization marker reached a pre-existing conversation');
        if (page.turns[0].error || ['failed', 'interrupted'].includes(page.turns[0].status)) throw new BridgeError('EXECUTION', 'The initialization turn failed');
        // Wait until auto-titling and the initial turn finish before renaming.
        if (!done(page, page.turns[0])) return undefined;
        return rows.find(t => t.id === candidate) ?? { id: candidate, kind: 'chatgpt', title: page.thread.title, projectId: null, cwd: null };
      }
      return undefined;
    }, budget(120000), deps.pollMs);
    if (!row || !id) throw new BridgeError('TIMEOUT', 'The marker was submitted but its completed conversation could not be confirmed in the native inventory');
    const createdId = id;
    stage = 'title';
    // No new write once the create budget is spent.
    if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'The create budget ran out before the title could be written');
    await deps.native.setThreadTitle(createdId, 'chatgpt', title);
    // A successful write is not persistence. The ID read, the inventory entry of the
    // same ID and the actual ChatGPT page must all show the new title, twice in a row.
    // The host's sidebar inventory can lag an ID-addressed title write by about a
    // minute, so this waits within the original create budget instead of treating a
    // stale inventory as persisted (or bypassing it).
    let stable = 0;
    const confirmed = await until(async () => {
      const page = await deps.native.readThread(createdId);
      actualTitle = page.thread.title;
      if (page.thread.id !== createdId || page.thread.kind !== 'chatgpt' || !asks(page.turns[0], prompt)) throw new BridgeError('PROVENANCE', 'The created conversation identity changed');
      const rows = await deps.native.listThreads();
      if (rows.some(t => t.kind === 'chatgpt' && t.title === title && t.id !== createdId)) throw new BridgeError('PROVENANCE', 'The requested title is no longer unique');
      const view = (await deps.ui.call('snapshot', { name: '' }, signal(deps))).snapshot;

      const nativeTitle = page.thread.title === title;
      // A page UUID only proves which page is shown, not that the title persisted.
      const inventoryTitle = rows.find(t => t.id === createdId)?.title ?? null;
      const located = view?.ordinaryComposer && view.title === title && (!view.conversationId || view.conversationId === createdId);
      stage = nativeTitle ? 'persistence' : 'title';
      verification = { nativeTitle: page.thread.title, inventoryTitle, uiTitle: view?.title ?? null, ordinaryComposer: view?.ordinaryComposer ?? false };

      const agreed = nativeTitle && inventoryTitle === title && done(page, page.turns[0]) && located;
      stable = agreed ? stable + 1 : 0;
      return stable >= 2 ? true : undefined;
    }, budget(120000), deps.pollMs);
    if (!confirmed) throw new BridgeError(stage === 'title' ? 'STATE' : 'PROVENANCE', 'The created chat title, persisted identity and ChatGPT page did not agree');
    if (!project) return { conversationId: createdId, title };
    const native = row.projectId ? (await deps.native.listProjects?.())?.find(item => item.projectId === row.projectId) : undefined;
    if (native && native.label !== project) throw new BridgeError('PROVENANCE', `Chat ${createdId} was created in another project (${native.label})`);
    return { conversationId: createdId, title, project: { name: project, confirmedBy: native ? 'ui+native' : 'ui', projectId: row.projectId } };
  } catch (error) {
    const failure = asBridgeError(error);
    if (!submitted && !failure.details?.submission) throw error;
    throw new BridgeError(failure.code, `${failure.message}; creation is partially complete: read the known conversation, do not create again or resend the initialization marker`,
      { ...failure.details, status: 'partial', conversationId: id, title: actualTitle, requestedTitle: title, identityVerified, submission: failure.details?.submission ?? 'sent', stage, ...(verification ? { verification } : {}) });
  }
}
