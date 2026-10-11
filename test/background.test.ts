import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { defaults } from '../src/config.ts';
import { BackgroundBridge, type BackgroundHostBindings } from '../src/background.ts';
import type { OrdinaryChatCapabilities, OrdinaryChatHost } from '../src/ordinary-chat.ts';
import type { BackgroundExecutor } from '../src/background-runner.ts';

export const hostCapabilities: OrdinaryChatCapabilities = { source: 'application-host', ordinaryChat: true, background: true, exactConversation: true, completeMessages: true, actualGenerationParameters: true, createOrdinaryChat: true, createWorkspace: true, models: ['fixture-model'], reasoningEfforts: ['fixture-effort'] };
function setup(t: { after: (fn: () => void) => void }, install = true) {
  const scope = isolatedDemo(); t.after(() => scope.close());
  const db = scope.db, authority = new CallerAuthority();
  const controller = authority.issue({ principal: 'fixture:controller', instance: 'controller', executor: 'hermes', reviewer: false, controller: true });
  const worker = authority.issue({ principal: 'fixture:worker', instance: 'worker', executor: 'codex', reviewer: false });
  const reviewer = authority.issue({ principal: 'fixture:reviewer', instance: 'reviewer', executor: null, reviewer: true });
  const registry = new ConversationRegistry(db, authority), store = new TaskStore(db, authority);
  const config = defaults(); config.agents.chatgpt = { enabled: true, model: 'fixture-model', reasoningEffort: 'fixture-effort' }; config.agents.codex.enabled = true;
  const path = resolve('fixture-project'); registry.registerProject('project', 'fixture-project', path, controller);
  registry.register({ projectId: 'project', workspacePath: path, appProjectId: 'native-project', chatgptConversationId: 'fixture-gpt', chatgptConversationName: 'fixture-project', codexConversationId: 'fixture-codex' }, controller);
  let generated = 0, executed = 0;
  const ordinaryChat: OrdinaryChatHost = {
    inspect: async () => hostCapabilities,
    inspectConversation: async () => ({ kind: 'ordinary-chat', name: 'fixture-project', source: 'application-navigation', conversationId: 'fixture-gpt', projectId: 'native-project', workspacePath: path }),
    generate: async () => { generated++; return { content: '[ISOLATED TEST] engineering prompt', sourceMessageId: 'fixture-message', sourceConversationId: 'fixture-gpt', sourceConversationName: 'fixture-project', actualModel: 'fixture-model', actualReasoningEffort: 'fixture-effort', complete: true, evidenceSource: 'application-host' }; },
  };
  const executor: BackgroundExecutor = {
    mode: 'mock',
    inspect: async target => ({ source: 'codex-app-state', local: true, conversationId: target.codexConversationId, appProjectId: 'native-project', workspacePath: path }),
    execute: async (content, key, target, _signal, onEvent) => {
      executed++; assert.equal(content, '[ISOLATED TEST] engineering prompt');
      const run = db.prepare('SELECT * FROM execution_runs WHERE id=?').get(key)!;
      const task = store.getTask(String(run.task_id))!;
      assert.equal(task.status, 'RUNNING'); assert.equal(task.attempt, 1); assert.equal(task.claimed_by, 'fixture:worker'); assert.equal(task.execution_prompt_id, run.prompt_id);
      onEvent?.({ type: 'thread.started' }); onEvent?.({ type: 'turn.completed' });
      return { executionId: 'fixture-execution', codexConversationId: target.codexConversationId, workspacePath: path };
    },
  };
  const host: BackgroundHostBindings = install ? { ordinaryChat, executor, executorContext: worker } : {};
  const bridge = new BackgroundBridge(db, authority, controller, config, host);
  const submit = (eventKey = 'fixture-feishu-event') => bridge.submit({ eventKey, projectId: 'project', title: 'isolated requirement', requirement: '[TEST] create the feature' });
  return { db, authority, controller, worker, reviewer, store, config, host, ordinaryChat, executor, bridge, submit, generated: () => generated, executed: () => executed };
}
test('background: queued requirement -> trusted ordinary GPT -> claim before execution -> independent acceptance', async t => {
  const f = setup(t); const request = f.submit(); assert.equal(f.submit().requestId, request.requestId);
  assert.equal(await f.bridge.tick(), true); const complete = f.bridge.get(request.requestId);
  assert.equal(complete.state, 'WAITING_APPROVAL'); assert.equal(complete.taskStatus, 'WAITING_APPROVAL'); assert.equal(complete.lastEvent?.kind, 'turn.completed');
  assert.equal(f.generated(), 1); assert.equal(f.executed(), 1); assert.equal(await f.bridge.tick(), false);
  assert.equal(f.store.verify(complete.taskId, f.worker, true, undefined, complete.version).ok, false);
  assert.equal(f.store.verify(complete.taskId, f.reviewer, true, undefined, complete.version).ok, true);
  assert.equal(f.bridge.get(request.requestId).taskStatus, 'SUCCEEDED');
});
test('background: missing host blocks durably; raw requirement never invokes an executor', async t => {
  const f = setup(t, false), request = f.submit(); await f.bridge.tick();
  assert.equal(f.bridge.get(request.requestId).state, 'BLOCKED'); assert.equal(f.bridge.get(request.requestId).taskStatus, 'QUEUED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n, 0); assert.equal(f.executed(), 0);
  assert.equal((await f.bridge.capabilities()).fullWorkflowReady, false);
  assert.equal(await f.bridge.tick(), false);
  assert.throws(() => f.bridge.submit({ eventKey: 'fixture-feishu-event', projectId: 'project', title: 'changed', requirement: 'changed' }), /reused/);
});
test('background: another controller cannot read requests or acknowledge its notifications', async t => {
  const f = setup(t), request = f.submit();
  const other = f.authority.issue({ principal: 'fixture:other', instance: 'other', executor: 'hermes', reviewer: false, controller: true });
  const otherBridge = new BackgroundBridge(f.db, f.authority, other, f.config);
  assert.throws(() => otherBridge.get(request.requestId), /not found/); assert.deepEqual(otherBridge.outbox.pull(other), []);
  assert.throws(() => otherBridge.submit({eventKey:'foreign',projectId:'project',title:'foreign',requirement:'foreign'}),/assigned/);
});
test('background: overlapping polls do not generate or execute twice', async t => {
  const f = setup(t), original = f.ordinaryChat.generate;
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  f.ordinaryChat.generate = async (...args) => { await pending; return original(...args); };
  f.submit(); const first = f.bridge.tick(); await Promise.resolve(); assert.equal(await f.bridge.tick(), false);
  release(); await first; assert.equal(f.generated(), 1); assert.equal(f.executed(), 1);
});
test('background: unknown actual model is not executable and never becomes a successful task', async t => {
  const f = setup(t), original = f.ordinaryChat.generate;
  f.ordinaryChat.generate = async (...args) => ({ ...await original(...args), actualModel: null });
  const request = f.submit(); await f.bridge.tick(); assert.equal(f.bridge.get(request.requestId).state, 'BLOCKED'); assert.equal(f.executed(), 0);
  assert.equal(f.db.prepare('SELECT verified FROM prompts').get()!.verified, 0);
});
test('background: switched local execution target is rejected before claim or spawn', async t => {
  const f = setup(t); f.executor.inspect = async target => ({ source: 'codex-app-state', local: false, conversationId: target.codexConversationId, appProjectId: 'other', workspacePath: '/fixture/other' });
  const request = f.submit(); await f.bridge.tick();
  assert.equal(f.executed(), 0); assert.equal(f.bridge.get(request.requestId).taskStatus, 'QUEUED'); assert.equal(f.bridge.get(request.requestId).attempt, 0);
});
test('background: external timeout remains fenced and rejects automatic retry', async t => {
  const f = setup(t); f.config.background.timeoutMs = 15;
  f.executor.execute = async () => new Promise(() => {});
  const request = f.submit(); await f.bridge.tick(); const current = f.bridge.get(request.requestId);
  assert.equal(current.state, 'UNCERTAIN'); assert.equal(current.taskStatus, 'RUNNING');
  assert.throws(() => f.bridge.retryBlocked(request.requestId), /reconciled/);
  assert.equal(await f.bridge.tick(), false); assert.equal(f.db.prepare('SELECT state FROM execution_runs').get()!.state, 'UNCERTAIN');
});
test('background: starting another observer never changes a possibly live task holder', async t => {
  const f = setup(t), request = f.submit(); f.db.prepare("UPDATE background_requests SET state='RUNNING' WHERE id=?").run(request.requestId);
  f.bridge.start(); await f.bridge.shutdown();
  assert.equal(f.bridge.get(request.requestId).state, 'RUNNING'); assert.equal(f.executed(), 0);
});
