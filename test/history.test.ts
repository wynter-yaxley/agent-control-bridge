import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '../src/chatgpt.ts';
import { AcbError } from '../src/errors.ts';
import type { PageMessage, PageState } from '../src/helper.ts';
import { WindowsHelper } from '../src/helper.ts';
import { prepend, readHistory, timing, toTurns } from '../src/history.ts';
import { FakeApp, GPT, userTurn } from './fake-app.ts';

// The fake page moves at once, so it is read without pauses.
Object.assign(timing, { pollMs: 1, settleMs: 1, startMs: 1 });

const code = (expected: string) => (error: unknown) => error instanceof AcbError && error.code === expected;
/** Reaching the top of a page takes a few seconds: it is given time to load older messages. */
const soon = () => Date.now() + 30_000;

/** A conversation of `prompts`, each answered with its reply, as page messages with runtime IDs. */
function conversation(turns: [string, string][]): PageMessage[] {
  return turns.flatMap(([prompt, reply], index) => [
    { id: `you-${index}`, role: 'you' as const, text: prompt, complete: true },
    { id: `gpt-${index}`, role: 'assistant' as const, text: reply, complete: true },
  ]);
}

interface FakeHistoryPage extends Page {
  load(): void;
  percent: number;
  launched: number;
  windowOpen: boolean;
  lowered: number;
  /** Times the foreground was given back. */
  givenBack: number;
  /** Whether it loads older messages when scrolled to its top. */
  loads: boolean;
  /** It loads them as it is scrolled to its top, before it is read there. */
  quick: boolean;
  /** How many reads show a reply that comes on the page without its text. */
  unwritten: number;
}

/**
 * A page that shows `held / 2` messages on the screen and holds half a screen more above and
 * below it, as the app's page does, and moves at once. With `chunk`, it has loaded only the
 * newest `chunk` messages, and loads `chunk` older ones each time it is at its top, keeping
 * the screen in place. A conversation that fits on the screen does not scroll.
 */
function virtualPage(messages: PageMessage[], held = 8, chunk = messages.length): FakeHistoryPage {
  const queue = new WindowsHelper();
  const screen = held / 2;
  let from = Math.max(0, messages.length - chunk);
  /** The first loaded message on the screen. */
  let top = Number.POSITIVE_INFINITY;
  /** How many reads have shown each message the page holds. */
  let shownFor = new Map<string | null, number>();
  const loaded = () => messages.slice(from);
  const range = () => Math.max(0, loaded().length - screen);
  const clamp = () => {
    top = Math.min(Math.max(0, top), range());
  };
  const shown = () => {
    clamp();
    return loaded().slice(Math.max(0, top - screen / 2), top + screen + screen / 2);
  };
  return {
    get percent() {
      clamp();
      return range() ? (top / range()) * 100 : 100;
    },
    set percent(percent: number) {
      top = Math.round((percent / 100) * range());
    },
    launched: 0,
    windowOpen: true,
    lowered: 0,
    givenBack: 0,
    loads: true,
    quick: false,
    unwritten: 0,
    run: (task) => queue.run(task),
    async holdForeground() {
      return async () => {
        this.givenBack++;
      };
    },
    async launch() {
      if (this.windowOpen) return false;
      this.windowOpen = true;
      this.launched++;
      return true;
    },
    async raise() {
      return async () => {
        this.lowered++;
      };
    },
    load() {
      clamp();
      if (top > 0 || from === 0 || !this.loads) return;
      const added = Math.min(chunk, from);
      from -= added;
      top += added;
    },
    async scroll(_title, percent) {
      this.percent = percent;
      if (this.quick) this.load();
      return true;
    },
    async reveal(_title, ids, pages = 0) {
      const target = ids.find((id) => shown().some((message) => message.id === id));
      if (target === undefined) return false;
      top = loaded().findIndex((message) => message.id === target) - pages * screen;
      if (this.quick) this.load();
      return true;
    },
    async pageState(): Promise<PageState> {
      // A page that fits shows that it has older messages, and so loads them.
      if (!this.quick || !range()) this.load();
      const held = shown().map((message) => {
        const reads = (shownFor.get(message.id) ?? 0) + 1;
        return message.role === 'assistant' && reads <= this.unwritten ? { ...message, text: '' } : message;
      });
      // A message that leaves the page comes on it anew.
      shownFor = new Map(held.map((message) => [message.id, (shownFor.get(message.id) ?? 0) + 1]));
      const last = held.findLastIndex((message) => message.role === 'you');
      return {
        busy: false,
        atEnd: top >= range(),
        scroll: range() ? { percent: this.percent, view: (screen / loaded().length) * 100 } : null,
        older: from > 0,
        messages: held,
        prompts: held.filter((message) => message.role === 'you').map((message) => message.text),
        reply: held[last + 1]?.text ?? '',
        complete: true,
      };
    },
    readReply: async () => '',
    startChat: async () => {},
  };
}

