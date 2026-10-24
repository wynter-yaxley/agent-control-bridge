import { setTimeout as delay } from 'node:timers/promises';
import { type Sent, sendPrompt, unlistedAnswer, type WaitOptions, waitForTurn } from './conversation.ts';
import type { App, Inventory, ThreadSummary } from './desktop.ts';
import { AcbError } from './errors.ts';
import { READ_TIMEOUT_MS, readyReply, type WindowsHelper } from './helper.ts';
import { type Conversation, normalize, opensWith, promptOf, type Turn, toConversation } from './turns.ts';

/** How long the page may take to show a conversation it was asked to show. */
const SHOW_MS = 2000;

/** The page operations of WindowsHelper; tests substitute them. */
export type Page = Pick<WindowsHelper, 'run' | 'holdForeground' | 'pageState' | 'readReply' | 'startChat'>;

/** A finished turn whose reply could not be read from the page keeps `replyOnPage` and says why. */
export interface PageRead {
  pageError?: string;
}

export async function listGpt(app: App, options: { limit?: number } = {}): Promise<ThreadSummary[]> {
  return chatgptThreads(await app.listThreads()).slice(0, options.limit ?? 20);
}

/**
 * The app keeps most ChatGPT replies only on the page. With `fromPage`, the newest reply is
 * read there: the conversation is shown in the app (the window is not activated). A turn sent
 * through ACB and answered on the page comes last until the app lists it.
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
  const answer = options.cursor ? undefined : unlistedAnswer(app, conversationId, read.turns[0]?.id);
  if (answer) conversation.turns.push(answer);
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
  const early = options.wait ? await watchPage(app, page, conversationId, normalize(prompt)) : undefined;
  const sent = await sendPrompt(app, 'chatgpt', conversationId, prompt, { ...options, early });
  return sent.turn
    ? { ...sent, ...(await withPageReply(app, page, conversationId, sent.turn, options.deadline)) }
    : sent;
}

/**
 * The app lists a ChatGPT turn up to a minute after it has ended (it caches conversations for
 * a minute), while the page shows the reply as soon as it is written. So before sending, the
 * page is shown and its last message noted; the returned check then finds the reply once the
 * page's last two messages are that one and `prompt` and the reply is finished. Undefined when
 * the page cannot serve: the window does not show the conversation, or another conversation
 * has the same title. The app's list remains the fallback, also for a page that stops updating.
 */
async function watchPage(
  app: App,
  page: Page,
  conversationId: string,
  prompt: string,
): Promise<(() => Promise<Turn | undefined>) | undefined> {
  try {
    const { title } = await app.readThread(conversationId, { outputs: false });
    if (await hasNamesake(app, conversationId, title)) return undefined;
    const before = await page.run(async () => {
      await show(app, page, conversationId);
      return page.pageState(title, SHOW_MS);
    });
    if (!before?.exchange) return undefined;
    const previous = before.exchange.prompt;
    return () =>
      page
        .run(async () => {
          let state = await page.pageState(title);
          if (!state) {
            // Another page operation showed a different conversation meanwhile.
            await show(app, page, conversationId);
            state = await page.pageState(title);
          }
          const reply = readyReply(state, prompt, previous);
          return reply === null ? undefined : pageTurn(prompt, reply);
        })
        .catch(() => undefined);
  } catch {
    return undefined;
  }
}

function pageTurn(prompt: string, reply: string): Turn {
  return { turnId: null, status: 'completed', prompt, reply, replyOnPage: false, truncated: false, error: null };
}

/** Shows the conversation and gives the foreground back if the app took it. */
async function show(app: App, page: Page, conversationId: string): Promise<void> {
  const giveBack = await page.holdForeground();
  try {
    await app.show(conversationId);
  } finally {
    await giveBack();
  }
}

/** Whether another ChatGPT conversation the app lists has this title, so the page cannot tell them apart. */
async function hasNamesake(app: App, conversationId: string, title: string): Promise<boolean> {
  return chatgptThreads(await app.listThreads()).some(
    (thread) => thread.title === title && thread.id !== conversationId,
  );
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
    return recognize(app, new Set(known.map((thread) => thread.id)), prompt, options.deadline);
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

/**
 * The one new conversation whose first message is `prompt`. The app can take a minute to list
 * a new conversation, so this waits until `deadline`.
 */
async function recognize(app: App, known: Set<string>, prompt: string, deadline: number): Promise<string> {
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

/**
 * Reads the reply of `turn` from the page, within `deadline`. The page shows no conversation
 * ID, so it is recognized by the conversation's title, which must be unique among the
 * conversations the app lists, and by its last two messages, which must be the prompts of the
 * conversation's last two turns. The turn must also be the newest, finished one before and
 * after reading.
 */
async function pageReply(app: App, page: Page, conversationId: string, turn: Turn, deadline: number): Promise<string> {
  if (!turn.prompt || turn.truncated) {
    throw new AcbError('WINDOW', 'This prompt is too long to be matched on the page', { conversationId });
  }
  const prompt = turn.prompt;
  const { title } = await app.readThread(conversationId, { outputs: false });
  if (await hasNamesake(app, conversationId, title)) {
    throw new AcbError(
      'WINDOW',
      'Another ChatGPT conversation has the same title; rename one to read replies from the page',
      {
        conversationId,
      },
    );
  }
  const [newestTurn, earlierTurn] = (await app.readThread(conversationId, { turns: 2 })).turns;
  if (newestTurn?.id !== turn.turnId) {
    throw new AcbError('BUSY', 'The conversation has moved on; read it again', { conversationId });
  }
  const earlier = earlierTurn ? promptOf(earlierTurn) : null;
  if (earlier && !earlier.complete) {
    throw new AcbError('WINDOW', 'The previous prompt is too long to be matched on the page', { conversationId });
  }
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
      const reply = await page.readReply(title, prompt, earlier?.text ?? null, left);
      await newest();
      return reply;
    } finally {
      // The app can take the foreground late; check once more.
      await giveBack();
    }
  });
}
