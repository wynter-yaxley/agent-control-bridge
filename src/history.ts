import { setTimeout as delay } from 'node:timers/promises';
import { hasNamesake, listedPrompts, type Page, PLACING, SHOW_MS } from './chatgpt.ts';
import type { App, ThreadPage } from './desktop.ts';
import { AcbError } from './errors.ts';
import { type PageMessage, type PageState, READ_TIMEOUT_MS } from './helper.ts';

/** A turn read from the page, which shows no turn IDs. */
export interface PageTurn {
  prompt: string;
  /** Null while ChatGPT is still writing it. */
  reply: string | null;
}

export interface History {
  conversationId: string;
  title: string;
  /** Oldest first. */
  turns: PageTurn[];
  /** The conversation has turns older than these. */
  more: boolean;
}

/** How long a page may take to move to a scroll position and show the messages there. */
const SETTLE_MS = 3000;
/** How long the app may take to start and load the user's conversations. */
const START_MS = 90_000;

/** Waits that tests shorten. */
export const timing = {
  /** How long the page may take to load older messages once scrolled to its top. */
  loadMs: 15_000,
  /** How often it is scrolled to its top again meanwhile, in case it missed it. */
  retriggerMs: 5000,
};

/**
 * Reads the turns of a ChatGPT conversation from its page, where the app keeps their whole
 * text: the newest `turns` after skipping the newest `skip`, oldest first. The app is started
 * if it does not run, and a window that does not show on screen is brought above the others
 * without being activated: the page of a covered window does not update. The page is scrolled
 * up step by step (see scanUp); the window's place and the page's end are restored afterwards.
 */
export async function readHistory(
  app: App,
  page: Page,
  conversationId: string,
  { turns, skip }: { turns: number; skip: number },
  deadline: number,
): Promise<History> {
  const read = await whenRunning(app, page, conversationId, deadline);
  if (read.kind !== 'chatgpt') throw new AcbError('INPUT', 'This is a Codex conversation: use acb_codex_read');
  const { title } = read;
  if (await hasNamesake(app, conversationId, title)) {
    throw new AcbError(
      'WINDOW',
      'Another ChatGPT conversation has the same title; rename one to read replies from the page',
      { conversationId },
    );
  }
  const scanned = await page.run(async () => {
    const giveBack = await page.holdForeground();
    const lower = await page.raise();
    try {
      await app.show(conversationId);
      await giveBack();
      const end = await pageEnd(page, title, listedPrompts(read.turns), deadline);
      return await scanUp(page, title, end, skip + turns + 1, deadline);
    } finally {
      await page.scroll(title, 100).catch(() => false);
      await lower();
      // The app can take the foreground late; check once more.
      await giveBack();
    }
  });
  const all = toTurns(scanned.messages);
  const end = all.length - skip;
  const start = Math.max(0, end - turns);
  return {
    conversationId,
    title,
    turns: all.slice(start, Math.max(0, end)),
    more: !scanned.top || start > 0,
  };
}

/**
 * The conversation as the app lists it. When the app cannot be reached, it is started (it
 * takes the foreground as it opens, which is given back) and waited for.
 */
async function whenRunning(app: App, page: Page, conversationId: string, deadline: number): Promise<ThreadPage> {
  const read = () => app.readThread(conversationId, { turns: 10 });
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof AcbError && error.code === 'UNAVAILABLE')) throw error;
    const giveBack = await page.holdForeground();
    try {
      if (!(await page.launch())) throw error;
      const until = Math.min(deadline, Date.now() + START_MS);
      for (;;) {
        await delay(1000);
        // The window opens, and takes the foreground, before the app is ready.
        await giveBack();
        try {
          return await read();
        } catch (failure) {
          // While it starts, the app is unreachable or does not know its conversations yet.
          if (!(failure instanceof AcbError) || Date.now() >= until) throw failure;
        }
      }
    } finally {
      await giveBack();
    }
  }
}

/**
 * A message reduced to the letters and digits of its text. The page renders the Markdown of a
 * message the user typed (bold, lists, links), so only these are sure to read the same on both
 * sides; a link reads as its text.
 */
const letters = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Whether the page shows the newest prompt the app lists at exactly one place where every
 * prompt the page holds before it, up to PLACING of them, is the one listed before it. A page
 * of long messages holds few, but one that holds a different prompt is another state of the
 * conversation, or another page. Newer messages may follow, which the app lists late. It only
 * has to tell that this is the conversation's page, so prompts are compared by their letters.
 */
function placed(state: PageState, listed: string[]): boolean {
  if (!listed.length) return true;
  const shown = state.prompts.map(letters);
  const known = listed.slice(-PLACING).map(letters);
  const fits = shown.filter((prompt, at) => {
    if (prompt !== known[known.length - 1]) return false;
    for (let back = 1; back < known.length && at - back >= 0; back++) {
      if (shown[at - back] !== known[known.length - 1 - back]) return false;
    }
    return true;
  });
  return fits.length === 1;
}

/**
 * The page once it shows the end of the conversation (see placed). A page that showed the
 * conversation before stays where it was left, so it is scrolled to its end.
 */
async function pageEnd(page: Page, title: string, listed: string[], deadline: number): Promise<PageState> {
  const until = Math.min(deadline, Date.now() + READ_TIMEOUT_MS);
  let state = await page.pageState(title, SHOW_MS);
  for (;;) {
    if (state && !state.atEnd) await page.scroll(title, 100);
    else if (state && placed(state, listed)) return state;
    if (Date.now() >= until) {
      throw new AcbError(
        'WINDOW',
        state
          ? 'The ChatGPT page did not show the newest turns of the conversation'
          : 'The ChatGPT window does not show the conversation on screen',
      );
    }
    await delay(300);
    state = await page.pageState(title);
  }
}

