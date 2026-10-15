import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { sendGpt } from '../src/gpt.ts';
import { sendCodex } from '../src/codex.ts';
import type { NativeChatPage } from '../src/native.ts';

const prompt = '[TEST] reply with OK';
const page = (status: string, turns: NativeChatPage['turns'], kind = 'chatgpt'): NativeChatPage => ({ thread: { id: 'gpt-id', kind, title: '测试消息', status: { type: status } }, turns });
const answered = (id: string, text = prompt): NativeChatPage['turns'][number] => ({ id, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text }] }, { type: 'agentMessage', id: `a-${id}`, text: '[native]' }] });

function gpt(pages: NativeChatPage[]) {
  const calls: { operation: string; name: string }[] = [];
  const deps = { native: { readThread: async () => pages.length > 1 ? pages.shift()! : pages[0] }, timeoutMs: 1000, pollMs: 1,
    ui: { call: async (operation: 'chat-send' | 'chat-read-reply', fields: { name: string }) => { calls.push({ operation, name: fields.name });
      return operation === 'chat-send' ? { ok: true } : { ok: true, conversationId: null, identity: 'titleOnly' as const, completionVerified: true, body: 'OK' }; } } };
  return { deps, calls };
}

test('gpt: sends once to the natively titled target and returns the UI reply after native completion', async () => {
  const { deps, calls } = gpt([page('idle', [answered('old', 'earlier')]), page('active', [answered('old', 'earlier')]), page('idle', [answered('new')])]);
  const result = await sendGpt(deps, 'gpt-id', prompt);
  assert.deepEqual(calls, [{ operation: 'chat-send', name: '测试消息' }, { operation: 'chat-read-reply', name: '测试消息' }]);
  assert.deepEqual({ ...result }, { conversationId: 'gpt-id', title: '测试消息', turnId: 'new', reply: 'OK', alreadySent: false, uiIdentity: 'titleOnly' });
});

test('gpt: an already sent prompt is never resent; busy or non-GPT targets are refused before any UI call', async () => {
  const repeat = gpt([page('idle', [answered('new')])]);
  assert.equal((await sendGpt(repeat.deps, 'gpt-id', prompt)).alreadySent, true);
  assert.deepEqual(repeat.calls.map(call => call.operation), ['chat-read-reply']);
  for (const [pages, code] of [[[page('active', [{ ...answered('new'), status: 'inProgress' }])], 'CONFLICT'], [[page('active', [answered('old', 'earlier')])], 'CONFLICT'], [[page('idle', [], 'codex')], 'PROVENANCE']] as const) {
    const blocked = gpt([...pages]);
    await assert.rejects(sendGpt(blocked.deps, 'gpt-id', prompt), { code });
    assert.equal(blocked.calls.length, 0);
  }
});

/** A scripted codex app-server: answers JSON-RPC lines and records them. */
function appServer(turns: Record<string, unknown>[]) {
  const seen: Record<string, any>[] = [];
  const spawnFn = (() => {
    const child = new EventEmitter() as any, stdout = new PassThrough();
    child.stdout = stdout; child.stderr = new PassThrough(); child.kill = () => true;
    const reply = (message: unknown) => stdout.write(JSON.stringify(message) + '\n');
    child.stdin = new Writable({ write(data, _encoding, done) {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const message = JSON.parse(line); seen.push(message);
        if (message.method === 'thread/read') reply({ id: message.id, result: { thread: { id: 'codex-id', status: { type: 'idle' }, turns } } });
        else if (message.method === 'turn/start') {
          // An approval request mid-turn must be declined.
          reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'codex-id' } });
          turns.push({ id: 'turn-2', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }, { type: 'agentMessage', id: 'm1', phase: 'commentary', text: 'thinking' }, { type: 'agentMessage', id: 'm2', text: 'OK' }] });
          reply({ id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress' } } });
        } else if (message.id !== undefined && message.method) reply({ id: message.id, result: {} });
      }
      done();
    } });
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, seen };
}

test('codex: resumes, starts one turn, declines approvals and returns the final reply; a repeat is not resent', async () => {
  const turns: Record<string, unknown>[] = [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'earlier' }] }] }];
  const first = appServer(turns);
  const result = await sendCodex({ executable: 'codex', timeoutMs: 1000, pollMs: 1, spawnFn: first.spawnFn }, 'codex-id', prompt);
  assert.deepEqual({ ...result }, { threadId: 'codex-id', turnId: 'turn-2', reply: 'OK', messageIds: ['m2'], alreadySent: false });
  assert.deepEqual(first.seen.find(message => message.id === 'approval-1')?.result, { decision: 'decline' });
  assert.deepEqual(first.seen.filter(message => message.method === 'turn/start').map(message => message.params), [{ threadId: 'codex-id', input: [{ type: 'text', text: prompt }] }]);
  const again = appServer(turns);
  assert.equal((await sendCodex({ executable: 'codex', timeoutMs: 1000, pollMs: 1, spawnFn: again.spawnFn }, 'codex-id', prompt)).alreadySent, true);
  assert.equal(again.seen.filter(message => message.method === 'turn/start').length, 0);
});
