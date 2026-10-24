import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeClient, NativeReadWorker } from '../src/native.ts';
import { listGpt, readGpt } from '../src/gpt.ts';

const carrier = '00000000-0000-0000-0000-000000000001', chat = '00000000-0000-0000-0000-0000000000c1';
const peer = { sameUserSignedHost: true, processId: 7, processStartedAt: 'stable', appVersion: '26.1021.3705.0', pipe: 'app-tools' };
/** A mocked worker answering each request with `answer(request)`, counting restarts. */
function host(answer: (request: any) => Record<string, unknown>) {
  const requests: any[] = [];
  let closed = 0;
  const worker = new NativeReadWorker();
  worker.close = () => { closed++; };
  worker.request = async input => { const request = JSON.parse(String(input.requestJson)); requests.push(request); return answer(request); };
  const native = new NativeClient({ worker, carrierThreadId: carrier, timeoutMs: 1000, maxFrameBytes: 2097152, maxCandidates: 128 });
  return { native, requests, closed: () => closed };
}
const ok = (request: any, value: unknown, success = true) => ({ ok: true, peer, response: { jsonrpc: '2.0', id: request.id, result: { success, contentItems: [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } });

test('native inventory: requests the supported 50 rows, keeps pinned chats, and does not assume recency sorting', async () => {
  const requests: any[] = [];
  const worker = new NativeReadWorker();
  worker.request = async input => {
    const request = JSON.parse(String(input.requestJson)); requests.push(request);
    return { ok: true, peer: { sameUserSignedHost: true, processId: 7, processStartedAt: 'stable' }, response: {
      jsonrpc: '2.0', id: request.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
        pinnedThreads: [{ id: 'pinned', kind: 'chatgpt', title: 'pinned' }],
        threads: Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, kind: 'chatgpt', title: i === 49 ? 'new chat under manual sorting' : `old ${i}` })),
        sidebarPreferences: { sorting: { chats: 'manual' } },
      }) }] },
    } };
  };
  const native = new NativeClient({ worker, carrierThreadId: '00000000-0000-0000-0000-000000000001', timeoutMs: 1000, maxFrameBytes: 2097152, maxCandidates: 128 });
  const rows = await native.listThreads();
  assert.deepEqual(requests[0].params.arguments, { limit: 50 });
  assert.equal(rows.length, 51); assert.equal(rows[0].id, 'pinned');
  assert.equal(rows[50].title, 'new chat under manual sorting');
});

test('native errors: the host\'s own code and message are kept, a refused request restarts the worker', async () => {
  // A host that moved its app tools to another pipe answers only ping on the old one.
  const moved = host(request => ({ ok: true, peer: { ...peer, pipe: 'browser-use' }, response: { jsonrpc: '2.0', id: request.id, error: { code: -1, message: `No handler registered for method: ${request.method}` } } }));
  await assert.rejects(moved.native.listThreads(), (error: any) => {
    assert.equal(error.code, 'IO');
    assert.equal(error.message, 'Native request was rejected: [-1] No handler registered for method: tools/call');
    assert.deepEqual(error.details, { nativeError: { code: -1, message: 'No handler registered for method: tools/call' }, pipe: 'browser-use' });
    return true;
  });
  const invalid = host(request => ({ ok: true, peer, response: { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid app tool request' } } }));
  await assert.rejects(invalid.native.listProjects(), { code: 'IPC_CONFIG', message: /\[-32602\] Invalid app tool request/ });
  // A tool that reports failure keeps its text (one line, bounded).
  const missing = host(request => ok(request, 'No Codex thread found\nfor threadId: x', false));
  await assert.rejects(missing.native.readThread(chat), { code: 'IO', message: 'Native tool read_thread failed: No Codex thread found for threadId: x' });
  // The worker refused (e.g. the verified pipe disappeared after an app update): restart it.
  const gone = host(() => ({ ok: false, code: 'IO', stage: 'connect' }));
  await assert.rejects(gone.native.listThreads(), { code: 'IO', message: /at connect/ });
  assert.equal(gone.closed(), 1);
  // A host rejection also drops the kept pipe, so the next call can find the app-tools pipe.
  assert.equal(moved.closed(), 1); assert.equal(invalid.closed(), 1); assert.equal(missing.closed(), 0);
  assert.equal(moved.requests.length, 1);
});

test('native inventory: a host that could not list its ChatGPT chats is an error for title checks, not an empty list', async () => {
  const partial = host(request => ok(request, { pinnedThreads: [], threads: [{ id: 'c1', kind: 'codex', title: 'codex' }], unavailableSources: ['chatgpt'] }));
  assert.deepEqual(await partial.native.inventory(), { threads: [{ id: 'c1', kind: 'codex', title: 'codex', projectId: null, cwd: null }], unavailableSources: ['chatgpt'] });
  await assert.rejects(partial.native.listThreads(), { code: 'DEPENDENCY' });
  await assert.rejects(listGpt(partial.native), { code: 'DEPENDENCY' });
  assert.deepEqual(partial.native.peer, { processId: 7, processStartedAt: 'stable', appVersion: '26.1021.3705.0', pipe: 'app-tools' });
});

test('gpt read: newest turns are read by ID without a window, returned oldest first, with a cursor for older ones', async () => {
  const turn = (n: number) => ({ id: `t${n}`, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: `question ${n}` }] }, { type: 'agentMessage', id: `a${n}`, text: `answer ${n}` }] });
  const chats = host(request => ok(request, { schemaVersion: 1, thread: { id: request.params.arguments.threadId, kind: request.params.arguments.threadId === chat ? 'chatgpt' : 'codex', title: '方案', status: { type: 'idle' } },
    page: { order: 'newest_first', limit: 2, nextCursor: 'older', hasMore: true }, turns: [turn(3), turn(2)] }));
  const read = await readGpt(chats.native, chat, 2);
  // Without outputs the host empties message text too, so the read keeps them on.
  assert.deepEqual(chats.requests[0].params.arguments, { threadId: chat, turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 20000 });
  assert.deepEqual(read.turns.map(item => [item.turnId, item.prompt, item.reply, item.replyInWindowOnly]), [['t2', 'question 2', 'answer 2', false], ['t3', 'question 3', 'answer 3', false]]);
  assert.equal(read.nextCursor, 'older'); assert.equal(read.title, '方案'); assert.equal(read.status, 'idle');
  await readGpt(chats.native, chat, 2, 'older');
  assert.equal(chats.requests[1].params.arguments.cursor, 'older');
  // The send path keeps its own single-turn read with outputs.
  await chats.native.readThread(chat);
  assert.deepEqual(chats.requests[2].params.arguments, { threadId: chat, turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 20000 });
  await assert.rejects(readGpt(chats.native, '00000000-0000-0000-0000-0000000000d1'), { code: 'INPUT', message: /acb_codex_read/ });
  await assert.rejects(readGpt(chats.native, chat, 11), { code: 'INPUT' });
  // A reply the transcript keeps only as a content reference is missing, not that text.
  const referenced = host(request => ok(request, { thread: { id: chat, kind: 'chatgpt', title: 'x', status: { type: 'idle' } }, turns: [{ id: 't1', status: 'completed', error: null,
    items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'q' }] }, { type: 'agentMessage', id: 'a1', text: '::chatgpt-content-reference{index="0" source_message_id="a1"}' }] }] }));
  assert.deepEqual((await readGpt(referenced.native, chat)).turns[0], { turnId: 't1', status: 'completed', prompt: 'q', reply: null, truncated: false, error: null, replyInWindowOnly: true });
});