/**
 * Scrolls up from `end` until the page has shown `prompts` user messages or the start of the
 * conversation, and returns the messages read, oldest first. Each step scrolls to the first
 * message read, so the page renders those above it, and joins what it then holds to what was
 * read (see prepend). When nothing shows above the first message read, the page is moved a
 * screen further up from it, never further, so what was read stays on the page: it shows more,
 * or its top, where it shows whether it has older messages, and loads them. The conversation
 * starts there only when, at the top, the page shows nothing above the first message read and
 * no older messages to load: a load that ends meanwhile keeps the page below its top.
 */
async function scanUp(
  page: Page,
  title: string,
  end: PageState,
  prompts: number,
  deadline: number,
): Promise<{ messages: PageMessage[]; top: boolean }> {
  let messages = end.messages;
  let misses = 0;
  const count = () => messages.filter((message) => message.role === 'you').length;
  /** Joins a read to what was read; whether it showed more. */
  const grew = (state: PageState) => {
    const joined = prepend(state.messages, messages);
    if (!joined || joined.length === messages.length) return false;
    messages = joined;
    return true;
  };
  while (count() < prompts) {
    if (Date.now() >= deadline) {
      throw new AcbError('TIMEOUT', 'Reading the conversation from the page took too long; ask for fewer turns');
    }
    const ids = messages.flatMap((message) => (message.id === null ? [] : [message.id]));
    if (!(await page.reveal(title, ids))) throw lost();
    const shown = await settled(page, title);
    if (!prepend(shown.messages, messages)) throw lost();
    if (grew(shown)) {
      misses = 0;
      continue;
    }
    if (!(await page.reveal(title, ids, 1))) throw lost();
    const top = await settled(page, title);
    if (prepend(top.messages, messages) && grew(top)) {
      misses = 0;
      continue;
    }
    // A read that does not join, or a page below its top that shows nothing new, as when a
    // load ended meanwhile, is taken again from the first message read; a few times at most.
    if (!prepend(top.messages, messages) || !atTop(top.scroll)) {
      if (++misses >= 3) throw lost();
      continue;
    }
    if (!top.older) return { messages, top: true };
    await olderLoaded(page, title, top);
  }
  return { messages, top: false };
}

/** Whether a page scrolled to `scroll` (null: it fits) shows its top, as far as scrolling is exact. */
function atTop(scroll: PageState['scroll']): boolean {
  return !scroll || (scroll.percent / 100) * (100 / scroll.view - 1) <= 0.05;
}

const lost = () => new AcbError('WINDOW', 'The ChatGPT page lost its place while it was read');
const unseen = () => new AcbError('WINDOW', 'The ChatGPT window does not show the conversation on screen');

/**
 * Waits for the page, scrolled to its top, to load older messages: it grows, or has none
 * left. A page that does not load them in time does not tell where the conversation starts,
 * which is an error rather than its start.
 */
async function olderLoaded(page: Page, title: string, top: PageState): Promise<void> {
  const started = Date.now();
  let triggered = started;
  for (;;) {
    await delay(300);
    const state = await page.pageState(title);
    if (!state) throw unseen();
    const grown = state.scroll !== null && (top.scroll === null || state.scroll.view < top.scroll.view);
    if (grown || !state.older) return;
    if (Date.now() - started >= timing.loadMs) {
      throw new AcbError('TIMEOUT', 'The ChatGPT page did not load its older messages in time; read again later');
    }
    if (Date.now() - triggered >= timing.retriggerMs) {
      triggered = Date.now();
      await page.scroll(title, 0);
    }
  }
}

/** The page once two reads in a row show the same messages at the same place. */
async function settled(page: Page, title: string): Promise<PageState> {
  const until = Date.now() + SETTLE_MS;
  const shape = (state: PageState) => `${state.scroll?.percent}:${state.messages.map((message) => message.id).join()}`;
  let previous: string | undefined;
  for (;;) {
    await delay(150);
    const state = await page.pageState(title);
    if (!state) throw unseen();
    if (shape(state) === previous || Date.now() >= until) return state;
    previous = shape(state);
  }
}

/**
 * `known` with the messages read further up the page before it, joined at the first message
 * both reads hold, told by its heading's runtime ID: equal messages are not confused. A message
 * the page renders anew gets a new ID, so known messages above the joint must show right above
 * it in the new read, the same. Undefined when the reads do not join.
 */
export function prepend(older: PageMessage[], known: PageMessage[]): PageMessage[] | undefined {
  if (!known.length) return older;
  const index = new Map(known.flatMap((message, at) => (message.id === null ? [] : [[message.id, at] as const])));
  const joint = older.findIndex((message) => message.id !== null && index.has(message.id));
  if (joint < 0) return undefined;
  const renewed = index.get(older[joint].id as string) as number;
  const above = older.slice(joint - renewed, joint);
  const same = above.every((message, at) => message.role === known[at].role && message.text === known[at].text);
  return joint < renewed || !same ? undefined : [...older.slice(0, joint - renewed), ...known];
}

/**
 * The turns of the messages read: a user message and the replies after it. Replies before the
 * first user message read belong to a turn further up, and are left out.
 */
export function toTurns(messages: PageMessage[]): PageTurn[] {
  const turns: (PageTurn & { writing: boolean })[] = [];
  for (const message of messages) {
    if (message.role === 'you') {
      turns.push({ prompt: message.text, reply: null, writing: false });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    turn.writing ||= !message.complete;
    turn.reply = turn.reply === null ? message.text : `${turn.reply}\n${message.text}`;
  }
  return turns.map(({ prompt, reply, writing }) => ({ prompt, reply: writing ? null : reply }));
}
