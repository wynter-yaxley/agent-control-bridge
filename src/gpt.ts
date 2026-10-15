import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.ts';
import type { NativeChatPage } from './native.ts';
import type { UiResult } from './windows-ui.ts';

export interface GptDeps {
  native: { readThread(id: string): Promise<NativeChatPage> };
  ui: { call(operation: 'chat-send' | 'chat-read-reply', fields: { name: string; conversationId: string; prompt: string }, signal: AbortSignal): Promise<UiResult> };
  timeoutMs: number;
  pollMs: number;
}
export interface GptReply { conversationId: string; title: string; turnId: string; reply: string; alreadySent: boolean; uiIdentity: 'uuid' | 'titleOnly' }

type Turn = NativeChatPage['turns'][number];
const asks = (turn: Turn | undefined, prompt: string) => !!turn?.items.some(item => item.type === 'userMessage' && item.content.some(part => part.type === 'text' && !part.truncated && part.text === prompt));
const done = (page: NativeChatPage, turn: Turn) => page.thread.status.type === 'idle' && turn.status === 'completed' && !turn.error && turn.items.some(item => item.type === 'agentMessage');

/** Sends one prompt to an existing ChatGPT conversation that the user has open in the
 * desktop app and returns its reply. The target title comes from the native read of the
 * target ID; the UIA worker refuses when the current chat differs. A prompt that is
 * already the latest turn is never sent again: its reply is read instead. */
export async function sendGpt(deps: GptDeps, conversationId: string, prompt: string): Promise<GptReply> {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65536) throw new BridgeError('INPUT', 'Prompt must be 1..65536 characters');
  const signal = AbortSignal.timeout(deps.timeoutMs + 60000);
  const before = await deps.native.readThread(conversationId);
  if (before.thread.kind !== 'chatgpt' || !before.thread.title.trim()) throw new BridgeError('PROVENANCE', 'Target is not a titled ChatGPT conversation');
  const title = before.thread.title, latest = before.turns[0], alreadySent = asks(latest, prompt);
  if (alreadySent && !done(before, latest)) throw new BridgeError('CONFLICT', 'This prompt was already sent and is still running; call again later to read the reply');
  if (!alreadySent) {
    if (before.thread.status.type !== 'idle') throw new BridgeError('CONFLICT', 'GPT conversation is busy');
    await deps.ui.call('chat-send', { name: title, conversationId, prompt }, signal);
  }
  // Native completion of a new turn carrying this exact prompt.
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
    if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Reply is pending; call again with the same prompt to read it (it is not resent)');
    await delay(deps.pollMs);
  }
  // The visible body of that reply, correlated to the prompt by the UIA worker.
  const body = await deps.ui.call('chat-read-reply', { name: title, conversationId, prompt }, signal);
  const identity = body.conversationId === conversationId ? 'uuid' : !body.conversationId && body.identity === 'titleOnly' ? 'titleOnly' : null;
  if (!identity || body.completionVerified !== true || !body.body?.trim()) throw new BridgeError('PROVENANCE', 'Reply body could not be read from the target conversation');
  const after = await deps.native.readThread(conversationId);
  if (after.turns[0]?.id !== turn.id || !done(after, after.turns[0])) throw new BridgeError('PROVENANCE', 'GPT turn changed while reading the reply');
  return { conversationId, title, turnId: turn.id, reply: body.body, alreadySent, uiIdentity: identity };
}
