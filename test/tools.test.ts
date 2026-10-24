import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpt, listGpt, type Page, readGpt, sendGpt } from '../src/chatgpt.ts';
import { createCodex, listCodex, sendCodex } from '../src/codex.ts';
import { AcbError } from '../src/errors.ts';
import { type PageState, WindowsHelper } from '../src/helper.ts';
import { CODEX, FakeApp, type FakeThread, GPT, userTurn } from './fake-app.ts';

/** Options waiting up to two seconds from the moment they are used. */
const fast = {
  get deadline() {
    return Date.now() + 2000;
  },
  pollMs: 1,
};
const PAGE_REPLY = '::chatgpt-content-reference{index="0" source_message_id="m1"}';
const code = (expected: string) => (error: unknown) => error instanceof AcbError && error.code === expected;

interface FakePage extends Page {
  reads: { title: string; prompts: string[] }[];
  chats: string[];
  /** What the page shows; by default it shows no conversation, so only the app's list counts. */
  view: () => PageState | null;
}

/**
 * A ChatGPT page with the real operation queue. It reads `reply` once the app was asked to
 * show a conversation, and starting a chat adds a conversation opened by the prompt.
 */
function fakePage(app: FakeApp, reply = 'reply from the page'): FakePage {
  const queue = new WindowsHelper();
  let created = 0;
  return {
    reads: [],
    chats: [],
    view: () => null,
    run: (task) => queue.run(task),
    holdForeground: async () => async () => {},
    async pageState() {
      return this.view();
    },
    async readReply(title, prompts) {
      this.reads.push({ title, prompts });
      if (!app.shown.length) throw new AcbError('WINDOW', 'nothing shown');
      return reply;
    },
    async startChat(prompt) {
      this.chats.push(prompt);
      const id = `6adc9087-70c4-83e8-8f06-${String(++created).padStart(12, '0')}`;
      app.start(app.add({ id, kind: 'chatgpt', title: 'Auto title' }), prompt);
    },
  };
}

const answerOnPage = (thread: FakeThread) => {
  thread.turns[0].status = 'completed';
  thread.turns[0].items.push({ type: 'agentMessage', text: PAGE_REPLY });
  thread.status = 'idle';
};

test('Codex conversations are filtered by folder regardless of case and separators', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex', cwd: 'D:\\Work\\Repo' });
  app.add({ id: '01a16d92-0000-7000-8000-000000000009', kind: 'codex', cwd: 'D:\\Other' });
  app.add({ id: GPT, kind: 'chatgpt' });
  const listed = await listCodex(app, { cwd: 'd:/work/repo/' });
  assert.deepEqual(
    listed.map((thread) => thread.id),
    [CODEX],
  );
});

test('a kind of conversation the app could not list is not an empty list', async () => {
  const app = new FakeApp();
  app.unavailable = ['chatgpt'];
  await assert.rejects(listGpt(app), code('UNAVAILABLE'));
});

test('a Codex message names its own conversation as caller', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  await sendCodex(app, CODEX, 'Hi', { ...fast, wait: true });
  assert.equal(app.sent[0].caller, CODEX);
});

test('a Codex message too long to be read back whole is refused before sending', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  // 5,000 ampersands become 25,000 characters once the app escapes them.
  await assert.rejects(sendCodex(app, CODEX, '&'.repeat(5000), { ...fast, wait: true }), code('INPUT'));
  assert.deepEqual(app.sent, []);
});

test('a Codex conversation is created in a project or in a new folder', async () => {
  const app = new FakeApp();
  const projectId = 'bee59c1b-2a5e-4e67-9bbe-12f8152b606d';
  const inProject = await createCodex(app, { prompt: 'Build it', title: 'Task', projectId, wait: true }, fast);
  await createCodex(app, { prompt: 'Draft it', folder: 'notes', wait: false }, fast);
  assert.deepEqual(
    app.created.map((entry) => entry.target),
    [
      { type: 'project', projectId, environment: { type: 'local' } },
      { type: 'projectless', directoryName: 'notes' },
    ],
  );
  assert.equal(inProject.turn?.reply, 'ok');
  assert.equal(inProject.title, 'Task');
});

test('a ChatGPT reply kept on the page is read there after sending', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat' });
  app.answer = answerOnPage;
  const page = fakePage(app);
  const sent = await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  assert.ok(app.shown.every((id) => id === GPT));
  assert.deepEqual(page.reads, [{ title: 'Chat', prompts: ['Question'] }]);
  assert.equal(sent.turn?.reply, 'reply from the page');
  assert.equal(sent.turn?.replyOnPage, false);
});

