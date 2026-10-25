import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '../src/chatgpt.ts';
import { AcbError } from '../src/errors.ts';
import type { PageMessage, PageState } from '../src/helper.ts';
import { WindowsHelper } from '../src/helper.ts';
import { prepend, readHistory, timing, toTurns } from '../src/history.ts';
import { FakeApp, GPT, userTurn } from './fake-app.ts';

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
  percent: number;
  launched: number;
  lowered: number;
  /** Times the foreground was given back. */
  givenBack: number;
  /** Whether it loads older messages when scrolled to its top. */
  loads: boolean;
}

/**
 * A page that holds only `held` messages around its scroll position, as the app's page does,
 * and moves to a position at once. With `chunk`, it has loaded only the newest `chunk`
 * messages, and loads `chunk` older ones each time it is read while scrolled to its top,
 * keeping what it shows in place.
 */
function virtualPage(messages: PageMessage[], held = 8, chunk = messages.length): FakeHistoryPage {
  const queue = new WindowsHelper();
  let from = Math.max(0, messages.length - chunk);
  const start = (percent: number) => Math.round((percent / 100) * (messages.length - from - held));
  return {
    percent: 100,
    launched: 0,
    lowered: 0,
    givenBack: 0,
    loads: true,
    run: (task) => queue.run(task),
    async holdForeground() {
      return async () => {
        this.givenBack++;
      };
    },
    async launch() {
      this.launched++;
      return true;
    },
    async raise() {
      return async () => {
        this.lowered++;
      };
    },
    async scroll(_title, percent) {
      this.percent = percent;
      return true;
    },
    async reveal(_title, ids) {
      const loaded = messages.slice(from);
      const shown = loaded.slice(start(this.percent), start(this.percent) + held);
      const target = ids.find((id) => shown.some((message) => message.id === id));
      if (target === undefined) return false;
      // The message goes to the top of the screen; the page holds half its messages above that.
      const first = Math.max(0, loaded.findIndex((message) => message.id === target) - held / 2);
      this.percent = loaded.length > held ? (first / (loaded.length - held)) * 100 : 100;
      return true;
    },
    async pageState(): Promise<PageState> {
      if (this.percent <= 0 && from > 0 && this.loads) {
        const added = Math.min(chunk, from);
        from -= added;
        this.percent = (added / (messages.length - from - held)) * 100;
      }
      const loaded = messages.slice(from);
      const shown = loaded.slice(start(this.percent), start(this.percent) + held);
      const last = shown.findLastIndex((message) => message.role === 'you');
      return {
        busy: false,
        atEnd: this.percent >= 100,
        scroll: { percent: this.percent, view: (held / 2 / loaded.length) * 100 },
        older: from > 0,
        messages: shown,
        prompts: shown.filter((message) => message.role === 'you').map((message) => message.text),
        reply: shown[last + 1]?.text ?? '',
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

test('a page whose end does not show the turns the app lists is not read', async () => {
  const app = new FakeApp();
  listed(app, twelve);
  const other: [string, string][] = twelve.map(([prompt, reply]) => [`Another ${prompt}`, reply]);
  await assert.rejects(
    readHistory(app, virtualPage(conversation(other)), GPT, { turns: 5, skip: 0 }, Date.now() + 1500),
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

test('a reply still being written is null, and replies above the first prompt are left out', () => {
  const messages: PageMessage[] = [
    { id: 'a', role: 'assistant', text: 'end of an earlier reply', complete: true },
    { id: 'b', role: 'you', text: 'Q', complete: true },
    { id: 'c', role: 'assistant', text: 'partial', complete: false },
  ];
  assert.deepEqual(toTurns(messages), [{ prompt: 'Q', reply: null }]);
});
