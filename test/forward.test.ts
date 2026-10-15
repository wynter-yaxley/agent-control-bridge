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
const row = (id: string, title: string) => ({ id, kind: 'chatgpt', title, projectId: null, cwd: null });

function gpt(pages: NativeChatPage[], inventory = [row('gpt-id', '测试消息')]) {
  const calls: string[] = [];
  let shown = '其他对话';
  const deps = { timeoutMs: 1000, pollMs: 1,
    native: { readThread: async () => pages.length > 1 ? pages.shift()! : pages[0], listThreads: async () => inventory, setThreadTitle: async () => {} },
    ui: { call: async (operation: string, fields: { name: string }) => {
      if (operation === 'snapshot') return { ok: true, snapshot: { title: shown, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
      calls.push(operation);
      if (operation === 'chat-open-title') shown = fields.name;
      if (operation === 'chat-send') return { ok: true, inputMode: 'typed' as const };
      return operation === 'chat-read-reply' ? { ok: true, conversationId: null, identity: 'titleOnly' as const, completionVerified: true, body: 'OK' } : { ok: true }; } } };
  return { deps, calls };
}

test('gpt: opens the uniquely titled target, sends once and returns the UI reply after native completion', async () => {
  const { deps, calls } = gpt([page('idle', [answered('old', 'earlier')]), page('active', [answered('old', 'earlier')]), page('idle', [answered('new')])]);
  const result = await sendGpt(deps, 'gpt-id', prompt);
  assert.deepEqual(calls, ['chat-open-title', 'chat-send', 'chat-read-reply']);
  assert.deepEqual({ ...result }, { conversationId: 'gpt-id', title: '测试消息', turnId: 'new', reply: 'OK', alreadySent: false, inputMode: 'typed', uiIdentity: 'titleOnly', navigation: 'sidebar' });
});

test('gpt: no resend; busy, non-GPT, same-title or unprovable targets are refused before any send', async () => {
  const repeat = gpt([page('idle', [answered('new')])]);
  assert.equal((await sendGpt(repeat.deps, 'gpt-id', prompt)).alreadySent, true);
  assert.deepEqual(repeat.calls, ['chat-open-title', 'chat-read-reply']);
  for (const [pages, code, inventory] of [[[page('active', [{ ...answered('new'), status: 'inProgress' }])], 'CONFLICT'], [[page('active', [answered('old', 'earlier')])], 'CONFLICT'],
    [[page('idle', [], 'codex')], 'PROVENANCE'], [[page('idle', [answered('old', 'earlier')])], 'PROVENANCE', [row('gpt-id', '测试消息'), row('other', '测试消息')]],
    [[page('idle', [answered('old', 'earlier')])], 'PROVENANCE', []]] as const) {
    const blocked = gpt([...pages], inventory ? [...inventory] : undefined);
    await assert.rejects(sendGpt(blocked.deps, 'gpt-id', prompt), { code });
    assert.ok(!blocked.calls.includes('chat-send'));
  }
});

test('gpt: a new chat is identified by its own marker turn, never by title, then named natively', async () => {
  const inventory = [row('old-id', 'old')];
  let marker = '', titled = '';
  const { deps } = gpt([]);
  Object.assign(deps.native, { listThreads: async () => inventory, setThreadTitle: async (_id: string, _source: string, title: string) => { titled = title; },
    readThread: async (id: string) => ({ thread: { id, kind: 'chatgpt', title: titled || '新聊天', status: { type: 'idle' } }, turns: id === 'new-id' ? [answered('t', marker)] : [answered('t', 'unrelated')] }) });
  deps.ui.call = (async (operation: string, fields: { prompt?: string }) => { if (operation === 'gpt-create') { marker = fields.prompt!; inventory.push(row('decoy', '新聊天'), row('new-id', '新聊天')); } return { ok: true }; }) as typeof deps.ui.call;
  assert.deepEqual(await createGpt(deps, 'ACB 测试'), { conversationId: 'new-id', title: 'ACB 测试' });
  assert.match(marker, /ACB_INIT_[a-f0-9-]{36}$/);
  await assert.rejects(createGpt(deps, 'old'), { code: 'CONFLICT' });
});

/** A scripted codex app-server answering JSON-RPC lines. */
function appServer(threads: Record<string, { turns: Record<string, unknown>[]; archived?: boolean }>, storeErrors = 0) {
  const seen: Record<string, any>[] = [];
  let failing = 0;
  const spawnFn = (() => {
    const child = new EventEmitter() as any, stdout = new PassThrough();
    child.stdout = stdout; child.stderr = new PassThrough(); child.kill = () => true;
    const reply = (message: unknown) => stdout.write(JSON.stringify(message) + '\n');
    child.stdin = new Writable({ write(data, _encoding, done) {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const message = JSON.parse(line), params = message.params ?? {}; seen.push(message);
        if (message.id === undefined || !message.method) continue;
        if (message.method === 'thread/start') { threads['new-thread'] = { turns: [] }; reply({ id: message.id, result: { thread: { id: 'new-thread' } } }); }
        else if (message.method === 'thread/read' && failing > 0) { failing--; reply({ id: message.id, error: { code: -32603, message: 'thread store internal error' } }); }
        else if (message.method === 'thread/read') reply({ id: message.id, result: { thread: { id: params.threadId, status: { type: 'idle' }, turns: threads[params.threadId].turns } } });
        else if (message.method === 'thread/unarchive') { threads[params.threadId].archived = false; reply({ id: message.id, result: {} }); }
        else if (message.method === 'turn/start') {
          const thread = threads[params.threadId];
          if (thread.archived) { reply({ id: message.id, error: { code: -32600, message: 'thread is archived' } }); continue; }
          // An approval request mid-turn must be declined.
          reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId } });
          const id = `turn-${thread.turns.length + 1}`;
          thread.turns.push({ id, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] }, { type: 'agentMessage', id: 'm1', phase: 'commentary', text: 'thinking' }, { type: 'agentMessage', id: 'm2', text: 'OK' }] });
          failing = storeErrors;
          reply({ id: message.id, result: { turn: { id, status: 'inProgress' } } });
        } else reply({ id: message.id, result: {} });
      }
      done();
    } });
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, seen };
}
const options = (spawnFn: typeof spawn) => ({ executable: 'codex', timeoutMs: 1000, pollMs: 1, spawnFn });