test('a page that cannot be read leaves a successful send with the reason', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  app.answer = answerOnPage;
  const page = fakePage(app);
  page.readReply = async () => {
    throw new AcbError('WINDOW', 'covered');
  };
  const sent = await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  assert.equal(sent.turn?.replyOnPage, true);
  assert.match(sent.pageError ?? '', /covered.*page: true/);
});

test('a reply read while the conversation moved on is not returned', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t1', 'Q', PAGE_REPLY)] });
  const page = fakePage(app);
  page.readReply = async () => {
    app.start(thread, 'A newer question');
    return 'reply of t1, or of the newer one?';
  };
  await assert.rejects(readGpt(app, page, GPT, { fromPage: true }), code('BUSY'));
});

test('reading from the page only touches the newest finished reply', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t1', 'Q', PAGE_REPLY)] });
  const page = fakePage(app);
  assert.equal((await readGpt(app, page, GPT)).turns[0].replyOnPage, true);
  assert.deepEqual(app.shown, []);
  const read = await readGpt(app, page, GPT, { fromPage: true });
  assert.equal(read.turns[0].reply, 'reply from the page');
});

test('a new ChatGPT conversation is found by its first message and titled after its reply', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Existing' });
  const page = fakePage(app);
  const created = await createGpt(app, page, { prompt: 'Start here', title: 'My title' }, fast);
  assert.equal(app.shown[0], GPT, 'an existing conversation puts the window in ChatGPT mode');
  assert.deepEqual(page.chats, ['Start here']);
  assert.equal(created.conversationId, '6adc9087-70c4-83e8-8f06-000000000001');
  assert.equal(created.title, 'My title');
  assert.equal(created.turn.reply, 'ok');
});

test('concurrent creations with the same prompt each get their own conversation', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  const page = fakePage(app);
  const [first, second] = await Promise.all([
    createGpt(app, page, { prompt: 'Same' }, fast),
    createGpt(app, page, { prompt: 'Same' }, fast),
  ]);
  assert.notEqual(first.conversationId, second.conversationId);
});

test('a page cannot tell apart conversations with the same title', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Same', turns: [userTurn('t1', 'Q', PAGE_REPLY)] });
  app.add({ id: '6adc9087-70c4-83e8-8f06-a3c84ccaa86d', kind: 'chatgpt', title: 'Same' });
  await assert.rejects(readGpt(app, fakePage(app), GPT, { fromPage: true }), code('WINDOW'));
  assert.deepEqual(app.shown, []);
});

test('the page must end with the prompts of the turns the app lists', async () => {
  const app = new FakeApp();
  app.add({
    id: GPT,
    kind: 'chatgpt',
    turns: [userTurn('t3', 'S', PAGE_REPLY), userTurn('t2', 'R', PAGE_REPLY), userTurn('t1', 'Q', PAGE_REPLY)],
  });
  const page = fakePage(app);
  await readGpt(app, page, GPT, { fromPage: true });
  assert.deepEqual(page.reads[0].prompts, ['Q', 'R', 'S']);
});

test('a page is not read when the prompts repeat, as an older state of it would match', async () => {
  const app = new FakeApp();
  app.add({
    id: GPT,
    kind: 'chatgpt',
    turns: ['Q', 'R', 'Q', 'R'].map((prompt, index) => userTurn(`t${4 - index}`, prompt, PAGE_REPLY)),
  });
  const page = fakePage(app);
  await assert.rejects(readGpt(app, page, GPT, { fromPage: true }), code('WINDOW'));
  assert.deepEqual(page.reads, []);
});

/** A finished page showing `prompts`. */
const showing = (prompts: string[], reply = 'Earlier reply'): PageState => ({
  busy: false,
  prompts,
  reply,
  complete: true,
});

/** A page with one earlier exchange that shows `reply` to `prompt` once the app has taken it. */
function answeringPage(app: FakeApp, page: FakePage, prompt: string, reply: string): void {
  page.view = () => {
    const sent = app.sent.filter((entry) => entry.id === GPT).map((entry) => entry.prompt);
    return sent.includes(prompt) ? showing(['Earlier', ...sent], reply) : showing(['Earlier', ...sent]);
  };
}

