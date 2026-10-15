import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.ts';
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
  const inventory = await deps.native.listThreads(), same = inventory.filter(thread => thread.title === title);
  if (same.some(thread => thread.id !== id)) throw new BridgeError('PROVENANCE', 'Another conversation has the same title; the target cannot be located reliably');
  // A target outside the recent inventory cannot be proven unique by title.
  const unique = same.length === 1;
  const showing = async () => {
    const view = (await deps.ui.call('snapshot', { name: '' }, signal(deps))).snapshot;
    return view?.title === title && (view.conversationId ? view.conversationId === id : true) && view.ordinaryComposer ? true : undefined;
  };
  // An already open chat counts only by UUID or by a title proven unique.
  const current = (await deps.ui.call('snapshot', { name: '' }, signal(deps))).snapshot;
  if (current?.title === title && current.ordinaryComposer && (current.conversationId === id || (!current.conversationId && unique))) return 'current';
  if (!unique) throw new BridgeError('PROVENANCE', 'Target is not in the recent native inventory, so its title cannot be proven unique; open it in the ChatGPT app first');
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
export async function createGpt(deps: GptDeps, title: string, project?: string): Promise<{ conversationId: string; title: string; project?: { name: string; confirmedBy: 'ui' | 'ui+native'; projectId: string | null } }> {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new BridgeError('INPUT', 'Title must be one line of 1..200 characters');
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || project.length > 200 || /[\r\n]/.test(project))) throw new BridgeError('INPUT', 'Project must be one line of 1..200 characters');
  const inventory = await deps.native.listThreads();
  if (inventory.some(thread => thread.title === title)) throw new BridgeError('CONFLICT', 'A conversation with this title already exists; choose a unique title');
  const baseline = new Set(inventory.map(thread => thread.id));
  const prompt = `这是 Agent Control Bridge 新建对话的身份标记，不执行任务。请只回复：ACB_INIT_${randomUUID()}`;
  const sent = await deps.ui.call('gpt-create', project ? { name: '', prompt, project } : { name: '', prompt }, signal(deps));
  if (project && sent.project !== project) throw new BridgeError('PROVENANCE', 'The project selection was not confirmed by the app');
  const row = await until(async () => {
    for (const thread of await deps.native.listThreads()) {
      if (baseline.has(thread.id) || thread.kind !== 'chatgpt') continue;
      if (asks((await deps.native.readThread(thread.id)).turns[0], prompt)) return thread;
    }
    return undefined;
  }, 120000, deps.pollMs);
  const id = row?.id;
  if (!id) throw new BridgeError('TIMEOUT', 'The new chat was sent but did not appear in the native inventory; check the app before creating another');
  await deps.native.setThreadTitle(id, 'chatgpt', title);
  if (!await until(async () => (await deps.native.readThread(id)).thread.title === title || undefined, 15000, deps.pollMs)) throw new BridgeError('STATE', `Chat ${id} was created but could not be renamed`);
  if (!project) return { conversationId: id, title };
  // The UI read the project back; a native project ID, when exposed, must name the same project.
  const native = row.projectId ? (await deps.native.listProjects?.())?.find(item => item.projectId === row.projectId) : undefined;
  if (native && native.label !== project) throw new BridgeError('PROVENANCE', `Chat ${id} was created in another project (${native.label})`);
  return { conversationId: id, title, project: { name: project, confirmedBy: native ? 'ui+native' : 'ui', projectId: row.projectId } };
}