test('codex: sends one turn, declines approvals, recovers an archived thread once and never resends a repeat', async () => {
  const threads = { 'codex-id': { turns: [{ id: 'turn-0', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'earlier' }] }] }], archived: true } };
  const first = appServer(threads);
  const result = await sendCodex(options(first.spawnFn), 'codex-id', prompt);
  assert.deepEqual({ ...result }, { threadId: 'codex-id', turnId: 'turn-2', reply: 'OK', messageIds: ['m2'], alreadySent: false, approvalsDeclined: 1 });
  assert.deepEqual(first.seen.find(message => message.id === 'approval-1')?.result, { decision: 'decline' });
  assert.deepEqual(first.seen.filter(message => message.method).map(message => message.method).filter(method => method !== 'thread/read' && method !== 'initialize' && method !== 'initialized'),
    ['thread/resume', 'turn/start', 'thread/unarchive', 'thread/resume', 'turn/start']);
  const again = appServer(threads);
  assert.equal((await sendCodex(options(again.spawnFn), 'codex-id', prompt)).alreadySent, true);
  assert.equal(again.seen.filter(message => message.method === 'turn/start').length, 0);
});

test('codex: a new conversation starts in the workspace, is persisted by its first turn and named', async () => {
  const server = appServer({});
  const created = await createCodex(options(server.spawnFn), 'D:\\ws', 'ACB Codex', 'hi');
  assert.equal(created.threadId, 'new-thread'); assert.equal(created.reply, 'OK'); assert.equal(created.title, 'ACB Codex');
  assert.deepEqual(server.seen.filter(message => ['thread/start', 'turn/start', 'thread/name/set'].includes(message.method)).map(message => [message.method, message.params]),
    [['thread/start', { cwd: 'D:\\ws' }], ['turn/start', { threadId: 'new-thread', input: [{ type: 'text', text: 'hi' }] }], ['thread/name/set', { threadId: 'new-thread', name: 'ACB Codex' }]]);
  // A readback failing while the rollout is written is retried, at most 3 times in a row.
  const transient = appServer({}, 3);
  assert.equal((await createCodex(options(transient.spawnFn), 'D:\\ws', 'ACB Codex', 'hi')).reply, 'OK');
  assert.equal(transient.seen.filter(message => message.method === 'turn/start').length, 1);
  await assert.rejects(createCodex(options(appServer({}, 4).spawnFn), 'D:\\ws', 'ACB Codex', 'hi'), (error: any) => error.code === 'EXECUTION');
});

test('workspace: creates the directory and registers it with a key stable per directory', async t => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs'), { join } = await import('node:path'), { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'acb-ws-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys: string[] = [];
  const create = async (_options: unknown, name: string, path: string, key: string) => { keys.push(key); return { projectId: 'p-1', name, roots: [{ path }] }; };
  const first = await createWorkspace({ executable: 'codex', timeoutMs: 1000, pollMs: 1, root, create }, 'acb-demo');
  assert.deepEqual({ ...first }, { projectId: 'p-1', name: 'acb-demo', roots: [{ path: join(root, 'acb-demo') }], path: join(root, 'acb-demo'), directoryCreated: true });
  assert.equal(existsSync(join(root, 'acb-demo')), true);
  assert.equal((await createWorkspace({ executable: 'codex', timeoutMs: 1000, pollMs: 1, root, create }, 'acb-demo')).directoryCreated, false);
  assert.equal(keys[0], keys[1]); assert.match(keys[0], /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
});
