import { setTimeout as delay } from 'node:timers/promises';
import type { App, AppTurn, Kind } from './desktop.ts';
import { AcbError } from './errors.ts';
import { normalize, opensWith, statusOf, type Turn, toTurn } from './turns.ts';

export interface WaitOptions {
  /** When to stop waiting for the reply (epoch milliseconds). */
  deadline: number;
  /** Longest pause between two status reads. */
  pollMs?: number;
}

export interface Sent {
  threadId: string;
  title: string;
  /** The prompt had already been sent, so it was not sent again. */
  alreadySent: boolean;
  /** The finished turn; null when the caller did not wait. */
  turn: Turn | null;
}

/** Which turn a sent prompt opens: turn `turnId`, or the first turn after `after`. */
type Match = { turnId: string } | { after: string | undefined };

/**
 * A message ACB sent, or may have sent, whose turn the app does not list yet. It is kept until
 * the app lists a newer turn: no amount of time proves that the message was not delivered.
 */
interface Accepted {
  prompt: string;
  after: string | undefined;
  sentAt: string;
}

/** Per app: sends to one conversation run one at a time, and messages sent but not yet listed. */
const state = new WeakMap<App, { locks: Map<string, Promise<unknown>>; accepted: Map<string, Accepted> }>();

function stateOf(app: App) {
  let current = state.get(app);
  if (!current) {
    current = { locks: new Map(), accepted: new Map() };
    state.set(app, current);
  }
  return current;
}

function exclusive<T>(app: App, threadId: string, task: () => Promise<T>): Promise<T> {
  const { locks } = stateOf(app);
  const result = (locks.get(threadId) ?? Promise.resolve()).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(threadId, tail);
  void tail.then(() => locks.get(threadId) === tail && locks.delete(threadId));
  return result;
}

/**
 * Sends one prompt to a conversation and, with `wait`, returns the turn it opens. A prompt
 * that is the conversation's newest message, or that ACB sent and the app has not listed
 * yet, is not sent again: its turn is returned instead, so a call that timed out can be
 * repeated safely. A conversation that is still answering refuses a new prompt.
 */
export async function sendPrompt(
  app: App,
  kind: Kind,
  threadId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean; caller?: string },
): Promise<Sent> {
  const text = normalize(prompt);
  const { title, alreadySent, match } = await exclusive(app, threadId, async () => {
    const before = await app.readThread(threadId);
    if (before.kind !== kind) {
      const tool = before.kind === 'codex' ? 'acb_codex_send' : 'acb_gpt_send';
      throw new AcbError(
        'INPUT',
        `This is a ${before.kind === 'codex' ? 'Codex' : 'ChatGPT'} conversation: use ${tool}`,
      );
    }
    const last = before.turns[0];
    const accepted = pendingOf(app, threadId, last);
    if (accepted) {
      if (accepted.prompt !== text) {
        throw new AcbError(
          'BUSY',
          `A message ACB sent at ${accepted.sentAt} has not appeared in the conversation yet; wait for it before sending another`,
          { threadId },
        );
      }
      return { title: before.title, alreadySent: true, match: { after: accepted.after } };
    }
    if (last && opensWith(last, text)) return { title: before.title, alreadySent: true, match: { turnId: last.id } };
    if (statusOf(before) !== 'idle') {
      throw new AcbError('BUSY', 'The conversation is still answering; read it, then send when it is idle', {
        threadId,
      });
    }
    await deliver(app, kind, threadId, text, options.caller, last?.id);
    return { title: before.title, alreadySent: false, match: { after: last?.id } };
  });
  const turn = options.wait ? await waitForTurn(app, threadId, text, match, options) : null;
  return { threadId, title, alreadySent, turn };
}

/** The message ACB sent to `threadId` while the app still lists `newest` as the latest turn. */
function pendingOf(app: App, threadId: string, newest: AppTurn | undefined): Accepted | undefined {
  const { accepted } = stateOf(app);
  const entry = accepted.get(threadId);
  if (entry && entry.after === newest?.id) return entry;
  accepted.delete(threadId);
  return undefined;
}

/**
 * Sends the message and records it before it can arrive. The record is dropped only when the
 * message certainly was not sent: it never left, or the app refused it. An archived
 * conversation refuses messages, so one retry after restoring it is safe.
 */
async function deliver(
  app: App,
  kind: Kind,
  threadId: string,
  prompt: string,
  caller: string | undefined,
  after: string | undefined,
) {
  const { accepted } = stateOf(app);
  accepted.set(threadId, { prompt, after, sentAt: new Date().toISOString() });
  try {
    try {
      await app.sendMessage(threadId, prompt, caller);
    } catch (error) {
      if (!(error instanceof AcbError && error.details.archived)) throw error;
      await app.setArchived(threadId, kind, false);
      await app.sendMessage(threadId, prompt, caller);
    }
  } catch (error) {
    if (error instanceof AcbError && (error.details.notSent || error.details.refused)) {
      accepted.delete(threadId);
      throw error;
    }
    const failure = error instanceof AcbError ? error : new AcbError('PROTOCOL', String(error));
    throw new AcbError(
      failure.code,
      `${failure.message}. The message may have been sent: read the conversation before sending again`,
      {
        ...failure.details,
        threadId,
      },
    );
  }
}

/**
 * Waits for the turn opened by `prompt` to end and returns it. Status is watched without
 * message text, which is cheap; the turn is read in full once to confirm it is the one
 * `prompt` opened.
 */
export async function waitForTurn(
  app: App,
  threadId: string,
  prompt: string,
  match: Match,
  { deadline, pollMs = 1500 }: WaitOptions,
): Promise<Turn> {
  for (let poll = 0; ; poll++) {
    const page = await app.readThread(threadId, { outputs: false });
    const newest = page.turns[0];
    const ours = newest !== undefined && ('turnId' in match ? newest.id === match.turnId : newest.id !== match.after);
    const status = statusOf(page);
    if (ours && newest.status !== 'inProgress' && status === 'idle') return finished(app, threadId, newest.id, prompt);
    if (ours && status === 'needsUser') {
      await confirm(app, threadId, newest.id, prompt);
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
        { threadId, ...(ours ? { turnId: newest.id } : {}) },
      );
    }
    await delay(Math.min(left, pollMs, 250 * 2 ** poll));
  }
}

/** Reads the newest turn in full and checks that it is `turnId`, opened by `prompt`. */
async function confirm(app: App, threadId: string, turnId: string, prompt: string): Promise<AppTurn> {
  const newest = (await app.readThread(threadId)).turns[0];
  if (newest?.id !== turnId) {
    throw new AcbError('BUSY', 'Another message arrived in the conversation meanwhile; read the conversation', {
      threadId,
    });
  }
  if (!opensWith(newest, prompt)) {
    throw new AcbError('BUSY', 'The conversation is answering another message; read the conversation', {
      threadId,
      turnId,
    });
  }
  return newest;
}

async function finished(app: App, threadId: string, turnId: string, prompt: string): Promise<Turn> {
  const turn = toTurn(await confirm(app, threadId, turnId, prompt));
  if (turn.status !== 'completed') {
    throw new AcbError('FAILED', `The turn ended as ${turn.status}${turn.error ? `: ${turn.error}` : ''}`, {
      threadId,
      turnId,
    });
  }
  return turn;
}
