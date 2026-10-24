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
   * Another way to learn that the turn has ended, tried first on every poll: the ChatGPT page
   * shows a reply long before the app lists it.
   */
  early?: () => Promise<Turn | undefined>;
}

/**
 * What the page shows of a conversation right before a prompt is sent to it. The ChatGPT page
 * is up to a minute ahead of the app's list.
 */
export interface Live {
  /** ChatGPT is writing a reply to a message the app does not list yet. */
  busy: boolean;
  /** The page's newest message, which the app does not list yet, is the prompt. */
  shown: boolean;
  /** The finished reply to the prompt, once the page shows it. */
  reply: () => Promise<Turn | undefined>;
}

export interface SendOptions extends Omit<WaitOptions, 'early'> {
  wait: boolean;
  caller?: string;
  /**
   * Looks at the page right before `prompt` is sent, given the prompts of the messages ACB sent
   * that the app does not list yet; undefined when the page cannot tell.
   */
  watch?: (prompt: string, unlisted: string[]) => Promise<Live | undefined>;
}

export interface Sent {
  threadId: string;
  title: string;
  /** The prompt had already been sent, so it was not sent again. */
  alreadySent: boolean;
  /** The finished turn; null when the caller did not wait. */
  turn: Turn | null;
}

/** Which turn a prompt opens: turn `turnId`, or its `occurrence`-th (from 0) turn after turn `after`. */
type Match = { turnId: string } | { after: string | undefined; occurrence: number };

/** A message ACB sent, or may have sent, that the app does not list yet. */
interface Message {
  prompt: string;
  sentAt: string;
  /** Its turn as confirmed on the page. */
  answer?: Turn;
}

/**
 * The messages ACB sent to a conversation after turn `after`, oldest first, that the app does
 * not list yet. A message is dropped once the app lists it, or when it certainly was not sent:
 * no amount of time proves that a message was not delivered.
 */
interface Chain {
  after: string | undefined;
  messages: Message[];
}

/** Per app: sends to one conversation run one at a time, and the messages not listed yet. */
const state = new WeakMap<App, { locks: Map<string, Promise<unknown>>; chains: Map<string, Chain> }>();