// Worker functions run alone against literal inputs, as in the UIA tests: no pipe is listed
// or connected. Windows PowerShell 5.1 is the production host; it reads JSON numbers as Int32
// (PowerShell 7 reads Int64, which the allowlist refuses), so argument checks run only there.
const workerSource = readFileSync(new URL('../src/native-pipe-worker.ps1', import.meta.url), 'utf8');
const fn = (name: string) => new RegExp(`\\nfunction ${name}[ (][\\s\\S]*?\\n}\\n`).exec(workerSource)![0];
const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '1'], { windowsHide: true }).status === 0;
function ps(script: string): any {
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('native worker: app tools are taken from the codex-app-tools pipes, the browser-use pipes only on older hosts', { skip: !available }, () => {
  const result = ps(`${fn('SelectPipes')}
@{
 both=@(SelectPipes @('codex-browser-use-aa11','codex-app-tools-bb22','codex-ipc','other'))
 legacy=@(SelectPipes @('codex-browser-use-aa11','codex-computer-use-cc33'))
 none=@(SelectPipes @('codex-ipc','codex-app-tools-','codex-app-tools-xyz'))
} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { both: ['codex-app-tools-bb22'], legacy: ['codex-browser-use-aa11'], none: [] });
});

test('native worker: paged read_thread arguments pass the allowlist, anything else is refused', { skip: process.platform !== 'win32' ? 'Windows PowerShell 5.1 is the production host' : !available }, () => {
  const line = (args: Record<string, unknown>) => JSON.stringify({ requestJson: JSON.stringify({ jsonrpc: '2.0', id: carrier, method: 'tools/call', params: { arguments: { threadId: chat, includeOutputs: false, maxOutputCharsPerItem: 0, ...args },
    callId: `acb-readonly-${carrier}`, namespace: 'codex_app', threadId: carrier, tool: 'read_thread', turnId: `acb-readonly-${carrier}`, callerSource: 'codex' } }), timeoutMs: 30000, maxFrameBytes: 4096, maxCandidates: 128, expectedProcessId: null, expectedProcessStartedAt: null });
  const cases = [{ turnLimit: 1 }, { turnLimit: 10, cursor: 'older' }, { turnLimit: 11 }, { turnLimit: 2, cursor: 'bad\u0001' }, { turnLimit: 2, cursor: 'x'.repeat(2001) }, { turnLimit: 2, extra: true }];
  const result = ps(`${fn('Fields')}${fn('ReadRequest')}
@(${cases.map(item => `$(try {$null=ReadRequest '${line(item).replaceAll("'", "''")}';'ok'} catch {$_.Exception.Message})`).join(',')}) | ConvertTo-Json -Compress`);
  assert.deepEqual(result, ['ok', 'ok', 'IO', 'IO', 'IO', 'IO']);
});
