import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendPrompt } from '../src/conversation.ts';
import { AcbError } from '../src/errors.ts';
import { CODEX, FakeApp, GPT, userTurn } from './fake-app.ts';

/** Options waiting up to two seconds from the moment they are used. */
const fast = {
  get deadline() {
    return Date.now() + 2000;
  },
  pollMs: 1,
  wait: true,
};
const code = (expected: string) => (error: unknown) => error instanceof AcbError && error.code === expected;

test('a prompt is sent and its reply returned', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', title: 'Chat', turns: [userTurn('t0', 'earlier')] });
  app.answer = 'the reply';
  const sent = await sendPrompt(app, 'chatgpt', GPT, '  Question\r\n', fast);
  assert.deepEqual(app.sent, [{ id: GPT, prompt: 'Question' }]);
  assert.equal(sent.alreadySent, false);
  assert.equal(sent.title, 'Chat');
  assert.equal(sent.turn?.prompt, 'Question');
  assert.equal(sent.turn?.reply, 'the reply');
});

test('the newest prompt is not sent again; its reply is returned', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t1', 'Question', 'first reply')] });
  const sent = await sendPrompt(app, 'chatgpt', GPT, 'Question', fast);
  assert.deepEqual(app.sent, []);
  assert.equal(sent.alreadySent, true);
  assert.equal(sent.turn?.reply, 'first reply');
});

test('the newest prompt still running is waited for, not sent again', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt' });
  app.start(thread, 'Question');
  const sent = await sendPrompt(app, 'chatgpt', GPT, 'Question', fast);
  assert.deepEqual(app.sent, []);
  assert.equal(sent.turn?.reply, 'ok');
});

test('a conversation answering another prompt refuses a new one', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt' });
  app.start(thread, 'Other');
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Question', fast), code('BUSY'));
  assert.deepEqual(app.sent, []);
});

test('an archived conversation is restored once and the prompt sent', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex', archived: true });
  const sent = await sendPrompt(app, 'codex', CODEX, 'Question', { ...fast, caller: CODEX });
  assert.equal(app.threads.get(CODEX)?.archived, false);
  assert.deepEqual(app.sent, [{ id: CODEX, prompt: 'Question', caller: CODEX }]);
  assert.equal(sent.turn?.prompt, 'Question');
});

test('a turn waiting for approval is reported, not waited out', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  app.answer = (thread) => {
    thread.activeFlags = ['waitingOnApproval'];
  };
  await assert.rejects(sendPrompt(app, 'codex', CODEX, 'Run it', fast), code('NEEDS_USER'));
});

test('a turn that does not end in time is a TIMEOUT naming the conversation', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  app.answerAfterReads = Number.POSITIVE_INFINITY;
  await assert.rejects(
    sendPrompt(app, 'codex', CODEX, 'Slow', { ...fast, deadline: Date.now() + 20 }),
    (error) => code('TIMEOUT')(error) && (error as AcbError).details.threadId === CODEX,
  );
});

test('a failed turn is reported with its error', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  app.answer = (thread) => {
    thread.turns[0].status = 'failed';
    thread.turns[0].error = { message: 'usage limit' };
    thread.status = 'idle';
  };
  await assert.rejects(
    sendPrompt(app, 'codex', CODEX, 'Go', fast),
    (error) => code('FAILED')(error) && /usage limit/.test((error as Error).message),
  );
});

test('without wait, the prompt is sent and no turn is returned', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex' });
  const sent = await sendPrompt(app, 'codex', CODEX, 'Long task', { ...fast, wait: false });
  assert.equal(sent.turn, null);
  assert.equal(app.sent.length, 1);
});

test('a conversation of the other kind is refused before anything is sent', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  await assert.rejects(sendPrompt(app, 'codex', GPT, 'Hi', fast), code('INPUT'));
  assert.deepEqual(app.sent, []);
});

test('concurrent sends of one prompt deliver it once', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  app.listAfterMs = 30;
  const [first, second] = await Promise.all([
    sendPrompt(app, 'chatgpt', GPT, 'Question', fast),
    sendPrompt(app, 'chatgpt', GPT, 'Question', fast),
  ]);
  assert.equal(app.sent.length, 1);
  assert.deepEqual([first.alreadySent, second.alreadySent], [false, true]);
  assert.equal(second.turn?.turnId, first.turn?.turnId);
});

test('a different prompt sent before the first one is listed is refused', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  app.listAfterMs = 30;
  const first = sendPrompt(app, 'chatgpt', GPT, 'Question', { ...fast, wait: false });
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Other question', fast), code('BUSY'));
  await first;
  assert.deepEqual(
    app.sent.map((entry) => entry.prompt),
    ['Question'],
  );
});

test('a turn of another message waiting for approval is not reported as ours', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: CODEX, kind: 'codex' });
  app.answer = () => {
    // Someone else's message takes over and waits for approval.
    thread.turns.unshift(userTurn('foreign', 'Not ours', null, 'inProgress'));
    thread.activeFlags = ['waitingOnApproval'];
  };
  await assert.rejects(sendPrompt(app, 'codex', CODEX, 'Ours', fast), code('BUSY'));
});

test('an archived ChatGPT conversation is restored as a ChatGPT conversation', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt', archived: true });
  await sendPrompt(app, 'chatgpt', GPT, 'Question', fast);
  assert.deepEqual(app.archiving, [{ id: GPT, kind: 'chatgpt', archived: false }]);
});

test('a send whose outcome is unknown is never repeated', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  app.listAfterMs = 50;
  app.lostAnswer = new AcbError('PROTOCOL', 'The connection to the desktop app broke');
  await assert.rejects(
    sendPrompt(app, 'chatgpt', GPT, 'Question', fast),
    (error) => code('PROTOCOL')(error) && /may have been sent/.test((error as Error).message),
  );
  app.lostAnswer = null;
  const again = await sendPrompt(app, 'chatgpt', GPT, 'Question', fast);
  assert.equal(app.sent.length, 1);
  assert.equal(again.alreadySent, true);
  assert.equal(again.turn?.prompt, 'Question');
});

test('a message the app refused can be sent again', async () => {
  const app = new FakeApp();
  app.add({ id: GPT, kind: 'chatgpt' });
  app.refuse = new AcbError('FAILED', 'Rate limited', { refused: true });
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Question', fast), code('FAILED'));
  app.refuse = null;
  const again = await sendPrompt(app, 'chatgpt', GPT, 'Question', fast);
  assert.equal(again.alreadySent, false);
  assert.equal(app.sent.length, 1);
});
