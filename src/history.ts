import { setTimeout as delay } from 'node:timers/promises';
import { hasNamesake, listedPrompts, type Page, PLACING, SHOW_MS } from './chatgpt.ts';
import type { App, ThreadPage } from './desktop.ts';
import { AcbError } from './errors.ts';
import { type PageMessage, type PageState, READ_TIMEOUT_MS, type Scroll, shownAfter } from './helper.ts';

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

/** How far up the page first moves per step, in screens: it holds more than a screen around what it shows. */
const STEP_SCREENS = 2;
/** The longest step: a step that reads nothing new is doubled, up to this. */
const MAX_STEP_SCREENS = 8;
/** How long a page may take to move to a scroll position and show the messages there. */
const SETTLE_MS = 3000;
/** How long the page may take to load older messages once it is scrolled to its top. */
const LOAD_MS = 5000;
/** How long the app may take to start and load the user's conversations. */
const START_MS = 90_000;

/**
 * Reads the turns of a ChatGPT conversation from its page, where the app keeps their whole
 * text: the newest `turns` after skipping the newest `skip`, oldest first. The app is started
 * if it does not run, and a window that does not show on screen is brought above the others
 * without being activated: the page of a covered window does not update. The page is scrolled
 * up step by step; the messages each step reads are joined by their headings' runtime IDs,
 * not their text, so equal messages are not confused. The window's place and the page's end
 * are restored afterwards.
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
 * A message reduced to its letters and digits. The page renders the Markdown of a message the
 * user typed (bold, lists, links), so only these are sure to read the same on both sides.
 */
const letters = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The page once it shows the end of the conversation: scrolled to the end, with the prompts
 * of the turns the app lists at one place (newer ones may follow, which the app lists late).
 * It only has to tell that this is the conversation's page, so prompts are compared by letters.
 */
async function pageEnd(page: Page, title: string, listed: string[], deadline: number): Promise<PageState> {
  const until = Math.min(deadline, Date.now() + READ_TIMEOUT_MS);
  const known = listed.slice(-PLACING).map(letters);
  let state = await page.pageState(title, SHOW_MS);
  for (;;) {
    const placed = state && shownAfter({ ...state, prompts: state.prompts.map(letters) }, known) !== undefined;
    if (state?.atEnd && (!known.length || placed)) return state;
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
 * conversation, and returns the messages read, oldest first. The page loads older messages
 * when it is scrolled to its top, so the start is reached only when it loads none. A step that
 * moved past what the previous one read is taken again, halved; one that read nothing new is
 * doubled next time.
 */
async function scanUp(
  page: Page,
  title: string,
  end: PageState,
  prompts: number,
  deadline: number,
): Promise<{ messages: PageMessage[]; top: boolean }> {
  let messages = end.messages;
  let at = end.scroll;
  let screens = STEP_SCREENS;
  const count = () => messages.filter((message) => message.role === 'you').length;
  const join = (state: PageState) => {
    const joined = prepend(state.messages, messages);
    if (!joined) return false;
    screens = joined.length === messages.length ? Math.min(screens * 2, MAX_STEP_SCREENS) : screens;
    messages = joined;
    at = state.scroll;
    return true;
  };
  while (count() < prompts) {
    if (Date.now() >= deadline) {
      throw new AcbError('TIMEOUT', 'Reading the conversation from the page took too long; ask for fewer turns');
    }
    // A conversation that fits shows all of it.
    if (!at) return { messages, top: true };
    if (at.percent <= 0) {
      const loaded = await olderLoaded(page, title, at);
      if (!loaded) return { messages, top: true };
      if (!join(loaded)) throw new AcbError('WINDOW', 'The ChatGPT page lost its place while loading older messages');
      continue;
    }
    const target = Math.max(0, at.percent - ((screens * at.view) / (100 - at.view)) * 100);
    const state = await scrolledTo(page, title, target, at.percent);
    const moved = state.scroll !== null && state.scroll.percent < at.percent;
    if (!moved || !join(state)) {
      screens /= 2;
      if (screens < 0.1) throw new AcbError('WINDOW', 'The ChatGPT page could not be read further up');
    }
  }
  return { messages, top: false };
}

/**
 * The page once it has loaded older messages above its top: it grows, and keeps what it shows
 * in place, so it is no longer at the top. Undefined when it loads none in time: the
 * conversation starts there.
 */
async function olderLoaded(page: Page, title: string, top: Scroll): Promise<PageState | undefined> {
  const until = Date.now() + LOAD_MS;
  while (Date.now() < until) {
    await delay(300);
    const state = await page.pageState(title);
    if (!state) throw new AcbError('WINDOW', 'The ChatGPT window does not show the conversation on screen');
    if (state.scroll && (state.scroll.view < top.view || state.scroll.percent > 0)) {
      return scrolledTo(page, title, state.scroll.percent, top.percent);
    }
  }
  return undefined;
}

/**
 * The page once it has moved from `from` towards `percent` and shows the same messages at the
 * same place on two reads in a row. It may not get there: at its top it loads older messages
 * and keeps what it shows in place.
 */
async function scrolledTo(page: Page, title: string, percent: number, from: number): Promise<PageState> {
  if (!(await page.scroll(title, percent))) {
    throw new AcbError('WINDOW', 'The ChatGPT window does not show the conversation on screen');
  }
  const until = Date.now() + SETTLE_MS;
  let previous: PageState | null = null;
  for (;;) {
    await delay(150);
    const state = await page.pageState(title);
    if (!state) throw new AcbError('WINDOW', 'The ChatGPT window does not show the conversation on screen');
    const at = state.scroll?.percent;
    const moved = at === undefined || Math.abs(at - percent) < 0.5 || Math.abs(at - from) >= 0.5;
    const ids = (one: PageState) => one.messages.map((message) => message.id).join();
    const settled = previous !== null && previous.scroll?.percent === at && ids(previous) === ids(state);
    if ((moved && settled) || Date.now() >= until) return state;
    previous = moved ? state : null;
  }
}

/**
 * `known` with the messages read further up the page before it. Both reads must hold the
 * first known message, told by its heading's runtime ID; undefined when they do not.
 */
export function prepend(older: PageMessage[], known: PageMessage[]): PageMessage[] | undefined {
  const first = known[0];
  if (!first) return older;
  const at = first.id === null ? -1 : older.findIndex((message) => message.id === first.id);
  return at < 0 ? undefined : [...older.slice(0, at), ...known];
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
