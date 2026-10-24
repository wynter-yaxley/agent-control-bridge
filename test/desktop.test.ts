import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Desktop, type Json, toolResult } from '../src/desktop.ts';
import { AcbError } from '../src/errors.ts';
import { exchange, pipeTransport } from '../src/pipe.ts';
import { CALLER, CODEX } from './fake-app.ts';

const result = (success: boolean, text: string) => ({
  jsonrpc: '2.0',
  result: { success, contentItems: [{ type: 'inputText', text }] },
});
const ok = (value: unknown) => result(true, JSON.stringify(value));
const refused = (text: string) => result(false, text);
const code = (expected: string) => (error: unknown) => error instanceof AcbError && error.code === expected;

/** A transport that answers every request with `answer`, echoing the request's ID. */
function answering(answer: (request: Json) => Json) {
  return async (request: Json): Promise<Json> => ({ ...answer(request), id: request.id });
}

test('a tool call names the codex_app namespace and its caller', async () => {
  const requests: Json[] = [];
  const project = { projectId: 'p', label: 'L', path: 'D:\\P', isGitRepository: true };
  const app = new Desktop({
    caller: CALLER,
    transport: answering((request) => {
      requests.push(request);
      return ok({ projects: [project] });
    }),
  });
  assert.deepEqual(await app.listProjects(), [project]);
  const params = requests[0].params as Json;
  assert.equal(requests[0].method, 'tools/call');
  assert.equal(params.namespace, 'codex_app');
  assert.equal(params.tool, 'list_projects');
  assert.equal(params.threadId, CALLER);
});

test('app failures become error codes', () => {
  assert.throws(() => toolResult('read_thread', refused('No Codex thread found for threadId: x')), code('NOT_FOUND'));
  assert.throws(
    () => toolResult('send_message_to_thread', refused('session x is archived. Run `codex unarchive x`')),
    (error) => code('FAILED')(error) && (error as AcbError).details.archived === true,
  );
  assert.throws(
    () => toolResult('read_thread', refused('read_thread received invalid arguments: turnLimit')),
    code('INPUT'),
  );
  assert.throws(
    () => toolResult('list_threads', { error: { code: -32000, message: 'Codex app tool request failed' } }),
    code('PROTOCOL'),
  );
});

test('only tools known to answer in text may do so', () => {
  assert.deepEqual(toolResult('set_thread_title', result(true, 'Renamed')), { text: 'Renamed' });
  assert.throws(() => toolResult('list_threads', result(true, 'Listed')), code('PROTOCOL'));
});

test('an answer to another request is refused', async () => {
  const app = new Desktop({ caller: CALLER, transport: async () => ({ ...ok({ projects: [] }), id: 'other' }) });
  await assert.rejects(app.listProjects(), code('PROTOCOL'));
});

test('the caller is the most recent Codex conversation the app accepts', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'acb-'));
  const index = [CALLER, CODEX, 'not-an-id'].map((id) => JSON.stringify({ id, thread_name: 'x' })).join('\n');
  writeFileSync(join(codexHome, 'session_index.jsonl'), `${index}\n`);
  const tried: unknown[] = [];
  const app = new Desktop({
    codexHome,
    transport: answering((request) => {
      const caller = (request.params as Json).threadId;
      tried.push(caller);
      if (caller === CODEX)
        return { jsonrpc: '2.0', error: { code: -32000, message: 'Codex app tool request failed' } };
      return ok({ projects: [] });
    }),
  });
  assert.equal(await app.caller(), CALLER);
  assert.deepEqual(tried, [CODEX, CALLER]);
});

test('without any Codex conversation there is no caller', async () => {
  const app = new Desktop({ codexHome: mkdtempSync(join(tmpdir(), 'acb-')), transport: answering(() => ok({})) });
  await assert.rejects(app.caller(), code('UNAVAILABLE'));
});

test('a thread page keeps turns, active flags and a cursor only when there is more', async () => {
  const app = new Desktop({
    caller: CALLER,
    transport: answering(() =>
      ok({
        thread: {
          id: CODEX,
          kind: 'codex',
          title: 'T',
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
        page: { nextCursor: 'next', hasMore: false },
        turns: [{ id: 't1', status: 'inProgress', items: [{ type: 'userMessage', content: [] }] }],
      }),
    ),
  });
  const page = await app.readThread(CODEX);
  assert.deepEqual(page.activeFlags, ['waitingOnApproval']);
  assert.equal(page.nextCursor, null);
  assert.equal(page.turns[0].id, 't1');
});

test('a list without its rows is a protocol error, and kinds the app could not list are reported', async () => {
  const broken = new Desktop({ caller: CALLER, transport: answering(() => ok({ pinnedThreads: [] })) });
  await assert.rejects(broken.listThreads(), code('PROTOCOL'));
  const threads = [
    { id: CODEX, kind: 'codex', title: 'T' },
    { id: 'w', kind: 'work', title: 'Cloud task' },
  ];
  const partial = new Desktop({
    caller: CALLER,
    transport: answering(() => ok({ threads, unavailableSources: ['chatgpt'] })),
  });
  const inventory = await partial.listThreads();
  assert.deepEqual(
    inventory.threads.map((thread) => thread.id),
    [CODEX],
  );
  assert.deepEqual(inventory.unavailable, ['chatgpt']);
});

function socketPath(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\acb-test-${randomUUID()}`
    : join(tmpdir(), `acb-${randomUUID()}.sock`);
}

/** A pipe server that answers each framed request with `answer`, written in small chunks. */
async function frameServer(answer: (request: Json) => Json): Promise<{ path: string; close: () => void }> {
  const path = socketPath();
  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4 || received.length < 4 + received.readUInt32LE(0)) return;
      const body = Buffer.from(JSON.stringify(answer(JSON.parse(received.subarray(4).toString('utf8')))));
      const frame = Buffer.concat([Buffer.alloc(4), body]);
      frame.writeUInt32LE(body.length);
      for (let at = 0; at < frame.length; at += 3) socket.write(frame.subarray(at, at + 3));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, close: () => server.close() };
}

test('requests and responses are length-prefixed JSON', async () => {
  const server = await frameServer((request) => ({ echo: request, text: '中文' }));
  try {
    assert.deepEqual(await exchange(server.path, { id: 1 }, 2000), { echo: { id: 1 }, text: '中文' });
  } finally {
    server.close();
  }
});

test('a request that never left is sent again on the pipe found anew', async () => {
  const server = await frameServer(() => ({ ok: true }));
  const paths = [socketPath(), server.path];
  try {
    const send = pipeTransport(async () => paths.shift() as string, 2000);
    assert.deepEqual(await send({ id: 1 }), { ok: true });
  } finally {
    server.close();
  }
});

test('a request that reached the app is never sent again', async () => {
  let connections = 0;
  const path = socketPath();
  const server = createServer((socket) => {
    connections++;
    socket.once('data', () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const send = pipeTransport(async () => path, 2000);
    await assert.rejects(send({ id: 1 }), code('PROTOCOL'));
    assert.equal(connections, 1);
  } finally {
    server.close();
  }
});
