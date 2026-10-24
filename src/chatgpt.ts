import { setTimeout as delay } from 'node:timers/promises';
import { type Sent, sendPrompt, type WaitOptions, waitForTurn } from './conversation.ts';
import type { App, Inventory, ThreadSummary } from './desktop.ts';
import { AcbError } from './errors.ts';
import { READ_TIMEOUT_MS, type WindowsHelper } from './helper.ts';
import { type Conversation, normalize, opensWith, type Turn, toConversation } from './turns.ts';

/** The page operations of WindowsHelper; tests substitute them. */
export type Page = Pick<WindowsHelper, 'run' | 'holdForeground' | 'readReply' | 'startChat'>;

/** A finished turn whose reply could not be read from the page keeps `replyOnPage` and says why. */
export interface PageRead {
  pageError?: string;
}

const RECOGNIZE_MS = 30_000;

export async function listGpt(app: App, options: { limit?: number } = {}): Promise<ThreadSummary[]> {
  return chatgptThreads(await app.listThreads()).slice(0, options.limit ?? 20);
}

/**
 * The app keeps most ChatGPT replies only on the page. With `fromPage`, the newest reply is
 * read there: the conversation is shown in the app (the window is not activated).
 */
export async function readGpt(
  app: App,
  page: Page,
  conversationId: string,
  options: { turns?: number; cursor?: string; fromPage?: boolean } = {},
): Promise<Conversation> {
  const read = await app.readThread(conversationId, options);
  if (read.kind !== 'chatgpt') throw new AcbError('INPUT', 'This is a Codex conversation: use acb_codex_read');
  const conversation = toConversation(read);
  const newest = conversation.turns.at(-1);
  if (options.fromPage && !options.cursor && newest?.replyOnPage && newest.status === 'completed') {
    newest.reply = await pageReply(app, page, conversationId, newest, Date.now() + READ_TIMEOUT_MS);
    newest.replyOnPage = false;
  }
  return conversation;
}

export async function sendGpt(
  app: App,
  page: Page,
  conversationId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean },
): Promise<Sent & PageRead> {
  const sent = await sendPrompt(app, 'chatgpt', conversationId, prompt, options);
  return sent.turn
    ? { ...sent, ...(await withPageReply(app, page, conversationId, sent.turn, options.deadline)) }
    : sent;
}

/**
 * Starts a ChatGPT conversation with `prompt` and returns its first reply. The app has no
 * tool for this, so the window is used: it shows an existing ChatGPT conversation (which
 * puts it in ChatGPT mode), opens a new chat and sends the prompt. The new conversation is
 * then recognized in the app's list by its first message. Creations run one at a time, so
 * each recognizes only its own conversation.
 */
export async function createGpt(
  app: App,
  page: Page,
  request: { prompt: string; title?: string },
  options: WaitOptions,
): Promise<{ conversationId: string; title: string; turn: Turn } & PageRead> {
  const prompt = normalize(request.prompt);
  const conversationId = await page.run(async () => {
    const known = chatgptThreads(await app.listThreads());
    if (!known.length) throw new AcbError('WINDOW', 'Start one ChatGPT conversation in the desktop app first');
    const giveBack = await page.holdForeground();
    try {
      await app.show(known[0].id);
      await page.startChat(prompt);
    } finally {
      await giveBack();
    }
    return recognize(app, new Set(known.map((thread) => thread.id)), prompt);
  });
  const turn = await waitForTurn(app, conversationId, prompt, { after: undefined }, options);
  // ChatGPT names a new conversation after its first reply, so the title is set afterwards.
  if (request.title) await setTitle(app, conversationId, request.title);
  const read = await withPageReply(app, page, conversationId, turn, options.deadline);
  const { title } = await app.readThread(conversationId, { outputs: false });
  return { conversationId, title, ...read };
}

function chatgptThreads({ threads, unavailable }: Inventory): ThreadSummary[] {
  if (unavailable.includes('chatgpt')) {
    throw new AcbError(
      'UNAVAILABLE',
      'The desktop app could not list its ChatGPT conversations; is ChatGPT signed in?',
    );
  }
  return threads.filter((thread) => thread.kind === 'chatgpt');
}

