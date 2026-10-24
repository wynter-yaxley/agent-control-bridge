import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpt, listGpt, type Page, readGpt, sendGpt } from '../src/chatgpt.ts';
import { createCodex, listCodex, sendCodex } from '../src/codex.ts';
import { AcbError } from '../src/errors.ts';
import { WindowsHelper } from '../src/helper.ts';
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
  reads: { title: string; prompt: string; messages: number }[];
  chats: string[];
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
    run: (task) => queue.run(task),
    holdForeground: async () => async () => {},
    async readReply(title, prompt, messages) {
      this.reads.push({ title, prompt, messages });
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
  assert.deepEqual(app.shown, [GPT]);
  assert.deepEqual(page.reads, [{ title: 'Chat', prompt: 'Question', messages: 1 }]);
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

test('the page must show as many messages as the conversation has turns', async () => {
  const app = new FakeApp();
  app.add({
    id: GPT,
    kind: 'chatgpt',
    turns: [userTurn('t3', 'Q', PAGE_REPLY), userTurn('t2', 'R', PAGE_REPLY), userTurn('t1', 'Q', PAGE_REPLY)],
  });
  const page = fakePage(app);
  await readGpt(app, page, GPT, { fromPage: true });
  assert.equal(page.reads[0].messages, 3, 'a page stuck at the first Q shows only one message');
});

test('counting a long conversation stops when no time is left for the page', async () => {
  const app = new FakeApp();
  const turns = Array.from({ length: 25 }, (_, index) => userTurn(`t${25 - index}`, `Q${25 - index}`, PAGE_REPLY));
  app.add({ id: GPT, kind: 'chatgpt', turns });
  const page = fakePage(app);
  assert.equal((await readGpt(app, page, GPT, { fromPage: true })).turns[0].reply, 'reply from the page');
  assert.equal(page.reads[0].messages, 25, 'every page of turns is counted');
  // Once the reply is in, every read takes 200 ms: the page budget runs out while counting.
  app.answer = (thread) => {
    answerOnPage(thread);
    app.afterRead = () => {
      const until = Date.now() + 200;
      while (Date.now() < until);
    };
  };
  const sent = await sendGpt(app, page, GPT, 'One more', { deadline: Date.now() + 300, pollMs: 1, wait: true });
  assert.equal(sent.turn?.replyOnPage, true);
  assert.match(sent.pageError ?? '', /No time was left/);
});