/** The app's list of the conversation: its newest five turns. */
function listed(app: FakeApp, turns: [string, string][]) {
  app.add({
    id: GPT,
    kind: 'chatgpt',
    title: 'Chat',
    turns: turns
      .slice(-5)
      .map(([prompt], index) => userTurn(`t${index}`, prompt, '::chatgpt-content-reference{index="0"}'))
      .reverse(),
  });
}

const twelve: [string, string][] = Array.from({ length: 12 }, (_, index) =>
  index % 3 === 0 ? ['Go on', 'More.'] : [`Question ${index}`, `Answer ${index}`],
);

test('the whole conversation is read from the page, equal turns kept apart', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  const history = await readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon());
  assert.deepEqual(
    history.turns.map((turn) => [turn.prompt, turn.reply]),
    twelve,
  );
  assert.equal(history.more, false);
  assert.equal(page.percent, 100, 'the page is scrolled back to its end');
  assert.equal(page.lowered, 1, 'the window is put back');
});

test('older messages the page loads at its top are read too', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const history = await readHistory(app, virtualPage(conversation(twelve), 8, 10), GPT, { turns: 50, skip: 0 }, soon());
  assert.deepEqual(
    history.turns.map((turn) => [turn.prompt, turn.reply]),
    twelve,
  );
});

test('older messages that load as the page reaches its top are read before it is taken for the start', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  // Each load ends as the page is moved to its top: it shows no more to load once the last
  // one has, and their messages are above what it then shows.
  const page = virtualPage(conversation(twelve), 8, 6);
  page.quick = true;
  const history = await readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon());
  assert.equal(history.turns.length, 12);
  assert.equal(history.more, false);
});

test('a page whose earlier prompts differ is not taken for the conversation, however its newest reads', async () => {
  const app = new FakeApp();
  listed(app, [
    ['X', 'x'],
    ['New A', 'a'],
    ['New B', 'b'],
    ['Continue', 'c'],
  ]);
  const stale = virtualPage(
    conversation([
      ['Old X', 'x'],
      ['Old Y', 'y'],
      ['Continue', 'old c'],
    ]),
  );
  await assert.rejects(readHistory(app, stale, GPT, { turns: 1, skip: 0 }, Date.now() + 200), code('WINDOW'));
});

test('a page that loads its older messages late is moved to its top again from what was read', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  // One load brings all older messages, far above what was read.
  const page = virtualPage(conversation(twelve), 8, 12);
  page.quick = true;
  page.loads = false;
  const read = page.pageState.bind(page);
  let waited = 0;
  // Once it is waited on at its top (the fifth read there), the page loads right after a read
  // has shown it unloaded.
  page.pageState = async (title, wait) => {
    const state = await read(title, wait);
    if (!page.loads && state?.older && page.percent <= 0 && ++waited === 5) {
      page.loads = true;
      page.load();
    }
    return state;
  };
  const saved = { ...timing };
  Object.assign(timing, { loadMs: 3000, retriggerMs: 100 });
  try {
    const history = await readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon());
    assert.equal(history.turns.length, 12);
  } finally {
    Object.assign(timing, saved);
  }
});

test('a page that does not load its older messages is not taken for the start', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve), 8, 10);
  page.loads = false;
  const saved = { ...timing };
  Object.assign(timing, { loadMs: 300, retriggerMs: 100 });
  try {
    await assert.rejects(readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon()), code('TIMEOUT'));
  } finally {
    Object.assign(timing, saved);
  }
});

test('replies that come on the page before their text are read once it shows', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve), 8, 10);
  page.unwritten = 2;
  const history = await readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon());
  assert.deepEqual(
    history.turns.map((turn) => [turn.prompt, turn.reply]),
    twelve,
  );
});

test('a page left scrolled up is scrolled to its end first', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  page.percent = 50;
  const history = await readHistory(app, page, GPT, { turns: 2, skip: 0 }, soon());
  assert.deepEqual(
    history.turns.map((turn) => turn.prompt),
    ['Question 10', 'Question 11'],
  );
});

test('a page of long messages, holding two turns, is still told apart by them', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const history = await readHistory(app, virtualPage(conversation(twelve), 4), GPT, { turns: 50, skip: 0 }, soon());
  assert.equal(history.turns.length, 12);
});

test('a prompt with a link is told apart by its text, as the page shows it', async () => {
  const app = new FakeApp();
  const typed: [string, string][] = [
    ['See [the docs](https://example.com/a) first', 'Read.'],
    ['**Then** this', 'Done.'],
  ];
  listed(app, typed);
  const shown: [string, string][] = [
    ['See the docs first', 'Read.'],
    ['Then this', 'Done.'],
  ];
  const history = await readHistory(app, virtualPage(conversation(shown)), GPT, { turns: 5, skip: 0 }, soon());
  assert.equal(history.turns.length, 2);
});

test('skip and turns choose turns further back, and tell whether older ones exist', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const history = await readHistory(app, virtualPage(conversation(twelve)), GPT, { turns: 3, skip: 2 }, soon());
  assert.deepEqual(
    history.turns.map((turn) => turn.prompt),
    ['Question 7', 'Question 8', 'Go on'],
  );
  assert.equal(history.more, true);
});