/** A ChatGPT conversation with one earlier turn whose new turns the app lists a minute late. */
function lateConversation(): FakeApp {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns: [userTurn('t1', 'Earlier', PAGE_REPLY)] });
  app.listAfterMs = 60_000;
  return app;
}

test('a ChatGPT reply on the page is returned without waiting for the app to list it', async () => {
  const app = lateConversation();
  const page = fakePage(app);
  answeringPage(app, page, 'Question', 'reply from the page');
  const sent = await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  assert.equal(sent.turn?.turnId, null);
  assert.equal(sent.turn?.reply, 'reply from the page');
});

test("a page that does not catch up leaves the reply to the app's list", async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns: [userTurn('t1', 'Earlier', 'Earlier reply')] });
  const page = fakePage(app);
  page.view = () => showing(['Earlier']);
  const sent = await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  assert.equal(typeof sent.turn?.turnId, 'string');
  assert.equal(sent.turn?.reply, 'ok');
});

test('a page stuck at an older state is not taken for the reply', async () => {
  const app = new FakeApp();
  const turns = ['R', 'Q', 'R'].map((prompt, index) => userTurn(`t${3 - index}`, prompt, 'listed reply'));
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns });
  const page = fakePage(app);
  // The window was covered after the first Q was answered.
  page.view = () => showing(['R', 'Q'], 'reply to the first Q');
  const sent = await sendGpt(app, page, GPT, 'Q', { ...fast, wait: true });
  assert.equal(app.sent.length, 1);
  assert.equal(sent.turn?.reply, 'ok');
});

test('a reply confirmed on the page is returned again, and does not hold back the next message', async () => {
  const app = lateConversation();
  const page = fakePage(app);
  answeringPage(app, page, 'First', 'first reply');
  await sendGpt(app, page, GPT, 'First', { ...fast, wait: true });
  const again = await sendGpt(app, page, GPT, 'First', { ...fast, wait: true });
  assert.deepEqual([again.alreadySent, again.turn?.reply], [true, 'first reply']);
  const second = await sendGpt(app, page, GPT, 'Second', { ...fast, wait: false });
  assert.equal(second.alreadySent, false);
  assert.deepEqual(
    app.sent.map((entry) => entry.prompt),
    ['First', 'Second'],
  );
});

test('a message that was certainly not sent keeps the protection of the one before', async () => {
  const app = lateConversation();
  const page = fakePage(app);
  answeringPage(app, page, 'First', 'first reply');
  await sendGpt(app, page, GPT, 'First', { ...fast, wait: true });
  app.refuse = new AcbError('FAILED', 'Rate limited', { refused: true });
  await assert.rejects(sendGpt(app, page, GPT, 'Second', { ...fast, wait: true }), code('FAILED'));
  app.refuse = null;
  const again = await sendGpt(app, page, GPT, 'First', { ...fast, wait: true });
  assert.equal(again.alreadySent, true);
  assert.deepEqual(
    app.sent.map((entry) => entry.prompt),
    ['First'],
  );
});

test('a page busy with a message the app does not list yet refuses a new one', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns: [userTurn('t1', 'Earlier', PAGE_REPLY)] });
  const page = fakePage(app);
  page.view = () => ({ busy: true, prompts: ['Earlier', 'Typed in the app'], reply: '', complete: false });
  await assert.rejects(sendGpt(app, page, GPT, 'Question', { ...fast, wait: true }), code('BUSY'));
  assert.deepEqual(app.sent, []);
});

test('a prompt the page shows as its newest message is not sent again', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns: [userTurn('t1', 'Earlier', PAGE_REPLY)] });
  const page = fakePage(app);
  page.view = () => showing(['Earlier', 'Question'], 'reply from the page');
  const sent = await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  assert.deepEqual(app.sent, []);
  assert.deepEqual([sent.alreadySent, sent.turn?.reply], [true, 'reply from the page']);
});

test('a reply confirmed on the page is read back before the app lists it', async () => {
  const app = lateConversation();
  const page = fakePage(app);
  answeringPage(app, page, 'Question', 'reply from the page');
  await sendGpt(app, page, GPT, 'Question', { ...fast, wait: true });
  const read = await readGpt(app, page, GPT, { turns: 2, fromPage: true });
  assert.deepEqual(
    read.turns.map((turn) => [turn.turnId, turn.prompt, turn.reply]),
    [
      ['t1', 'Earlier', null],
      [null, 'Question', 'reply from the page'],
    ],
  );
  assert.equal(page.reads.length, 0);
});