/** The one new conversation whose first message is `prompt`. */
async function recognize(app: App, known: Set<string>, prompt: string): Promise<string> {
  const deadline = Date.now() + RECOGNIZE_MS;
  for (;;) {
    const matches: string[] = [];
    for (const thread of chatgptThreads(await app.listThreads())) {
      if (known.has(thread.id)) continue;
      // A conversation can be listed before its first message is readable; it is checked again.
      const first = await app.readThread(thread.id).then(
        (read) => read.turns[0],
        () => undefined,
      );
      if (opensWith(first, prompt)) matches.push(thread.id);
    }
    if (matches.length > 1)
      throw new AcbError('WINDOW', 'Several new conversations start with this message', { matches });
    if (matches.length === 1) return matches[0];
    if (Date.now() >= deadline) {
      throw new AcbError('WINDOW', 'The prompt was sent, but the new conversation did not appear in the app');
    }
    await delay(500);
  }
}

/** A title set while ChatGPT still names the conversation can be overwritten; it is checked. */
async function setTitle(app: App, conversationId: string, title: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.setTitle(conversationId, 'chatgpt', title);
    await delay(1500);
    if ((await app.readThread(conversationId, { outputs: false })).title === title) return;
  }
  throw new AcbError('FAILED', 'The conversation was created, but its title did not stick', { conversationId });
}

/** The turn with its reply from the page, or unchanged with the reason the page could not be read. */
async function withPageReply(
  app: App,
  page: Page,
  conversationId: string,
  turn: Turn,
  deadline: number,
): Promise<{ turn: Turn } & PageRead> {
  if (!turn.replyOnPage) return { turn };
  try {
    return { turn: { ...turn, reply: await pageReply(app, page, conversationId, turn, deadline), replyOnPage: false } };
  } catch (error) {
    if (!(error instanceof AcbError)) throw error;
    return { turn, pageError: `${error.message}. Read the reply later with acb_gpt_read and page: true.` };
  }
}

/** How many turns the conversation has, counted page by page without message text. */
async function turnCount(app: App, conversationId: string, deadline: number): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    if (Date.now() >= deadline) {
      throw new AcbError('TIMEOUT', 'No time was left to read the reply from the page', { conversationId });
    }
    const page = await app.readThread(conversationId, { turns: 10, outputs: false, ...(cursor ? { cursor } : {}) });
    count += page.turns.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return count;
}

/**
 * Reads the reply of `turn` from the page, within `deadline`. The page shows no conversation
 * ID, so it is recognized by the conversation's title, which must be unique among the
 * conversations the app lists, and by its messages: as many as the conversation has turns,
 * the last being the turn's prompt. A page that has not caught up shows fewer. The turn
 * must also be the newest, finished one before and after reading.
 */
async function pageReply(app: App, page: Page, conversationId: string, turn: Turn, deadline: number): Promise<string> {
  if (!turn.prompt || turn.truncated) {
    throw new AcbError('WINDOW', 'This prompt is too long to be matched on the page', { conversationId });
  }
  const prompt = turn.prompt;
  const { title } = await app.readThread(conversationId, { outputs: false });
  const namesakes = chatgptThreads(await app.listThreads()).filter(
    (thread) => thread.title === title && thread.id !== conversationId,
  );
  if (namesakes.length) {
    throw new AcbError(
      'WINDOW',
      'Another ChatGPT conversation has the same title; rename one to read replies from the page',
      {
        conversationId,
      },
    );
  }
  const messages = await turnCount(app, conversationId, deadline);
  const newest = async () => {
    const current = (await app.readThread(conversationId, { outputs: false })).turns[0];
    if (current?.id !== turn.turnId || current.status !== 'completed') {
      throw new AcbError('BUSY', 'The conversation has moved on; read it again', { conversationId });
    }
  };
  return page.run(async () => {
    const giveBack = await page.holdForeground();
    try {
      await app.show(conversationId);
      await giveBack();
      await newest();
      const left = Math.min(READ_TIMEOUT_MS, deadline - Date.now());
      if (left < 1000)
        throw new AcbError('TIMEOUT', 'No time was left to read the reply from the page', { conversationId });
      const reply = await page.readReply(title, prompt, messages, left);
      await newest();
      return reply;
    } finally {
      // The app can take the foreground late; check once more.
      await giveBack();
    }
  });
}
