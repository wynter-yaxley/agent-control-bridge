import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { createGpt, sendGpt } from '../src/gpt.ts';
import { createCodex, sendCodex } from '../src/codex.ts';
import { createWorkspace } from '../src/workspace.ts';
import type { NativeChatPage } from '../src/native.ts';

const prompt = '[TEST] reply with OK';
const page = (status: string, turns: NativeChatPage['turns'], kind = 'chatgpt'): NativeChatPage => ({ thread: { id: 'gpt-id', kind, title: '测试消息', status: { type: status } }, turns });
const answered = (id: string, text = prompt): NativeChatPage['turns'][number] => ({ id, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text }] }, { type: 'agentMessage', id: `a-${id}`, text: '[native]' }] });

function gpt(pages: NativeChatPage[], inventory = [{ id: 'gpt-id', kind: 'chatgpt', title: '测试消息', projectId: null, cwd: null }]) {
  const calls: { operation: string; name: string }[] = [];
  let shown = '其他对话';
  const deps = { timeoutMs: 1000, pollMs: 1,
    native: { readThread: async () => pages.length > 1 ? pages.shift()! : pages[0], listThreads: async () => inventory,
      navigate: async () => { calls.push({ operation: 'navigate', name: '' }); shown = '测试消息'; }, setThreadTitle: async () => {}, moveToProject: async () => {} },
    ui: { call: async (operation: string, fields: { name: string }) => {
      if (operation === 'snapshot') return { ok: true, snapshot: { title: shown, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
      calls.push({ operation, name: fields.name });
      return operation === 'chat-read-reply' ? { ok: true, conversationId: null, identity: 'titleOnly' as const, completionVerified: true, body: 'OK' } : { ok: true }; } } };
  return { deps, calls };
}

test('gpt: opens the target by ID, sends once with its native title and returns the UI reply after native completion', async () => {
  const { deps, calls } = gpt([page('idle', [answered('old', 'earlier')]), page('active', [answered('old', 'earlier')]), page('idle', [answered('new')])]);
  const result = await sendGpt(deps, 'gpt-id', prompt);
  assert.deepEqual(calls, [{ operation: 'navigate', name: '' }, { operation: 'chat-send', name: '测试消息' }, { operation: 'chat-read-reply', name: '测试消息' }]);
  assert.deepEqual({ ...result }, { conversationId: 'gpt-id', title: '测试消息', turnId: 'new', reply: 'OK', alreadySent: false, uiIdentity: 'titleOnly', navigation: 'native' });
});

test('gpt: an already sent prompt is never resent; busy, non-GPT or same-title targets are refused before any send', async () => {
  const repeat = gpt([page('idle', [answered('new')])]);
  assert.equal((await sendGpt(repeat.deps, 'gpt-id', prompt)).alreadySent, true);
  assert.deepEqual(repeat.calls.map(call => call.operation), ['navigate', 'chat-read-reply']);
  const twin = [{ id: 'gpt-id', kind: 'chatgpt', title: '测试消息', projectId: null, cwd: null }, { id: 'other-id', kind: 'chatgpt', title: '测试消息', projectId: null, cwd: null }];
  for (const [pages, code, inventory] of [[[page('active', [{ ...answered('new'), status: 'inProgress' }])], 'CONFLICT'], [[page('active', [answered('old', 'earlier')])], 'CONFLICT'],
    [[page('idle', [], 'codex')], 'PROVENANCE'], [[page('idle', [answered('old', 'earlier')])], 'PROVENANCE', twin]] as const) {
    const blocked = gpt([...pages], inventory ? [...inventory] : undefined);
    await assert.rejects(sendGpt(blocked.deps, 'gpt-id', prompt), { code });
    assert.ok(!blocked.calls.some(call => call.operation === 'chat-send'));
  }
});

test('gpt: a new chat is identified by its own marker turn, never by title, then named natively', async () => {
  const inventory = [{ id: 'old-id', kind: 'chatgpt', title: 'old', projectId: null, cwd: null }];
  let marker = '', titled = '';
  const { deps } = gpt([]);
  Object.assign(deps.native, { listThreads: async () => inventory, setThreadTitle: async (_id: string, _source: string, title: string) => { titled = title; },
    readThread: async (id: string) => ({ thread: { id, kind: 'chatgpt', title: titled || '新聊天', status: { type: 'idle' } }, turns: id === 'new-id' ? [answered('t', marker)] : [answered('t', 'unrelated')] }) });
  deps.ui.call = (async (operation: string, fields: { prompt?: string }) => { if (operation === 'gpt-create') { marker = fields.prompt!; inventory.push({ id: 'decoy', kind: 'chatgpt', title: '新聊天', projectId: null, cwd: null }, { id: 'new-id', kind: 'chatgpt', title: '新聊天', projectId: null, cwd: null }); } return { ok: true }; }) as typeof deps.ui.call;
  assert.deepEqual(await createGpt(deps, 'ACB 测试'), { conversationId: 'new-id', title: 'ACB 测试', projectId: null });
  assert.match(marker, /ACB_INIT_[a-f0-9-]{36}$/);
  await assert.rejects(createGpt(deps, 'old'), { code: 'CONFLICT' });
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

test('workspace: creates the directory, registers it once through the dialog and reuses an existing project', async t => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs'), { join } = await import('node:path'), { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'acb-ws-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects: { projectId: string; projectKind: string; label: string; path: string; hostId: string }[] = [];
  let dialogs = 0;
  const deps = { root, timeoutMs: 1000, pollMs: 1, native: { listProjects: async () => projects },
    ui: { call: async (_operation: 'workspace-create', fields: { name: string; path: string }) => { dialogs++; projects.push({ projectId: 'p-1', projectKind: 'local', label: fields.name, path: fields.path, hostId: 'local' }); return { ok: true }; } } };
  const created = await createWorkspace(deps, 'acb-demo');
  assert.deepEqual({ ...created }, { projectId: 'p-1', label: 'acb-demo', path: join(root, 'acb-demo'), directoryCreated: true, projectCreated: true });
  assert.equal(existsSync(join(root, 'acb-demo')), true);
  assert.equal((await createWorkspace(deps, 'acb-demo')).projectCreated, false); assert.equal(dialogs, 1);
});

test('codex: a new conversation is created in a local project and returns its first reply', async () => {
  const thread = { thread: { id: '00000000-0000-4000-8000-000000000001', kind: 'codex', title: 'T', status: { type: 'idle' } }, turns: [{ id: 't1', status: 'completed', error: null, items: [{ type: 'userMessage' as const, id: 'u', content: [{ type: 'text', text: 'hi\n' }] }, { type: 'agentMessage' as const, id: 'a', text: 'ACB_READY' }] }] };
  const native = { listProjects: async () => [{ projectId: 'p-1', projectKind: 'local', label: 'w', path: '/w', hostId: 'local' }], listThreads: async () => [], readThread: async () => thread,
    createThread: async (input: { projectId: string; title: string; prompt: string }) => { assert.deepEqual(input, { projectId: 'p-1', title: 'T', prompt: 'hi' }); return { threadId: thread.thread.id }; } };
  assert.deepEqual(await createCodex({ native, timeoutMs: 1000, pollMs: 1 }, 'p-1', 'T', 'hi'), { threadId: thread.thread.id, projectId: 'p-1', title: 'T', reply: 'ACB_READY' });
  await assert.rejects(createCodex({ native, timeoutMs: 1000, pollMs: 1 }, 'missing', 'T'), { code: 'PROVENANCE' });
});
