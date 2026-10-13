import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, classifyError, type ErrorCode } from './errors.ts';
import { withDeadline } from './deadline.ts';
import type { DesktopGptReader } from './desktop-gpt-reader.ts';

export interface NativeChatPage {
  thread: { id: string; kind: string; title: string; status: { type: string } };
  turns: { id: string; status: string; error: unknown; startedAt?: number; items: (
    { type: 'userMessage'; id: string; content: { type: string; text?: string; truncated?: boolean }[] } |
    { type: 'agentMessage'; id: string; text: string; truncated?: boolean; phase?: string }
  )[] }[];
}
/** Installed by a trusted host using its authorized native tools, never JSON or a private pipe. */
export interface NativeChatTools {
  readThread(input: { threadId: string; turnLimit: number; includeOutputs: true; maxOutputCharsPerItem: number }, signal: AbortSignal): Promise<NativeChatPage>;
  sendMessage(input: { threadId: string; prompt: string }, signal: AbortSignal): Promise<{ threadId: string }>;
}
export interface NativeChatMessageResult {
  conversationId: string;
  status: 'completed' | 'reply_content_unavailable' | 'sent_reply_pending' | 'delivery_uncertain' | 'turn_failed';
  turnId: string | null;
  replyMessageId: string | null;
  reply: string | null;
  replySource: 'native' | 'visible-dom' | null;
  generationParametersVerified: false;
  errors: { stage: 'send' | 'read'; code: ErrorCode }[];
}

/** Matches a new user turn, not an old assistant reply or a send acknowledgement. */
export function observeNativeChatMessage(before: NativeChatPage, current: NativeChatPage, prompt: string): NativeChatMessageResult {
  if (before.thread.kind !== 'chatgpt' || current.thread.kind !== 'chatgpt' || before.thread.id !== current.thread.id || before.thread.title !== current.thread.title)
    throw new BridgeError('PROVENANCE', 'Native ChatGPT identity or title changed');
  const baseline = new Set(before.turns.map(turn => turn.id));
  const turn = current.turns.find(turn => !baseline.has(turn.id) && turn.items.some(item => item.type === 'userMessage' &&
    item.content.some(part => part.type === 'text' && part.truncated !== true && part.text === prompt)));
  const result: NativeChatMessageResult = { conversationId: before.thread.id, status: 'delivery_uncertain', turnId: turn?.id ?? null, replyMessageId: null, reply: null, replySource: null, generationParametersVerified: false, errors: [] };
  if (!turn) return result;
  result.status = 'sent_reply_pending';
  if (turn.error != null || turn.status === 'failed' || turn.status === 'interrupted') { result.status = 'turn_failed'; return result; }
  const replies = turn.items.filter(item => item.type === 'agentMessage');
  // Current native ChatGPT turn status is synthesized as completed even while
  // streaming; the thread must also be idle before accepting a reply.
  if (current.thread.status.type !== 'idle' || turn.status !== 'completed' || replies.length === 0) return result;
  result.replyMessageId = replies.at(-1)!.id;
  if (replies.some(item => item.truncated === true || !item.text.trim() || item.text.includes('::chatgpt-content-reference{'))) {
    result.status = 'reply_content_unavailable'; return result;
  }
  result.status = 'completed'; result.reply = replies.map(item => item.text).join('\n\n'); result.replySource = 'native';
  return result;
}

export class NativeChatMessageHost {
  private readonly active = new Set<string>();
  private readonly tools: NativeChatTools;
  constructor(tools: NativeChatTools) { this.tools = tools; }
  async sendAndWait(target: { conversationId: string; name: string }, prompt: string, budget: { timeoutMs: number; intervalMs: number }, replyReader?: DesktopGptReader): Promise<NativeChatMessageResult> {
    if (!prompt.trim()) throw new BridgeError('INPUT', 'A non-empty ChatGPT message is required');
    if (budget.intervalMs < 1) throw new BridgeError('CONFIG', 'Invalid message observation interval');
    if (this.active.has(target.conversationId)) throw new BridgeError('CONFLICT', 'ChatGPT message is already in progress');
    this.active.add(target.conversationId);
    const deadline = Date.now() + budget.timeoutMs;
    try {
      return await withDeadline(async signal => {
        const read = () => this.tools.readThread({ threadId: target.conversationId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 }, signal);
        const before = await read();
        if (before.thread.id !== target.conversationId || before.thread.kind !== 'chatgpt' || before.thread.title !== target.name)
          throw new BridgeError('PROVENANCE', 'Native ChatGPT target does not match');
        if (before.thread.status.type !== 'idle') throw new BridgeError('CONFLICT', 'ChatGPT target is not idle');
        const errors: NativeChatMessageResult['errors'] = [];
        let result = observeNativeChatMessage(before, before, prompt);
        try {
          const receipt = await this.tools.sendMessage({ threadId: target.conversationId, prompt }, signal);
          if (receipt.threadId !== target.conversationId) throw new BridgeError('PROVENANCE', 'Native send receipt targets another conversation');
        } catch (error) { errors.push({ stage: 'send', code: classifyError(error).code }); }
        do {
          try {
            const current = await read();
            result = observeNativeChatMessage(before, current, prompt);
            if (result.status === 'reply_content_unavailable' && replyReader) {
              const visible = await replyReader(target.conversationId);
              if (visible.conversationId !== target.conversationId || visible.source !== 'visible-dom') throw new BridgeError('PROVENANCE', 'Visible reply belongs to another conversation or source');
              if (visible.responseInProgress || visible.completionVerified!==true) result.status = 'sent_reply_pending';
              else {
                const replies = current.turns.find(turn => turn.id === result.turnId)!.items.filter(item => item.type === 'agentMessage');
                const bodies = replies.map(reply => visible.messages.find(message => message.role === 'assistant' && message.sourceMessageId === reply.id));
                if (bodies.every(body => body?.text.trim() && !body.text.includes('::chatgpt-content-reference{'))) {
                  result.status = 'completed'; result.reply = bodies.map(body => body!.text).join('\n\n'); result.replySource = visible.source;
                }
              }
            }
          }
          catch (error) {
            if (error instanceof BridgeError && error.code === 'PROVENANCE') throw error;
            errors.push({ stage: 'read', code: classifyError(error).code });
            return { ...result, errors };
          }
          if (!['delivery_uncertain', 'sent_reply_pending'].includes(result.status)) return { ...result, errors };
          const remaining = deadline - Date.now();
          if (remaining <= budget.intervalMs) return { ...result, errors };
          await delay(budget.intervalMs, undefined, { signal });
        } while (!signal.aborted);
        return { ...result, errors };
      }, budget.timeoutMs);
    } finally { this.active.delete(target.conversationId); }
  }
}
