import { setTimeout as delay } from 'node:timers/promises';
import type { App, Kind } from './desktop.ts';
import { AcbError } from './errors.ts';
import { normalize, opensWith, statusOf, type Turn, toTurn } from './turns.ts';

export interface WaitOptions {
  timeoutMs: number;
  /** Longest pause between two status reads. */
  pollMs?: number;
}

export interface Sent {
  threadId: string;
  title: string;
  /** The prompt was already the newest message, so it was not sent again. */
  alreadySent: boolean;
  /** The finished turn; null when the caller did not wait. */
  turn: Turn | null;
}

/**
 * Sends one prompt to a conversation and, with `wait`, returns the turn it starts. A prompt
 * that is already the newest message is not sent again: its turn is returned instead, so a
 * call that timed out can be repeated safely. A conversation that is still answering
 * refuses a new prompt.
 */
export async function sendPrompt(
  app: App,
  kind: Kind,
  threadId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean; caller?: string },
): Promise<Sent> {
  const text = normalize(prompt);
  const before = await app.readThread(threadId);
  if (before.kind !== kind) {
    throw new AcbError(
      'INPUT',
      `This is a ${before.kind === 'codex' ? 'Codex' : 'ChatGPT'} conversation: use acb_${before.kind === 'codex' ? 'codex' : 'gpt'}_send`,
    );
  }
  const last = before.turns[0];
  const alreadySent = opensWith(last, text);
  if (!alreadySent) {
    if (statusOf(before) !== 'idle') {
      throw new AcbError('BUSY', 'The conversation is still answering; read it, then send when it is idle', {
        threadId,
      });
    }
    await deliver(app, threadId, text, options.caller);
  }
  const match = alreadySent && last ? { turnId: last.id } : { after: last?.id };
  const turn = options.wait ? await waitForTurn(app, threadId, text, match, options) : null;
  return { threadId, title: before.title, alreadySent, turn };
}

/** An archived conversation refuses messages; nothing was sent then, so one retry is safe. */
async function deliver(app: App, threadId: string, prompt: string, caller: string | undefined): Promise<void> {
  try {
    await app.sendMessage(threadId, prompt, caller);
  } catch (error) {
    if (!(error instanceof AcbError && error.details.archived)) throw error;
    await app.setArchived(threadId, false);
    await app.sendMessage(threadId, prompt, caller);
  }
}

/**
 * Waits for the turn opened by `prompt` to end: turn `turnId`, or the first turn after
 * `after` (any turn when both are absent). Status is watched without message text, which
 * is cheap; the finished turn is read in full once.
 */
export async function waitForTurn(
  app: App,
  threadId: string,
  prompt: string,
  match: { turnId?: string; after?: string },
  { timeoutMs, pollMs = 1500 }: WaitOptions,
): Promise<Turn> {
  const deadline = Date.now() + timeoutMs;
  for (let poll = 0; ; poll++) {
    const page = await app.readThread(threadId, { outputs: false });
    const newest = page.turns[0];
    const ours = newest !== undefined && (match.turnId ? newest.id === match.turnId : newest.id !== match.after);
    const status = statusOf(page);
    if (ours && newest.status !== 'inProgress' && status === 'idle') return finished(app, threadId, newest.id, prompt);
    if (ours && status === 'needsUser') {
      throw new AcbError('NEEDS_USER', 'Codex is waiting for your approval or answer in the desktop app', {
        threadId,
        turnId: newest.id,
      });
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new AcbError(
        'TIMEOUT',
        'The reply is still pending: read the conversation later (sending the same prompt again does not resend it)',
        {
          threadId,
          ...(ours ? { turnId: newest.id } : {}),
        },
      );
    }
    await delay(Math.min(left, pollMs, 250 * 2 ** poll));
  }
}

async function finished(app: App, threadId: string, turnId: string, prompt: string): Promise<Turn> {
  const newest = (await app.readThread(threadId)).turns[0];
  if (newest?.id !== turnId) {
    throw new AcbError('BUSY', 'Another message arrived in the conversation meanwhile; read the conversation', {
      threadId,
    });
  }
  if (!opensWith(newest, prompt)) {
    throw new AcbError('PROTOCOL', 'The newest turn was not opened by the message just sent', { threadId, turnId });
  }
  const turn = toTurn(newest);
  if (turn.status !== 'completed') {
    throw new AcbError('FAILED', `The turn ended as ${turn.status}${turn.error ? `: ${turn.error}` : ''}`, {
      threadId,
      turnId,
    });
  }
  return turn;
}
