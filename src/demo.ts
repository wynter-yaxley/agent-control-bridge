import { CallerAuthority } from './caller.ts';
import { isolatedDemo } from './demo-scope.ts';
import { TaskStore } from './tasks.ts';
import { PromptPipeline } from './prompts.ts';
import { Watcher } from './watcher.ts';
import { defaults } from './config.ts';
export async function runDemo() {
  const scope = isolatedDemo();
  try {
    const authority = new CallerAuthority(), store = new TaskStore(scope.db, authority);
    const hermes = authority.issue({ principal: 'mock:hermes-reviewer', instance: 'demo-reviewer', executor: 'hermes', reviewer: true });
    const codex = authority.issue({ principal: 'mock:codex-executor', instance: 'demo-executor', executor: 'codex', reviewer: false });
    const task = store.createTask({ title: 'Explicit Mock workflow, no real model invoked', kind: 'demo', executor: 'codex' }, hermes);
    const config = defaults(scope.root); let deliveries = 0;
    const pipeline = new PromptPipeline(scope.db, authority, {
      source: 'mock-chatgpt', capabilities: async () => ({ verified: true, models: ['gpt-6'], reasoningEfforts: ['high'] }),
      generate: async () => ({ content: '[MOCK TEST DATA] Implement a deterministic fixture and submit it for independent review.', sourceMessageId: 'mock-message-1', actualModel: 'mock:gpt-6', actualReasoningEffort: 'mock:high' }),
    }, { model: config.agents.chatgpt.model, reasoningEffort: config.agents.chatgpt.reasoningEffort }, {
      deliver: async (_content, key) => { deliveries++; return { executionId: `mock-execution:${key}` }; },
    });
    const promptId = await pipeline.generate(task.id, 'User requirement: run an isolated demonstration', hermes);
    await pipeline.deliver(promptId, hermes); await pipeline.deliver(promptId, hermes);
    const claim = store.claim(task.id, codex, 600, task.version); if (!claim.ok) throw new Error(claim.error);
    const progress = store.progress(task.id, codex, 'Mock implementation and tests completed', claim.task.version); if (!progress.ok) throw new Error(progress.error);
    const finish = store.executorFinished(task.id, codex, 'Mock deliverable ready', progress.task.version); if (!finish.ok) throw new Error(finish.error);
    const denied = store.verify(task.id, codex, true, 'Self acceptance must fail', finish.task.version);
    if (denied.ok) throw new Error('Executor obtained review rights');
    const watcher = new Watcher(scope.db); const notifications = await watcher.runOnce();
    const duplicate = await new Watcher(scope.db).runOnce();
    const verified = store.verify(task.id, hermes, true, 'Independent Mock acceptance only', finish.task.version); if (!verified.ok) throw new Error(verified.error);
    return { deliveryState: 'DELIVERED_PENDING_ACCEPTANCE', mode: 'ISOLATED_MOCK', realModelInvoked: false,
      simulatedTask: verified.task, promptId, deliveries, executorSelfReviewDenied: !denied.ok,
      notifications: [...notifications, ...await watcher.runOnce()], duplicateNotifications: duplicate.length,
      schemaVersion: scope.db.prepare('PRAGMA user_version').get()!.user_version,
      auditCount: scope.db.prepare('SELECT COUNT(*) n FROM audit_log').get()!.n };
  } finally { scope.close(); }
}
