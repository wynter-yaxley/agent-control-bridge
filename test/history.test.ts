import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '../src/chatgpt.ts';
import { AcbError } from '../src/errors.ts';
import type { PageMessage, PageState } from '../src/helper.ts';
import { WindowsHelper } from '../src/helper.ts';
import { prepend, readHistory, toTurns } from '../src/history.ts';
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
    run: (task) => queue.run(task),
    holdForeground: async () => async () => {},
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
    async pageState(): Promise<PageState> {
      if (this.percent <= 0 && from > 0) {
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

test('a reply still being written is null, and replies above the first prompt are left out', () => {
  const messages: PageMessage[] = [
    { id: 'a', role: 'assistant', text: 'end of an earlier reply', complete: true },
    { id: 'b', role: 'you', text: 'Q', complete: true },
    { id: 'c', role: 'assistant', text: 'partial', complete: false },
  ];
  assert.deepEqual(toTurns(messages), [{ prompt: 'Q', reply: null }]);
});
