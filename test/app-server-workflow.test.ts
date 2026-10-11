import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { defaults } from '../src/config.ts';
import { BackgroundBridge } from '../src/background.ts';
import { createCodexAppServerExecutor } from '../src/codex-app-server.ts';
import { HermesGatewayAdapter } from '../src/hermes-gateway.ts';
import { NotificationDispatcher } from '../src/notification-delivery.ts';
import { createBridgeMcpServer } from '../src/mcp-server.ts';

for (const terminal of ['completed', 'failed'] as const) test(`Hermes/MCP/app-server isolated workflow: ${terminal} terminal, independent acceptance and receipt fencing`, async t => {
  const scope = isolatedDemo(), db = scope.db, authority = new CallerAuthority();
  t.after(() => scope.close());
  const controller = authority.issue({ principal: 'fixture:hermes', instance: 'gateway', executor: 'hermes', controller: true, reviewer: false });
  const worker = authority.issue({ principal: 'fixture:codex', instance: 'worker', executor: 'codex', reviewer: false });
  const reviewer = authority.issue({ principal: 'fixture:reviewer', instance: 'reviewer', executor: null, reviewer: true });
  const workspace = resolve('isolated-app-server-workflow'), registry = new ConversationRegistry(db, authority);
  registry.registerProject('project', 'isolated-app-server-workflow', workspace, controller);
  registry.register({ projectId: 'project', workspacePath: workspace, appProjectId: 'native-project', chatgptConversationId: 'fixture-gpt', chatgptConversationName: 'isolated-app-server-workflow', codexConversationId: 'fixture-codex' }, controller);
  let turns = 0, generated = 0, receipts = 0;
  const spawnFn = ((_exe: string, _args: string[], options: { windowsHide?: boolean; shell?: boolean }) => {
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as unknown as Readable; child.stderr = new EventEmitter() as unknown as Readable;
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    const emit = (value: unknown) => child.stdout!.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    const thread = { id: 'fixture-codex', projectId: 'native-project', cwd: workspace, source: 'appServer', status: { type: 'idle' } };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk)); done();
      if (!request.method || !request.id) return;
      queueMicrotask(() => {
        let result: unknown;
        if (request.method === 'initialize') result = { userAgent: 'isolated-fixture' };
        else if (request.method === 'thread/read') { assert.equal(request.params.includeTurns, false); result = { thread }; }
        else if (request.method === 'thread/resume') result = { thread, cwd: workspace, model: 'gpt-fixture', reasoningEffort: 'high', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false } };
        else if (request.method === 'turn/start') {
          turns++;
          assert.equal(request.params.input[0].text, '[ISOLATED TEST] trusted fixture engineering Prompt');
          assert.equal(new TaskStore(db, authority).listTasks()[0].status, 'RUNNING');
          result = { turn: { id: 'fixture-turn', status: 'inProgress', error: null } };
        } else throw new Error('Unexpected fixture RPC');
        emit({ id: request.id, result });
        if (request.method === 'turn/start') emit({ method: 'turn/completed', params: { threadId: 'fixture-codex', turn: { id: 'fixture-turn', status: terminal, error: terminal === 'failed' ? { message: 'private-fixture-diagnostic' } : null } } });
      });
    } });
    return child;
  }) as typeof spawn;
  const config = defaults(); config.agents.chatgpt = { enabled: true, model: 'gpt-fixture', reasoningEffort: 'high' }; config.agents.codex.enabled = true;
  const bridge = new BackgroundBridge(db, authority, controller, config, { executorContext: worker,
    ordinaryChat: {
      inspect: async () => ({ source: 'application-host', ordinaryChat: true, background: true, exactConversation: true, completeMessages: true, actualGenerationParameters: true, createOrdinaryChat: true, createWorkspace: true, models: ['gpt-fixture'], reasoningEfforts: ['high'] }),
      inspectConversation: async () => ({ kind: 'ordinary-chat', name: 'isolated-app-server-workflow', source: 'application-navigation', conversationId: 'fixture-gpt', projectId: 'native-project', workspacePath: workspace }),
      generate: async () => { generated++; return { content: '[ISOLATED TEST] trusted fixture engineering Prompt', sourceMessageId: 'fixture-source', sourceConversationId: 'fixture-gpt', sourceConversationName: 'isolated-app-server-workflow', actualModel: 'gpt-fixture', actualReasoningEffort: 'high', complete: true, evidenceSource: 'application-host' }; },
    },
    executor: createCodexAppServerExecutor({ executable: 'fixture', model: 'gpt-fixture', reasoningEffort: 'high', selfMcpServerName: 'acb', timeoutMs: 1000, interruptTimeoutMs: 100, spawnFn,
      inspect: async target => ({ source: 'codex-app-state', local: true, conversationId: target.codexConversationId, appProjectId: 'native-project', workspacePath: workspace }), assertExclusive: async () => {} }),
  });
  const server = createBridgeMcpServer({ bridge, db, authority, context: controller, notificationLeaseMs: 1000, version: '0.2.0' });
  const client = new Client({ name: 'isolated-hermes', version: '0.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await client.connect(clientTransport);
  const event = { schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_fixture0001' } }, message: { message_id: 'om_fixture0001', chat_id: 'oc_fixture0001', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '[ISOLATED TEST] raw user requirement' }) } } };
  const gateway = new HermesGatewayAdapter(bridge, { projectForMessage: identity => identity.senderOpenId === 'ou_fixture0001' ? 'project' : null });
  const request = gateway.accept(event); assert.equal(gateway.accept(event).requestId, request.requestId);
  await bridge.tick(); assert.equal(generated, 1); assert.equal(turns, 1);
  const status = await client.callTool({ name: 'acb_request_get', arguments: { requestId: request.requestId } });
  const current = JSON.parse((status.content as { text: string }[])[0].text);
  assert.equal(current.state, terminal === 'completed' ? 'WAITING_APPROVAL' : 'UNCERTAIN');
  assert.equal(db.prepare('SELECT state FROM execution_runs').get()!.state, terminal === 'completed' ? 'WAITING_APPROVAL' : 'UNCERTAIN');
  const selfReview = await client.callTool({ name: 'acb_review_submit', arguments: { taskId: current.taskId, expectedVersion: current.version, pass: true } });
  assert.equal(selfReview.isError, true);
  if (terminal === 'completed') {
    assert.equal(new TaskStore(db, authority).verify(current.taskId, worker, true, undefined, current.version).ok, false);
    assert.equal(new TaskStore(db, authority).verify(current.taskId, reviewer, true, 'Isolated Mock acceptance', current.version).ok, true);
    assert.equal(bridge.get(request.requestId).state, 'SUCCEEDED');
  } else {
    assert.throws(() => bridge.retryBlocked(request.requestId), /reconciled/);
    assert.equal(await bridge.tick(), false); assert.equal(turns, 1);
  }
  const dispatcher = new NotificationDispatcher(db, authority, controller, { send: async () => ({ messageId: `om_fixture000${++receipts}` }) }, { timeoutMs: 100, leaseMs: 1000, route: () => ({ type: 'open_id', id: 'ou_fixture0001' }), render: payload => JSON.stringify(payload) });
  const first = await dispatcher.flush(); assert.ok(first.acknowledged > 0); assert.equal(first.blocked, 0);
  const sent = receipts; await dispatcher.flush(); assert.equal(receipts, sent);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE acknowledged_at IS NULL").get()!.n, 0);
});
