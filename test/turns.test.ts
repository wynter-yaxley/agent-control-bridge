import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opensWith, promptOf, statusOf, toConversation, toTurn } from '../src/turns.ts';
import { CALLER, CODEX, delegatedTurn, userTurn } from './fake-app.ts';

test('a user message opens the turn and the final answer is its reply', () => {
  const turn = userTurn('t1', 'Hello\r\nthere ', 'Hi');
  turn.items.splice(1, 0, { type: 'agentMessage', phase: 'commentary', text: 'thinking aloud' });
  assert.deepEqual(toTurn(turn), {
    turnId: 't1',
    status: 'completed',
    prompt: 'Hello\nthere',
    reply: 'Hi',
    replyOnPage: false,
    truncated: false,
    error: null,
  });
});

test('a delegated message is read from its delegation envelope', () => {
  const turn = delegatedTurn('t1', 'a <b> & c', 'done');
  assert.deepEqual(promptOf(turn), { text: 'a <b> & c', complete: true });
  assert.equal(opensWith(turn, 'a <b> & c'), true);
  assert.equal(opensWith(turn, 'a <b>'), false);
});

test('a shortened delegation is a prefix that matches only longer messages it starts', () => {
  const text = `<codex_delegation>\n  <source_thread_id>${CALLER}</source_thread_id>\n  <input>first part &am`;
  const turn = {
    id: 't1',
    status: 'completed',
    error: null,
    items: [{ type: 'functionCallOutput', output: { text, truncated: true } }],
  };
  assert.deepEqual(promptOf(turn), { text: 'first part', complete: false });
  assert.equal(opensWith(turn, 'first part & more'), true);
  assert.equal(opensWith(turn, 'other'), false);
  assert.equal(toTurn(turn).truncated, true);
});

test('tool output later in a turn is not taken for its prompt', () => {
  const turn = userTurn('t1', 'real prompt');
  turn.items.push(delegatedTurn('x', 'not a prompt').items[0]);
  assert.equal(toTurn(turn).prompt, 'real prompt');
});

test('a ChatGPT reply kept only on the page is flagged, not returned as text', () => {
  const turn = userTurn('t1', 'q', '::chatgpt-content-reference{index="0" source_message_id="m1"}');
  assert.equal(toTurn(turn).reply, null);
  assert.equal(toTurn(turn).replyOnPage, true);
});

test('failed turns carry their error message', () => {
  const turn = { ...userTurn('t1', 'q', null, 'failed'), error: { message: 'quota exceeded' } };
  assert.equal(toTurn(turn).error, 'quota exceeded');
});

test('status distinguishes a running turn from one waiting for the user', () => {
  assert.equal(statusOf({ status: 'notLoaded', activeFlags: [] }), 'idle');
  assert.equal(statusOf({ status: 'active', activeFlags: [] }), 'running');
  assert.equal(statusOf({ status: 'active', activeFlags: ['waitingOnApproval'] }), 'needsUser');
});

test('a conversation lists its turns oldest first', () => {
  const conversation = toConversation({
    id: CODEX,
    kind: 'codex',
    title: 'T',
    status: 'idle',
    activeFlags: [],
    cwd: null,
    turns: [userTurn('new', 'second'), userTurn('old', 'first')],
    nextCursor: 'c',
  });
  assert.deepEqual(
    conversation.turns.map((turn) => turn.turnId),
    ['old', 'new'],
  );
  assert.equal(conversation.nextCursor, 'c');
});
