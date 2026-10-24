import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpt, type Page, readGpt, sendGpt } from '../src/chatgpt.ts';
import { createCodex, listCodex, sendCodex } from '../src/codex.ts';
import { AcbError } from '../src/errors.ts';
import { CODEX, FakeApp, type FakeThread, GPT, userTurn } from './fake-app.ts';

const fast = { timeoutMs: 2000, pollMs: 1 };
const PAGE_REPLY = '::chatgpt-content-reference{index="0" source_message_id="m1"}';

/** A page that shows whatever conversation the app was last asked to show. */
function fakePage(
  app: FakeApp,
  reply = 'reply from the page',
): Page & { reads: { title: string; prompt: string }[]; chats: string[] } {
  return {
    reads: [],
    chats: [],
    run: (task) => task(),
    async readReply(title, prompt) {
      this.reads.push({ title, prompt });
      if (!app.shown.length) throw new AcbError('WINDOW', 'nothing shown');
      return reply;
    },
    async startChat(prompt) {
      this.chats.push(prompt);
      const thread = app.add({ id: '6adc9087-70c4-83e8-8f06-a3c84ccaa86d', kind: 'chatgpt', title: 'Auto title' });
      app.start(thread, prompt);
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

test('a Codex message names its own conversation as caller', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  await sendCodex(app, CODEX, 'Hi', { ...fast, wait: true });
  assert.equal(app.sent[0].caller, CODEX);
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
  assert.deepEqual(page.reads, [{ title: 'Chat', prompt: 'Question' }]);
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
  assert.deepEqual(app.shown[0], GPT, 'an existing conversation puts the window in ChatGPT mode');
  assert.deepEqual(page.chats, ['Start here']);
  assert.equal(created.conversationId, '6adc9087-70c4-83e8-8f06-a3c84ccaa86d');
  assert.equal(created.title, 'My title');
  assert.equal(created.turn.reply, 'ok');
});
