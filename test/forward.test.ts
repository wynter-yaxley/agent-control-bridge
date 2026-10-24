import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createGpt, readGptWithWindow, sendGpt } from '../src/gpt.ts';
import { createCodex, listCodex, readCodex, sendCodex } from '../src/codex.ts';
import { createWorkspace } from '../src/workspace.ts';
import { BridgeError } from '../src/errors.ts';
import type { NativeChatPage, NativeThread } from '../src/native.ts';

const prompt = '[TEST] reply with OK';
const page = (status: string, turns: NativeChatPage['turns'], kind = 'chatgpt'): NativeChatPage => ({ thread: { id: 'gpt-id', kind, title: '测试消息', status: { type: status } }, turns });
const answered = (id: string, text = prompt): NativeChatPage['turns'][number] => ({ id, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text }] }, { type: 'agentMessage', id: `a-${id}`, text: '[native]' }] });
const row = (id: string, title: string) => ({ id, kind: 'chatgpt', title, projectId: null, cwd: null });
const idleChat = (id: string, title: string, turns: NativeChatPage['turns']): NativeChatPage => ({ thread: { id, kind: 'chatgpt', title, status: { type: 'idle' } }, turns });

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

test('gpt read: a reply kept only as a reference is read from the shown chat, without typing or sending', async () => {
  const reference = { type: 'agentMessage' as const, id: 'a-new', text: '::chatgpt-content-reference{index="0" source_message_id="a-new"}' };
  const turn = { id: 'new', status: 'completed', error: null, items: [{ type: 'userMessage' as const, id: 'u-new', content: [{ type: 'text', text: prompt }] }, reference] };
  const { deps, calls } = gpt([page('idle', [turn])]);
  const read = await readGptWithWindow(deps, 'gpt-id');
  assert.deepEqual(calls, ['chat-open-title', 'chat-read-reply']);
  assert.deepEqual(read.turns, [{ turnId: 'new', status: 'completed', prompt, reply: 'OK', truncated: false, error: null, replyInWindowOnly: false }]);
  assert.equal(read.uiIdentity, 'titleOnly'); assert.equal(read.navigation, 'sidebar');
  // A reply already in the transcript needs no window; a running turn is not read.
  const plain = gpt([page('idle', [answered('new')])]);
  assert.equal((await readGptWithWindow(plain.deps, 'gpt-id')).turns[0].reply, '[native]'); assert.deepEqual(plain.calls, []);
  const running = gpt([page('idle', [turn]), page('active', [{ ...turn, status: 'inProgress' }])]);
  await assert.rejects(readGptWithWindow(running.deps, 'gpt-id'), { code: 'CONFLICT' }); assert.deepEqual(running.calls, []);
  // The page is searched with the complete prompt, never the 20,000-character transcript text;
  // a prompt the host shortened cannot locate its reply and nothing is read.
  const long = 'x'.repeat(20005), seen: string[] = [];
  const full = gpt([page('idle', [{ ...turn, items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: long }] }, reference] }])]);
  const call = full.deps.ui.call;
  full.deps.ui.call = (async (operation: string, fields: { name: string; prompt?: string }) => { if (operation === 'chat-read-reply') seen.push(fields.prompt!); return call(operation, fields); }) as typeof call;
  const fullRead = await readGptWithWindow(full.deps, 'gpt-id');
  assert.equal(fullRead.turns[0].truncated, true); assert.equal(seen[0], long);
  const cut = gpt([page('idle', [{ ...turn, items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'x'.repeat(100), truncated: true }] }, reference] }])]);
  await assert.rejects(readGptWithWindow(cut.deps, 'gpt-id'), { code: 'PROVENANCE' }); assert.deepEqual(cut.calls, []);
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
  Object.assign(deps.native, { listThreads: async () => inventory, setThreadTitle: async (_id: string, _source: string, title: string) => { titled = title; inventory.find(t => t.id === 'new-id')!.title = title; },
    readThread: async (id: string) => idleChat(id, titled || '新聊天', id === 'new-id' ? [answered('t', marker)] : [answered('t', 'unrelated')]) });
  deps.ui.call = (async (operation: string, fields: { prompt?: string }) => { if (operation === 'gpt-create') { marker = fields.prompt!; inventory.push(row('decoy', '新聊天'), row('new-id', '新聊天')); } return { ok: true, snapshot: { title: titled, text: '', ordinaryComposer: true, pid: 1, conversationId: null } }; }) as typeof deps.ui.call;
  assert.deepEqual(await createGpt(deps, 'ACB 测试'), { conversationId: 'new-id', title: 'ACB 测试' });
  assert.match(marker, /ACB_INIT_[a-f0-9-]{36}$/);
  await assert.rejects(createGpt(deps, 'old'), { code: 'CONFLICT' });
});

