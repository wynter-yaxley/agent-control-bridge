import { setTimeout as delay } from 'node:timers/promises';
import type { App, AppTurn, Kind } from './desktop.ts';
import { AcbError } from './errors.ts';
import { normalize, opensWith, statusOf, type Turn, toTurn } from './turns.ts';

export interface WaitOptions {
  /** When to stop waiting for the reply (epoch milliseconds). */
  deadline: number;
  /** Longest pause between two status reads. */
  pollMs?: number;
  /**
   * Another way to learn that the turn of a message just sent has ended, tried first on every
   * poll: the ChatGPT page shows a reply long before the app lists it.
   */
  early?: () => Promise<Turn | undefined>;
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
  /** Its turn as confirmed on the page: it no longer holds back another message. */
  answer?: Turn;
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
  const { title, alreadySent, match } = await exclusive(app, threadId, async (): Promise<Decision> => {
    let before = await app.readThread(threadId);
    if (before.kind !== kind) {
      const tool = before.kind === 'codex' ? 'acb_codex_send' : 'acb_gpt_send';
      throw new AcbError(
        'INPUT',
        `This is a ${before.kind === 'codex' ? 'Codex' : 'ChatGPT'} conversation: use ${tool}`,
      );
    }
    const earlier = await sentBefore(app, threadId);
    // A message answered on the page but not listed yet: the listed newest turn is older.
    const stale = earlier?.entry.answer !== undefined && !earlier.turn;
    if (earlier) {
      const { entry, turn } = earlier;
      if (entry.prompt === text) {
        return { title: before.title, alreadySent: true, match: turn ? { turnId: turn.id } : { after: entry.after } };
      }
      if (!turn && !entry.answer) {
        throw new AcbError(
          'BUSY',
          `A message ACB sent at ${entry.sentAt} has not appeared in the conversation yet; wait for it before sending another`,
          { threadId },
        );
      }
      // That message has just been listed: decide on the conversation as it is now.
      if (turn) before = await app.readThread(threadId);
    }
    const last = before.turns[0];
    if (!stale && last && opensWith(last, text)) {
      return { title: before.title, alreadySent: true, match: { turnId: last.id } };
    }
    if (statusOf(before) !== 'idle') {
      throw new AcbError('BUSY', 'The conversation is still answering; read it, then send when it is idle', {
        threadId,
      });
    }
    await deliver(app, kind, threadId, text, options.caller, last?.id);
    return { title: before.title, alreadySent: false, match: { after: last?.id } };
  });
  const early = alreadySent ? undefined : options.early;
  const turn = options.wait ? await waitForTurn(app, threadId, text, match, { ...options, early }) : null;
  const entry = stateOf(app).accepted.get(threadId);
  if (turn && turn.turnId === null && entry?.prompt === text) entry.answer = turn;
  return { threadId, title, alreadySent, turn };
}

/**
 * The turn of a message ACB sent whose reply was confirmed on the page, while the app still
 * lists turn `newest` (the one before it) as the conversation's newest.
 */
export function unlistedAnswer(app: App, threadId: string, newest: string | undefined): Turn | undefined {
  const entry = state.get(app)?.accepted.get(threadId);
  return entry?.answer && entry.after === newest ? entry.answer : undefined;
}

interface Decision {
  title: string;
  alreadySent: boolean;
  match: Match;
}

/**
 * The message ACB sent (or may have sent) to `threadId` before, with the turn it opened once
 * the app lists one; the record is then dropped. Other new turns prove nothing about it.
 */
async function sentBefore(app: App, threadId: string): Promise<{ entry: Accepted; turn?: AppTurn } | undefined> {
  const { accepted } = stateOf(app);
  const entry = accepted.get(threadId);
  if (!entry) return undefined;
  const turn = await findTurn(app, threadId, entry.after, (candidate) => opensWith(candidate, entry.prompt));
  if (turn) accepted.delete(threadId);
  return { entry, ...(turn ? { turn } : {}) };
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
): Promise<void> {
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
 * The newest turn after turn `after` (any turn when undefined) that satisfies `test`, read in
 * full. It looks at most ten turns back.
 */
async function findTurn(
  app: App,
  threadId: string,
  after: string | undefined,
  test: (turn: AppTurn) => boolean,
): Promise<AppTurn | undefined> {
  for (const turns of [3, 10]) {
    const page = await app.readThread(threadId, { turns });
    const end = after === undefined ? -1 : page.turns.findIndex((turn) => turn.id === after);
    const found = (end < 0 ? page.turns : page.turns.slice(0, end)).find(test);
    if (found || end >= 0 || !page.nextCursor) return found;
  }
  return undefined;
}

/**
 * Waits for the turn opened by `prompt` to end and returns it: turn `turnId`, or the turn
 * after `after` that `prompt` opened. Status is watched without message text, which is
 * cheap; turns are read in full only when nothing is running.
 */
export async function waitForTurn(
  app: App,
  threadId: string,
  prompt: string,
  match: Match,
  { deadline, pollMs = 1500, early }: WaitOptions,
): Promise<Turn> {
  const ours =
    'turnId' in match
      ? () => findTurn(app, threadId, undefined, (turn) => turn.id === match.turnId)
      : () => findTurn(app, threadId, match.after, (turn) => opensWith(turn, prompt));
  for (let poll = 0; ; poll++) {
    const confirmed = await early?.();
    if (confirmed) return confirmed;
    const page = await app.readThread(threadId, { outputs: false });
    const status = statusOf(page);
    const moved = page.turns[0] !== undefined && ('turnId' in match || page.turns[0].id !== match.after);
    const turn = moved && status !== 'running' ? await ours() : undefined;
    if (turn && turn.status !== 'inProgress') return finished(threadId, turn);
    if (turn && status === 'needsUser') {
      throw new AcbError('NEEDS_USER', 'Codex is waiting for your approval or answer in the desktop app', {
        threadId,
        turnId: turn.id,
      });
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new AcbError(
        'TIMEOUT',
        'The reply is still pending: read the conversation later (sending the same prompt again does not resend it)',
        { threadId },
      );
    }
    await delay(Math.min(left, pollMs, 250 * 2 ** poll));
  }
}

function finished(threadId: string, opened: AppTurn): Turn {
  const turn = toTurn(opened);
  if (turn.status !== 'completed') {
    throw new AcbError('FAILED', `The turn ended as ${turn.status}${turn.error ? `: ${turn.error}` : ''}`, {
      threadId,
      turnId: turn.turnId,
    });
  }
  return turn;
}
