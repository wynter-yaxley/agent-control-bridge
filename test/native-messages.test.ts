import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeChatMessageHost, observeNativeChatMessage, type NativeChatPage } from '../src/native-messages.ts';
import { BridgeError } from '../src/errors.ts';

const prompt = '[isolated test] echo marker';
const target = { conversationId: 'fixture-chat', name: 'fixture-project' };
function page(reply?: string): NativeChatPage {
  return { thread: { id: target.conversationId, kind: 'chatgpt', title: target.name, status: { type: 'idle' } }, turns: reply === undefined ? [] : [
    { id: 'new-turn', status: 'completed', error: null, items: [
      { type: 'userMessage', id: 'new-turn', content: [{ type: 'text', text: prompt }] },
      { type: 'agentMessage', id: 'new-reply', text: reply },
    ] },
  ] };
}

test('native messages: only a new matching user turn with an idle complete reply is accepted', () => {
  const before = page('old reply'), after = page('new reply');
  after.turns[0].id = 'next-turn';
  assert.equal(observeNativeChatMessage(before, before, prompt).status, 'delivery_uncertain');
  after.thread.status.type = 'active';
  assert.equal(observeNativeChatMessage(before, after, prompt).status, 'sent_reply_pending');
  after.thread.status.type = 'idle';
  assert.equal(observeNativeChatMessage(before, after, prompt).reply, 'new reply');
  after.turns[0].error = { message: 'fixture failure' };
  assert.equal(observeNativeChatMessage(before, after, prompt).status, 'turn_failed');
});

test('native messages: native content references and truncated text are never complete replies', () => {
  const before = page(), after = page('::chatgpt-content-reference{index="0" source_message_id="fixture-reply"}');
  const reference = observeNativeChatMessage(before, after, prompt);
  assert.equal(reference.status, 'reply_content_unavailable'); assert.equal(reference.reply, null); assert.equal(reference.replyMessageId, 'new-reply');
  const truncated = page('partial reply'); truncated.turns[0].items[1] = { type: 'agentMessage', id: 'new-reply', text: 'partial reply', truncated: true };
  assert.equal(observeNativeChatMessage(before, truncated, prompt).status, 'reply_content_unavailable');
});

test('native messages: exact destination/name are checked before any native send', async () => {
  let sends = 0;
  const host = new NativeChatMessageHost({ readThread: async () => page(), sendMessage: async () => { sends++; return { threadId: target.conversationId }; } });
  await assert.rejects(host.sendAndWait({ ...target, name: 'other' }, prompt, { timeoutMs: 500, intervalMs: 100 }), { code: 'PROVENANCE' });
  assert.equal(sends, 0);
});

test('native messages: an ambiguous send is observed once, never replayed, and its error is returned', async () => {
  let reads = 0, sends = 0;
  const host = new NativeChatMessageHost({
    readThread: async () => ++reads === 1 ? page() : page('reply'),
    sendMessage: async () => { sends++; throw new BridgeError('IO', 'fixture transport disconnect'); },
  });
  const result = await host.sendAndWait(target, prompt, { timeoutMs: 500, intervalMs: 100 });
  assert.equal(sends, 1); assert.equal(result.status, 'completed'); assert.equal(result.reply, 'reply');
  assert.deepEqual(result.errors, [{ stage: 'send', code: 'IO' }]);
});

test('native messages: a receipt alone proves no delivery; observation errors are explicit', async () => {
  let reads = 0, sends = 0;
  const host = new NativeChatMessageHost({
    readThread: async () => { if (++reads === 1) return page(); throw new BridgeError('TIMEOUT', 'fixture unavailable read'); },
    sendMessage: async () => { sends++; return { threadId: target.conversationId }; },
  });
  const result = await host.sendAndWait(target, prompt, { timeoutMs: 500, intervalMs: 100 });
  assert.equal(sends, 1); assert.equal(result.status, 'delivery_uncertain');
  assert.deepEqual(result.errors, [{ stage: 'read', code: 'TIMEOUT' }]);
});