test('the app is started when it cannot be reached', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  page.windowOpen = false;
  const read = app.readThread.bind(app);
  app.readThread = async (...args) => {
    if (!page.launched) throw new AcbError('UNAVAILABLE', 'The ChatGPT desktop app is not running');
    return read(...args);
  };
  const history = await readHistory(app, page, GPT, { turns: 1, skip: 0 }, soon());
  assert.equal(page.launched, 1);
  assert.ok(page.givenBack >= 2, 'the foreground is given back while the app starts, not only after');
  assert.deepEqual(history.turns, [{ prompt: 'Question 11', reply: 'Answer 11' }]);
});

test('history opens the tray window even when the app tools already answer', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  page.windowOpen = false;
  const show = app.show.bind(app);
  app.show = async (id) => {
    assert.equal(page.windowOpen, true, 'navigation waits for the window to open');
    await show(id);
  };
  const history = await readHistory(app, page, GPT, { turns: 1, skip: 0 }, soon());
  assert.equal(page.launched, 1);
  assert.deepEqual(history.turns, [{ prompt: 'Question 11', reply: 'Answer 11' }]);
});

test('history returns a window opening failure before trying to read its page', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  page.launch = async () => {
    throw new AcbError('WINDOW', 'The ChatGPT desktop app did not open a window in time');
  };
  await assert.rejects(readHistory(app, page, GPT, { turns: 1, skip: 0 }, soon()), code('WINDOW'));
  assert.deepEqual(app.shown, []);
  assert.equal(page.givenBack, 1, 'the foreground is checked even when opening fails');
});

test('history restarts a transient page read once and still restores the window', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  const reveal = page.reveal.bind(page);
  let first = true;
  page.reveal = async (...args) => {
    if (first) {
      first = false;
      return false;
    }
    return reveal(...args);
  };
  const history = await readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon());
  assert.equal(history.turns.length, 12);
  assert.deepEqual(app.shown, [GPT, GPT]);
  assert.equal(page.lowered, 1);
  assert.equal(page.percent, 100);
  assert.deepEqual(app.sent, []);
});

test('history stops after a second page failure', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const page = virtualPage(conversation(twelve));
  page.reveal = async () => false;
  await assert.rejects(readHistory(app, page, GPT, { turns: 50, skip: 0 }, soon()), code('WINDOW'));
  assert.deepEqual(app.shown, [GPT, GPT]);
  assert.equal(page.lowered, 1);
});

test('a page whose end does not show the turns the app lists is not read', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const other: [string, string][] = twelve.map(([prompt, reply]) => [`Another ${prompt}`, reply]);
  await assert.rejects(
    readHistory(app, virtualPage(conversation(other)), GPT, { turns: 5, skip: 0 }, Date.now() + 200),
    code('WINDOW'),
  );
});

test('messages read further up are joined by runtime ID, not by text', () => {
  const known = conversation([['Go on', 'More.']]).map((message, index) => ({ ...message, id: `b${index}` }));
  const above = [...conversation([['Go on', 'More.']]), { ...known[0] }];
  assert.deepEqual(prepend(above, known), [...above.slice(0, 2), ...known]);
  assert.equal(prepend(conversation([['Go on', 'More.']]), known), undefined, 'no message in common');
});

test('known messages the page rendered anew must show, the same, above the joint', () => {
  const known = conversation([
    ['A', 'a'],
    ['B', 'b'],
  ]);
  // The page rendered the A turn anew (new IDs) and shows the turn before it, Z.
  const renewed = [
    { id: 'z1', role: 'you' as const, text: 'Z', complete: true },
    { id: 'z2', role: 'assistant' as const, text: 'z', complete: true },
    { ...known[0], id: 'n1' },
    { ...known[1], id: 'n2' },
    known[2],
  ];
  assert.deepEqual(
    prepend(renewed, known)?.map((message) => message.text),
    ['Z', 'z', 'A', 'a', 'B', 'b'],
  );
  const changed = renewed.map((message) => (message.id === 'n2' ? { ...message, text: 'other' } : message));
  assert.equal(prepend(changed, known), undefined, 'what shows above the joint is not what was read');
  assert.equal(prepend(renewed.slice(3), known), undefined, 'known messages above the joint are missing');
});

test('a reply still being written or without text is null, and replies above the first prompt are left out', () => {
  const messages: PageMessage[] = [
    { id: 'a', role: 'assistant', text: 'end of an earlier reply', complete: true },
    { id: 'b', role: 'you', text: 'Q', complete: true },
    { id: 'c', role: 'assistant', text: 'partial', complete: false },
    { id: 'd', role: 'you', text: 'R', complete: true },
    { id: 'e', role: 'assistant', text: '', complete: true },
  ];
  assert.deepEqual(toTurns(messages), [
    { prompt: 'Q', reply: null },
    { prompt: 'R', reply: null },
  ]);
});