test('gpt: a chat started in a project counts only when the app read the project back; a wrong window sends nothing', async () => {
  function setup(echo: string | undefined, projectId: string | null, label = 'ACB项目', fail?: string) {
    const inventory: NativeThread[] = [row('old-id', 'old')];
    let marker = '', titled = '', renamed = false, sentProject: string | undefined;
    const { deps } = gpt([]);
    Object.assign(deps.native, { listThreads: async () => inventory, setThreadTitle: async (_id: string, _source: string, title: string) => { titled = title; renamed = true; inventory.find(t => t.id === 'new-id')!.title = title; },
      listProjects: async () => [{ projectId: 'p-1', projectKind: 'chatgpt', label, path: '', hostId: '' }],
      readThread: async (id: string) => idleChat(id, titled || '新聊天', id === 'new-id' ? [answered('t', marker)] : []) });
    deps.ui.call = (async (operation: string, fields: { prompt?: string; project?: string }) => {
      if (operation !== 'gpt-create') return { ok: true, snapshot: { title: titled, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
      if (fail) throw Object.assign(new Error(fail), { code: fail });
      marker = fields.prompt!; sentProject = fields.project; inventory.push({ ...row('new-id', '新聊天'), projectId });
      return { ok: true, project: echo };
    }) as typeof deps.ui.call;
    return { deps, renamed: () => renamed, sentProject: () => sentProject };
  }
  const ok = setup('ACB项目', 'p-1');
  assert.deepEqual(await createGpt(ok.deps, 'ACB 项目对话', 'ACB项目'), { conversationId: 'new-id', title: 'ACB 项目对话', project: { name: 'ACB项目', confirmedBy: 'ui+native', projectId: 'p-1' } });
  assert.equal(ok.sentProject(), 'ACB项目');
  assert.deepEqual((await createGpt(setup('ACB项目', null).deps, 'ACB 项目对话', 'ACB项目')).project, { name: 'ACB项目', confirmedBy: 'ui', projectId: null });
  // Not read back by the UI, or a native project of another name, or the worker refused the window.
  for (const [blocked, code, renamed] of [[setup(undefined, 'p-1'), 'PROVENANCE', false], [setup('ACB项目', 'p-1', '别的项目'), 'PROVENANCE', true], [setup('ACB项目', 'p-1', 'ACB项目', 'OWNER'), 'OWNER', false]] as const) {
    await assert.rejects(createGpt(blocked.deps, 'ACB 项目对话', 'ACB项目'), { code });
    assert.equal(blocked.renamed(), renamed);
  }
});

test('gpt: create reports partial completion and its ID when title or persistence verification fails, without repeating the marker', async () => {
  for (const fail of ['native-title', 'ui-title', 'rename-error', 'missing-marker', 'unknown-submit']) {
    let marker = '', title = 'New chat', creates = 0, writes = 0;
    const inventory: NativeThread[] = [];
    const deps = { timeoutMs: 25, pollMs: 1,
      native: {
        listThreads: async () => inventory,
        readThread: async (id: string) => idleChat(id, title, [answered('init', fail === 'missing-marker' ? 'other' : marker)]),
        setThreadTitle: async (_id: string, _source: string, value: string) => { writes++; if (fail === 'rename-error') throw new BridgeError('IO', 'rename failed'); if (fail !== 'native-title') { title = value; inventory[0].title = value; } },
      },
      ui: { call: async (operation: string, fields: { prompt?: string }) => {
        if (operation === 'gpt-create') { creates++; marker = fields.prompt!; inventory.push(row('created-id', title)); if (fail === 'unknown-submit') throw new BridgeError('IO', 'send result unknown', { submission: 'attempted' }); return { ok: true, conversationId: 'created-id' }; }
        return { ok: true, snapshot: { title: fail === 'ui-title' ? 'New chat' : title, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
      } },
    };
    await assert.rejects(createGpt(deps, 'wanted'), (error: BridgeError) => {
      assert.equal(error.details?.status, 'partial', fail);
      assert.equal(error.details?.conversationId, fail === 'unknown-submit' ? null : 'created-id', fail);
      assert.match(error.message, /do not create again or resend/);
      return true;
    });
    assert.equal(creates, 1, fail); assert.ok(writes <= 1, fail);
  }
});

test('gpt: the chat verified after creation accepts the second prompt and returns its completed reply', async () => {
  const inventory: NativeThread[] = [];
  let text = '', title = 'New chat', turnId = 'init', sends = 0, creates = 0;
  const deps = { timeoutMs: 1000, pollMs: 1,
    native: { listThreads: async () => inventory,
      setThreadTitle: async (_id: string, _source: string, value: string) => { title = value; inventory[0].title = value; },
      readThread: async (id: string) => idleChat(id, title, [answered(turnId, text)]) },
    ui: { call: async (operation: string, fields: { prompt?: string }) => {
      if (operation === 'gpt-create') { creates++; text = fields.prompt!; inventory.push(row('new-id', title)); }
      if (operation === 'chat-send') { sends++; text = fields.prompt!; turnId = 'second'; }
      return { ok: true, snapshot: { title, text: '', ordinaryComposer: true, pid: 1, conversationId: null }, inputMode: 'typed' as const, identity: 'titleOnly' as const, completionVerified: true, body: 'SECOND_OK' };
    } },
  };
  const created = await createGpt(deps, 'new title');
  const reply = await sendGpt(deps, created.conversationId, 'second prompt');
  assert.equal(reply.reply, 'SECOND_OK'); assert.equal(reply.turnId, 'second');
  assert.equal(creates, 1); assert.equal(sends, 1);
});

test('gpt: a page UUID alone is not persistence: the inventory must list the same ID with the new title', async () => {
  for (const inventoryState of ['missing', 'stale']) {
    let marker = '', title = 'New chat', renames = 0, creates = 0;
    const deps = { timeoutMs: 40, pollMs: 1,
      native: {
        // The rename reaches the ID read, but the sidebar inventory never reflects it.
        listThreads: async () => inventoryState === 'stale' && marker ? [row('new-id', 'New chat')] : [],
        readThread: async (id: string) => idleChat(id, title, [answered('init', marker)]),
        setThreadTitle: async (_id: string, _source: string, value: string) => { title = value; renames++; },
      },
      ui: { call: async (operation: string, fields: { prompt?: string }) => {
        if (operation === 'gpt-create') { creates++; marker = fields.prompt!; return { ok: true, conversationId: 'new-id' }; }
        // The page exposes the exact UUID and the new title.
        return { ok: true, snapshot: { title, text: '', ordinaryComposer: true, pid: 1, conversationId: 'new-id' } };
      } },
    };
    await assert.rejects(createGpt(deps, 'wanted'), (error: BridgeError) => {
      assert.equal(error.code, 'PROVENANCE', inventoryState);
      assert.deepEqual([error.details?.status, error.details?.conversationId, error.details?.stage, error.details?.identityVerified], ['partial', 'new-id', 'persistence', true], inventoryState);
      assert.equal((error.details?.verification as { inventoryTitle: unknown }).inventoryTitle, inventoryState === 'stale' ? 'New chat' : null, inventoryState);
      return true;
    });
    assert.equal(creates, 1, inventoryState); assert.equal(renames, 1, inventoryState);
  }
});

test('gpt: once the create budget is spent, the title is not written; the result is partial', async () => {
  let marker = '', renames = 0, creates = 0, slow = true;
  const deps = { timeoutMs: 20, pollMs: 1,
    native: {
      listThreads: async () => marker ? [row('new-id', 'New chat')] : [],
      // The identity read that confirms the marker finishes only after the budget.
      readThread: async (id: string) => { if (marker && slow) { slow = false; await delay(60); } return idleChat(id, 'New chat', [answered('init', marker)]); },
      setThreadTitle: async () => { renames++; },
    },
    ui: { call: async (operation: string, fields: { prompt?: string }) => {
      if (operation === 'gpt-create') { creates++; marker = fields.prompt!; return { ok: true, conversationId: null }; }
      return { ok: true, snapshot: { title: 'New chat', text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
    } },
  };
  await assert.rejects(createGpt(deps, 'late title'), (error: BridgeError) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.deepEqual([error.details?.status, error.details?.conversationId, error.details?.stage, error.details?.identityVerified], ['partial', 'new-id', 'title', true]);
    return true;
  });
  assert.equal(renames, 0); assert.equal(creates, 1);
});

test('gpt: a stale sidebar inventory after rename must converge before create succeeds', async () => {
  let marker = '', title = 'New chat', readsAfterRename = 0, renames = 0, creates = 0;
  const deps = { timeoutMs: 500, pollMs: 1,
    native: {
      listThreads: async () => marker ? [row('new-id', renames && ++readsAfterRename >= 4 ? title : 'New chat')] : [],
      readThread: async (id: string) => idleChat(id, title, [answered('init', marker)]),
      setThreadTitle: async (_id: string, _source: string, value: string) => { title = value; renames++; },
    },
    ui: { call: async (operation: string, fields: { prompt?: string }) => {
      if (operation === 'gpt-create') { creates++; marker = fields.prompt!; }
      return { ok: true, snapshot: { title, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
    } },
  };
  assert.deepEqual(await createGpt(deps, 'settled title'), { conversationId: 'new-id', title: 'settled title' });
  assert.ok(readsAfterRename >= 5); assert.equal(renames, 1); assert.equal(creates, 1);
});

/** A scripted codex app-server answering JSON-RPC lines. */
function appServer(threads: Record<string, { turns: Record<string, unknown>[]; archived?: boolean }>, storeErrors = 0, deferred = false, listShape: 'data' | 'changed' = 'data') {
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
        else if (message.method === 'thread/read') reply({ id: message.id, result: { thread: { id: params.threadId, name: `name of ${params.threadId}`, cwd: 'D:\\ws', updatedAt: 1792800000, status: { type: 'idle' }, turns: threads[params.threadId].turns } } });
        else if (message.method === 'thread/list' && listShape === 'changed') reply({ id: message.id, result: { threads: [] } });
        else if (message.method === 'thread/list') reply({ id: message.id, result: { data: Object.keys(threads).map(id => ({ id, name: null, preview: 'p'.repeat(300), cwd: 'D:\\ws', updatedAt: 1792800000, status: { type: 'notLoaded' }, turns: [] })), nextCursor: 'next' } });
        else if (message.method === 'thread/unarchive') { threads[params.threadId].archived = false; reply({ id: message.id, result: {} }); }
        else if (message.method === 'turn/start') {
          const thread = threads[params.threadId];
          if (thread.archived) { reply({ id: message.id, error: { code: -32600, message: 'thread is archived' } }); continue; }
          // An approval request mid-turn must be declined.
          reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId } });
          const id = `turn-${thread.turns.length + 1}`;
          const turn = { id, status: deferred ? 'inProgress' : 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: params.input[0].text }] }, { type: 'agentMessage', id: 'm1', phase: 'commentary', text: 'thinking' }, { type: 'agentMessage', id: 'm2', text: 'OK' }] };
          thread.turns.push(turn);
          // The turn finishes later and the server says so with a notification.
          if (deferred) setTimeout(() => { turn.status = 'completed'; reply({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id } } }); }, 20);
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

