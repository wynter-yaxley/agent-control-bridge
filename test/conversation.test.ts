import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type Live, sendPrompt, waitForTurn } from '../src/conversation.ts';
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

test('another message waiting for approval is not reported as ours', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: CODEX, kind: 'codex' });
  app.listAfterMs = 10_000;
  const sending = sendPrompt(app, 'codex', CODEX, 'Ours', { ...fast, deadline: Date.now() + 200 });
  while (!app.sent.length) await delay(1);
  // Before ours is listed, someone else's message starts and waits for approval.
  thread.turns.unshift(userTurn('foreign', 'Not ours', null, 'inProgress'));
  thread.status = 'active';
  thread.activeFlags = ['waitingOnApproval'];
  await assert.rejects(sending, code('TIMEOUT'));
});

test('another message listed first does not end the protection of ours', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt' });
  app.listAfterMs = 10_000;
  app.lostAnswer = new AcbError('PROTOCOL', 'The connection to the desktop app broke');
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Q', fast), code('PROTOCOL'));
  app.lostAnswer = null;
  thread.turns.unshift(userTurn('r', 'R', 'answer to R'));
  await sendPrompt(app, 'chatgpt', GPT, 'Q', { ...fast, wait: false });
  assert.equal(app.sent.length, 1, 'Q is still unlisted, so it is not sent again');
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Something else', fast), code('BUSY'));
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

test('a message listed between two reads of a send is not sent again', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt' });
  app.listAfterMs = 60_000;
  app.lostAnswer = new AcbError('PROTOCOL', 'The connection to the desktop app broke');
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Q', fast), code('PROTOCOL'));
  app.lostAnswer = null;
  // The app lists Q right after the next send has taken its first look at the conversation.
  app.afterRead = (reads) => {
    if (reads === 1) app.start(thread, 'Q');
  };
  const again = await sendPrompt(app, 'chatgpt', GPT, 'Q', fast);
  assert.equal(app.sent.length, 1);
  assert.equal(again.alreadySent, true);
  assert.equal(again.turn?.reply, 'ok');
});

test('a turn named by its ID is found further back than the newest three', async () => {
  const app = new FakeApp();
  app.add({
    id: GPT,
    kind: 'chatgpt',
    turns: ['t5', 't4', 't3', 't2', 't1'].map((id) => userTurn(id, id)),
  });
  const turn = await waitForTurn(app, GPT, 't1', { turnId: 't1' }, fast);
  assert.equal(turn.turnId, 't1');
});

/** A page that confirms the reply to every prompt at once, or never. */
const page =
  (confirms: boolean) =>
  async (prompt: string): Promise<Live> => ({
    placed: true,
    ahead: false,
    newest: false,
    busy: false,
    reply: async () =>
      confirms
        ? {
            turnId: null,
            status: 'completed',
            prompt,
            reply: `page reply to ${prompt}`,
            replyOnPage: false,
            truncated: false,
            error: null,
          }
        : undefined,
  });

test('a prompt sent again is matched to its own turn, not to the earlier one', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t0', 'X')] });
  app.listAfterMs = 60_000;
  await sendPrompt(app, 'chatgpt', GPT, 'A', { ...fast, watch: page(true) });
  await sendPrompt(app, 'chatgpt', GPT, 'B', { ...fast, watch: page(true) });
  const third = sendPrompt(app, 'chatgpt', GPT, 'A', { ...fast, deadline: Date.now() + 300, watch: page(false) });
  // Once all three are sent, the app lists the first A only, then B and the second A.
  while (app.sent.length < 3) await delay(1);
  thread.turns.unshift(userTurn('a1', 'A', 'reply to the first A'));
  await assert.rejects(third, code('TIMEOUT'));
  thread.turns.unshift(userTurn('a2', 'A', 'reply to the second A'), userTurn('b', 'B'));
  const again = await sendPrompt(app, 'chatgpt', GPT, 'A', fast);
  assert.deepEqual([again.alreadySent, again.turn?.reply], [true, 'reply to the second A']);
  assert.equal(app.sent.length, 3);
});

test('a turn is not looked for among turns that may not follow the one it was sent after', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t0', 'X')] });
  app.listAfterMs = 60_000;
  const sending = sendPrompt(app, 'chatgpt', GPT, 'Q', { ...fast, deadline: Date.now() + 300 });
  while (!app.sent.length) await delay(1);
  // Q, then ten more turns, the last of them Q again: t0 is no longer among the newest ten.
  const later = ['Q', ...Array.from({ length: 9 }, (_, index) => `other ${index}`), 'Q'];
  thread.turns.unshift(
    ...later.map((prompt, index) => userTurn(`t${index + 1}`, prompt, `reply of t${index + 1}`)).reverse(),
  );
  await assert.rejects(sending, code('TIMEOUT'));
});

test('a message of unknown outcome that can no longer be matched is never sent again on its own', async () => {
  const app = new FakeApp();
  const thread = app.add({ id: GPT, kind: 'chatgpt', turns: [userTurn('t0', 'X')] });
  app.listAfterMs = 60_000;
  app.lostAnswer = new AcbError('PROTOCOL', 'The connection to the desktop app broke');
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Q', fast), code('PROTOCOL'));
  app.lostAnswer = null;
  // The conversation goes on elsewhere, until t0 is older than the turns the app returns.
  thread.turns.unshift(...Array.from({ length: 10 }, (_, index) => userTurn(`t${10 - index}`, `other ${10 - index}`)));
  await assert.rejects(sendPrompt(app, 'chatgpt', GPT, 'Q', fast), code('TIMEOUT'));
  await sendPrompt(app, 'chatgpt', GPT, 'Something else', { ...fast, wait: false });
  assert.deepEqual(
    app.sent.map((entry) => entry.prompt),
    ['Q', 'Something else'],
  );
});