function stateOf(app: App) {
  let current = state.get(app);
  if (!current) {
    current = { locks: new Map(), chains: new Map() };
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
 * that is the conversation's newest message (listed, shown on the page, or sent by ACB and
 * not listed yet) is not sent again: its turn is returned instead, so a call that timed out
 * can be repeated safely. A conversation that is still answering refuses a new prompt.
 */
export async function sendPrompt(
  app: App,
  kind: Kind,
  threadId: string,
  prompt: string,
  options: SendOptions,
): Promise<Sent> {
  const text = normalize(prompt);
  const plan = await exclusive(app, threadId, () => decide(app, kind, threadId, text, options));
  const { title, alreadySent } = plan;
  if (plan.answer) return { threadId, title, alreadySent, turn: options.wait ? plan.answer : null };
  const turn = options.wait
    ? await waitForTurn(app, threadId, text, plan.match, { ...options, early: plan.early })
    : null;
  if (turn?.turnId === null && plan.message) plan.message.answer = turn;
  return { threadId, title, alreadySent, turn };
}

interface Plan {
  title: string;
  alreadySent: boolean;
  match: Match;
  /** The turn of the prompt, already confirmed on the page. */
  answer?: Turn;
  /** The message just sent. */
  message?: Message;
  early?: () => Promise<Turn | undefined>;
}

async function decide(app: App, kind: Kind, threadId: string, text: string, options: SendOptions): Promise<Plan> {
  let before = await app.readThread(threadId);
  if (before.kind !== kind) {
    const tool = before.kind === 'codex' ? 'acb_codex_send' : 'acb_gpt_send';
    throw new AcbError('INPUT', `This is a ${before.kind === 'codex' ? 'Codex' : 'ChatGPT'} conversation: use ${tool}`);
  }
  if (await reconcile(app, threadId)) before = await app.readThread(threadId);
  const { title } = before;
  const chain = stateOf(app).chains.get(threadId);
  const last = before.turns[0];
  const after = chain ? chain.after : last?.id;
  const occurrence = chain?.messages.filter((message) => message.prompt === text).length ?? 0;
  const newest = chain?.messages.at(-1);
  if (newest?.prompt === text) {
    return { title, alreadySent: true, match: { after, occurrence: occurrence - 1 }, answer: newest.answer };
  }
  const unanswered = chain?.messages.find((message) => !message.answer);
  if (unanswered) {
    throw new AcbError(
      'BUSY',
      `A message ACB sent at ${unanswered.sentAt} has not appeared in the conversation yet; wait for it before sending another`,
      { threadId },
    );
  }
  // Without messages of ACB still unlisted, the app's newest turn is the newest message.
  if (!chain && last && opensWith(last, text)) return { title, alreadySent: true, match: { turnId: last.id } };
  const live = await options.watch?.(
    text,
    (chain?.messages ?? []).map((message) => message.prompt),
  );
  if (live?.shown) return { title, alreadySent: true, match: { after, occurrence }, early: live.reply };
  if (live?.busy || statusOf(before) !== 'idle') {
    throw new AcbError('BUSY', 'The conversation is still answering; read it, then send when it is idle', {
      threadId,
    });
  }
  const message = await deliver(app, kind, threadId, text, options.caller, after);
  return { title, alreadySent: false, match: { after, occurrence }, message, early: live?.reply };
}

/**
 * The turns of messages ACB sent that were answered on the page but that the app does not list
 * yet, oldest first, and the turn they follow; undefined when there are none.
 */
export function unlistedAnswers(
  app: App,
  threadId: string,
): Promise<{ after: string | undefined; answers: Turn[] } | undefined> {
  return exclusive(app, threadId, async () => {
    await reconcile(app, threadId);
    const chain = stateOf(app).chains.get(threadId);
    const answers = chain?.messages.flatMap((message) => (message.answer ? [message.answer] : [])) ?? [];
    return chain && answers.length ? { after: chain.after, answers } : undefined;
  });
}

/**
 * Drops the messages the app now lists: its turns after the chain's start are matched to the
 * messages in order, skipping turns of other senders. When the app no longer returns the
 * chain's start, more turns followed it than the app returns and the whole chain is dropped:
 * its messages can no longer be told apart. Whether any was dropped.
 */
async function reconcile(app: App, threadId: string): Promise<boolean> {
  const { chains } = stateOf(app);
  const chain = chains.get(threadId);
  if (!chain) return false;
  const turns = await turnsAfter(app, threadId, chain.after);
  if (!turns) {
    chains.delete(threadId);
    return true;
  }
  let listed = 0;
  let through: string | undefined;
  for (const turn of turns) {
    const message = chain.messages[listed];
    if (message && opensWith(turn, message.prompt)) {
      listed++;
      through = turn.id;
    }
  }
  if (!listed) return false;
  chain.messages.splice(0, listed);
  chain.after = through;
  if (!chain.messages.length) chains.delete(threadId);
  return true;
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
): Promise<Message> {
  const { chains } = stateOf(app);
  const chain = chains.get(threadId) ?? { after, messages: [] };
  chains.set(threadId, chain);
  const message: Message = { prompt, sentAt: new Date().toISOString() };
  chain.messages.push(message);
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
      chain.messages.splice(chain.messages.indexOf(message), 1);
      if (!chain.messages.length) chains.delete(threadId);
      throw error;
    }
    const failure = error instanceof AcbError ? error : new AcbError('PROTOCOL', String(error));
    throw new AcbError(
      failure.code,
      `${failure.message}. The message may have been sent: read the conversation before sending again`,
      { ...failure.details, threadId },
    );
  }
  return message;
}

/**
 * The turns after turn `after` (all when undefined), oldest first, read in full; undefined when
 * the app does not return turn `after` among the newest ten (for ChatGPT, it returns five).
 */
async function turnsAfter(app: App, threadId: string, after: string | undefined): Promise<AppTurn[] | undefined> {
  const read = async (turns: number) => {
    const page = await app.readThread(threadId, { turns });
    const end = after === undefined ? page.turns.length : page.turns.findIndex((turn) => turn.id === after);
    return { page, end };
  };
  let { page, end } = await read(3);
  if ((after === undefined || end < 0) && page.nextCursor) ({ page, end } = await read(10));
  return end < 0 ? undefined : page.turns.slice(0, end).reverse();
}

/** Turn `turnId`, read in full. It looks at most ten turns back. */
async function turnById(app: App, threadId: string, turnId: string): Promise<AppTurn | undefined> {
  for (const turns of [3, 10]) {
    const page = await app.readThread(threadId, { turns });
    const found = page.turns.find((turn) => turn.id === turnId);
    if (found || !page.nextCursor) return found;
  }
  return undefined;
}

/**
 * Waits for the turn opened by `prompt` to end and returns it (see Match). Status is watched
 * without message text, which is cheap; turns are read in full only when nothing is running.
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
      ? () => turnById(app, threadId, match.turnId)
      : async () =>
          (await turnsAfter(app, threadId, match.after))?.filter((turn) => opensWith(turn, prompt))[match.occurrence];
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