test('codex: one App Server is reused across calls, and a completion notification ends the wait without polling', async () => {
  const threads = { 'codex-id': { turns: [] as Record<string, unknown>[] } };
  const server = appServer(threads, 0, true);
  // A 60 s poll interval: only the turn/completed notification can end these waits in time.
  const slow = { executable: 'codex', timeoutMs: 120000, pollMs: 60000, spawnFn: server.spawnFn };
  const started = Date.now();
  assert.equal((await sendCodex(slow, 'codex-id', 'first')).reply, 'OK');
  assert.equal((await sendCodex(slow, 'codex-id', 'second')).turnId, 'turn-2');
  assert.ok(Date.now() - started < 5000);
  assert.equal(server.seen.filter(message => message.method === 'initialize').length, 1);
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

test('codex read: lists and reads conversations through the App Server without sending, resuming or starting anything', async () => {
  const turn = (n: number, extra: Record<string, unknown>[] = []) => ({ id: `turn-${n}`, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: `ask ${n}` }] }, ...extra, { type: 'agentMessage', id: `m${n}`, text: `reply ${n}` }] });
  const server = appServer({ 'codex-id': { turns: [turn(1), turn(2, [{ type: 'agentMessage', phase: 'commentary', text: 'thinking' }, { type: 'commandExecution', command: 'ls' }]), turn(3)] } });
  const listed = await listCodex(options(server.spawnFn), { limit: 5, cwd: 'D:\\ws' });
  assert.deepEqual(listed, { threads: [{ threadId: 'codex-id', name: null, preview: 'p'.repeat(200), cwd: 'D:\\ws', status: 'notLoaded', updatedAt: '2026-10-24T00:00:00.000Z' }], nextCursor: 'next' });
  assert.deepEqual(server.seen.find(message => message.method === 'thread/list')!.params, { limit: 5, sortKey: 'updated_at', cwd: 'D:\\ws' });
  const read = await readCodex(options(server.spawnFn), 'codex-id', 2);
  assert.equal(read.name, 'name of codex-id'); assert.equal(read.turnCount, 3);
  assert.deepEqual(read.turns, [{ turnId: 'turn-2', status: 'completed', prompt: 'ask 2', reply: 'reply 2', truncated: false, error: null }, { turnId: 'turn-3', status: 'completed', prompt: 'ask 3', reply: 'reply 3', truncated: false, error: null }]);
  assert.deepEqual(server.seen.filter(message => message.method).map(message => message.method).filter(method => !['initialize', 'initialized'].includes(method)), ['thread/list', 'thread/read']);
  await assert.rejects(readCodex(options(server.spawnFn), 'bad id'), { code: 'INPUT' });
  await assert.rejects(readCodex(options(server.spawnFn), 'codex-id', 21), { code: 'INPUT' });
  await assert.rejects(listCodex(options(server.spawnFn), { limit: 0 }), { code: 'INPUT' });
  // A changed response shape is an error, not an empty list.
  await assert.rejects(listCodex(options(appServer({}, 0, false, 'changed').spawnFn)), { code: 'IO' });
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
