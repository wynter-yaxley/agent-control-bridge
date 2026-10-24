import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';
import { CODEX, FakeApp, userTurn } from './fake-app.ts';

async function connect(app = new FakeApp()) {
  const page = { run: <T>(task: () => Promise<T>) => task(), readReply: async () => '', startChat: async () => {} };
  const server = createServer({ app, page, version: '0.0.0', timeoutMs: 1000 });
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { text: string }[])[0].text);

test('the server offers one tool per operation, with read-only ones marked', async () => {
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'acb_codex_create',
    'acb_codex_list',
    'acb_codex_read',
    'acb_codex_send',
    'acb_gpt_create',
    'acb_gpt_list',
    'acb_gpt_read',
    'acb_gpt_send',
    'acb_open',
    'acb_projects',
    'acb_status',
  ]);
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
  assert.deepEqual(readOnly.sort(), [
    'acb_codex_list',
    'acb_codex_read',
    'acb_gpt_list',
    'acb_gpt_read',
    'acb_projects',
    'acb_status',
  ]);
});

test('results are JSON text', async () => {
  const app = new FakeApp();
  app.add({ id: CODEX, kind: 'codex', title: 'Task', turns: [userTurn('t1', 'Q', 'A')] });
  const read = text(await (await connect(app)).callTool({ name: 'acb_codex_read', arguments: { threadId: CODEX } }));
  assert.equal(read.title, 'Task');
  assert.equal(read.turns[0].reply, 'A');
});

test('failures carry their code and details', async () => {
  const result = await (await connect()).callTool({ name: 'acb_codex_read', arguments: { threadId: CODEX } });
  assert.equal(result.isError, true);
  assert.equal(text(result).error, 'NOT_FOUND');
});

test('malformed arguments are rejected before any tool runs', async () => {
  const result = await (await connect()).callTool({ name: 'acb_codex_read', arguments: { threadId: 'nope' } });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0].text, /Expected a Codex conversation ID/);
});
