import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CallerAuthority, delegatedExecutor, policySummary } from '../src/caller.ts';
import { isolatedDemo } from '../src/demo-scope.ts';
import { defaults } from '../src/config.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { BackgroundBridge } from '../src/background.ts';
import { createLedgerCodexApproval, createLedgerInitializationApproval, pendingApprovals } from '../src/trusted-host.ts';
import { policyBindings, executorGaps } from '../src/windows-host.ts';
import type { BackgroundExecutor } from '../src/background-runner.ts';
import { hostCapabilities } from './fixtures/host-capabilities.ts';

// Well-formed, unique synthetic SIDs: the Windows policy parser validates them,
// and no real account uses this made-up domain identifier.
const CONTROLLER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001', EXECUTOR_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1002';
const REVIEWER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1003', SECOND_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1004';
const controllerEntry = { principal: CONTROLLER_SID, instance: 'hermes-controller', executor: 'hermes', controller: true, reviewer: false } as const;
const executorIdentity = { principal: EXECUTOR_SID, instance: 'codex-production', executor: 'codex', controller: false, reviewer: false } as const;
const executorEntry = { ...executorIdentity, host: CONTROLLER_SID };
const reviewerEntry = { principal: REVIEWER_SID, instance: 'independent-reviewer', executor: null, controller: false, reviewer: true } as const;
function policy(t: { after: (fn: () => void) => void }, entries: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'acb-trusted-policy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'caller-policy.json'); writeFileSync(path, JSON.stringify(entries)); return path;
}

test('trusted host: only an explicit protected-policy delegation yields a distinct executor', t => {
  const authority = new CallerAuthority(), controller = authority.issue(controllerEntry), reviewer = authority.issue(reviewerEntry);
  assert.equal(delegatedExecutor(authority, policy(t, [controllerEntry, { ...executorEntry, host: undefined }, reviewerEntry]), controller), undefined);
  const path = policy(t, [controllerEntry, executorEntry, reviewerEntry]);
  const executor = authority.resolve(delegatedExecutor(authority, path, controller))!;
  assert.deepEqual({ ...executor }, { principal: EXECUTOR_SID, instance: 'codex-production', executor: 'codex', controller: false, reviewer: false });
  assert.deepEqual(policySummary(path, CONTROLLER_SID), { entries: 3, controllers: 1, codexExecutors: 1, reviewers: 1, delegatedExecutorInstance: 'codex-production', delegationsToCaller: 1 });
  assert.throws(() => delegatedExecutor(authority, path, reviewer), { code: 'AUTH' });
  for (const entries of [
    [controllerEntry, executorEntry, { ...executorEntry, principal: SECOND_SID, instance: 'second' }],
    [controllerEntry, { ...executorEntry, executor: 'pi' }],
    [controllerEntry, { ...executorEntry, reviewer: true }],
    [controllerEntry, { ...executorEntry, host: REVIEWER_SID }, reviewerEntry],
    [controllerEntry, { ...executorEntry, host: EXECUTOR_SID }],
    [controllerEntry, { ...executorEntry, instance: 'hermes-controller' }],
  ]) assert.throws(() => delegatedExecutor(authority, policy(t, entries), controller), { code: 'AUTH' }, JSON.stringify(entries));
});

test('trusted host: Windows policy parsing accepts the synthetic SIDs and refuses non-SID or broad principals', t => {
  // Exercise the real win32 validation branch on every platform; restored before any other code runs.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const asWindows = <T>(run: () => T): T => { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); try { return run(); } finally { Object.defineProperty(process, 'platform', platform); } };
  const authority = new CallerAuthority(), controller = authority.issue(controllerEntry);
  assert.equal(asWindows(() => authority.resolve(delegatedExecutor(authority, policy(t, [controllerEntry, executorEntry, reviewerEntry]), controller))?.principal), EXECUTOR_SID);
  for (const principal of ['fixture:executor', 'S-1-5-', 'S-1-5-21-x', 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'])
    assert.throws(() => asWindows(() => delegatedExecutor(authority, policy(t, [controllerEntry, { ...executorEntry, principal }, reviewerEntry]), controller)), { code: 'AUTH' }, principal);
  assert.throws(() => asWindows(() => delegatedExecutor(authority, policy(t, [controllerEntry, { ...executorEntry, host: 'fixture:controller' }, reviewerEntry]), controller)), { code: 'AUTH' });
  assert.equal(process.platform, platform.value);
});

test('trusted host: policy bindings give a controller its delegated executor and ledger approvals, never a reviewer', async t => {
  const scope = isolatedDemo(); t.after(() => scope.close());
  const authority = new CallerAuthority(), config = defaults(scope.root), path = policy(t, [controllerEntry, executorEntry, reviewerEntry]);
  const controller = policyBindings({ config, authority, context: authority.issue(controllerEntry), db: scope.db }, undefined, path);
  assert.equal(authority.resolve(controller.executorContext)?.principal, EXECUTOR_SID); assert.equal(typeof controller.approveCodex, 'function');
  assert.equal(controller.projects, undefined); assert.equal(controller.ordinaryChat, undefined);
  const native = { listProjects: async () => ({ projects: [] }), listThreads: async () => ({ threads: [], pinnedThreads: [] }), readThread: async () => assert.fail('No read expected') };
  const readOnly = policyBindings({ config, authority, context: authority.issue(controllerEntry), db: scope.db }, native, path).projects!;
  const capabilities = await readOnly.inspect(new AbortController().signal);
  assert.equal(capabilities.createWorkspace, false); assert.equal(capabilities.createOrdinaryChat, false); assert.equal(typeof readOnly.verifyExisting, 'function');
  const reviewer = policyBindings({ config, authority, context: authority.issue(reviewerEntry), db: scope.db }, undefined, path);
  assert.equal(reviewer.executorContext, undefined); assert.equal(reviewer.approveCodex, undefined);
  assert.deepEqual(executorGaps(config, reviewer), ['EXECUTOR_DELEGATION_MISSING', 'CARRIER_THREAD_MISSING', 'CODEX_EXECUTABLE_MISSING', 'CODEX_MODEL_OR_EFFORT_MISSING']);
});

test('trusted host: Codex approvals bind the live run/turn, wait for an independent reviewer and otherwise decline', async t => {
  const scope = isolatedDemo(); t.after(() => scope.close());
  const db = scope.db, authority = new CallerAuthority(), config = defaults(scope.root);
  config.agents.chatgpt = { enabled: true, model: 'fixture-model', reasoningEffort: 'fixture-effort' }; config.agents.codex.enabled = true;
  const controller = authority.issue(controllerEntry), executor = authority.issue(executorIdentity), reviewer = authority.issue(reviewerEntry);
  const path = resolve(scope.root, 'fixture-project'), registry = new ConversationRegistry(db, authority);
  registry.registerProject('project', 'fixture-project', path, controller);
  registry.register({ projectId: 'project', workspacePath: path, appProjectId: 'native-project', chatgptConversationId: 'fixture-gpt', chatgptConversationName: 'fixture-project', codexConversationId: 'fixture-codex' }, controller);
  const approve = createLedgerCodexApproval({ db, authority, executor, timeoutMs: 300, pollMs: 10 });
  const outcomes: string[] = [];
  const decide = async (decision: 'approved' | 'rejected') => {
    for (let i = 0; i < 100; i++) {
      const [pending] = pendingApprovals(db, authority, reviewer);
      if (pending) {
        assert.throws(() => new TaskStore(db, authority).decideApproval(String(pending.approvalId), 'approved', controller), { code: 'AUTH' });
        assert.throws(() => new TaskStore(db, authority).decideApproval(String(pending.approvalId), 'approved', executor), { code: 'AUTH' });
        assert.equal(pendingApprovals(db, authority, controller).length, 1);
        new TaskStore(db, authority).decideApproval(String(pending.approvalId), decision, reviewer, '[TEST] scoped decision'); return;
      }
      await new Promise(done => setTimeout(done, 5));
    }
    assert.fail('No approval was requested');
  };
  const codex: BackgroundExecutor = {
    mode: 'mock',
    inspect: async target => ({ source: 'codex-app-state', local: true, conversationId: target.codexConversationId, appProjectId: 'native-project', workspacePath: path }),
    execute: async (_content, key, target, signal, onEvent) => {
      const ask = (params: Record<string, unknown>) => approve({ method: 'item/commandExecution/requestApproval', params: { threadId: target.codexConversationId, turnId: 'fixture-turn', ...params }, target, dispatchId: key }, signal);
      outcomes.push(await ask({ command: 'npm test' }));
      onEvent?.({ type: 'turn.started', turnId: 'fixture-turn' });
      outcomes.push(await ask({ turnId: 'foreign-turn', command: 'npm test' }));
      outcomes.push(await ask({ cwd: resolve(scope.root, 'other-project'), command: 'npm test' }));
      outcomes.push(await ask({ command: 'echo sk-proj-' + 'A'.repeat(40) }));
      const [accepted] = await Promise.all([ask({ cwd: path, command: 'npm test' }), decide('approved')]); outcomes.push(accepted);
      const [rejected] = await Promise.all([ask({ command: 'git push' }), decide('rejected')]); outcomes.push(rejected);
      outcomes.push(await ask({ command: 'npm run build' }));
      return { executionId: 'fixture-turn', codexConversationId: target.codexConversationId, workspacePath: path, output: { content: '[TEST] delivery', messageIds: ['fixture-message'] } };
    },
  };
  const ordinaryChat = { inspect: async () => hostCapabilities, inspectConversation: async () => ({ kind: 'ordinary-chat' as const, name: 'fixture-project', source: 'application-navigation' as const, conversationId: 'fixture-gpt', projectId: 'native-project', workspacePath: path }),
    generate: async () => ({ content: '[ISOLATED TEST] engineering prompt', sourceMessageId: 'fixture-message', sourceConversationId: 'fixture-gpt', sourceConversationName: 'fixture-project', actualModel: 'fixture-model', actualReasoningEffort: 'fixture-effort', complete: true, evidenceSource: 'application-host' as const }) };
  const bridge = new BackgroundBridge(db, authority, controller, config, { ordinaryChat, executor: codex, executorContext: executor });
  const request = bridge.submit({ eventKey: 'approval-flow', projectId: 'project', title: 'isolated', requirement: '[TEST] approvals' });
  assert.equal(await bridge.tick(), true);
  // Before turn receipt, foreign turn, out-of-workspace cwd and secrets decline without a ledger request.
  assert.deepEqual(outcomes, ['decline', 'decline', 'decline', 'decline', 'accept', 'decline', 'decline']);
  const rows = db.prepare('SELECT decision,decided_by,requested_by,action FROM approvals ORDER BY requested_at,rowid').all();
  assert.deepEqual(rows.map(row => [row.decision, row.decided_by, row.requested_by]), [['approved', REVIEWER_SID, EXECUTOR_SID], ['rejected', REVIEWER_SID, EXECUTOR_SID], ['rejected', 'acb:expired', EXECUTOR_SID]]);
  assert.match(String(rows[0].action), /"turnId":"fixture-turn".*"command":"npm test"/);
  assert.throws(() => new TaskStore(db, authority).decideApproval(String(db.prepare("SELECT id FROM approvals WHERE decided_by='acb:expired'").get()!.id), 'approved', reviewer), { code: 'CONFLICT' });
  const done = bridge.get(request.requestId); assert.equal(done.taskStatus, 'WAITING_APPROVAL');
  assert.equal(new TaskStore(db, authority).verify(done.taskId, controller, true, undefined, done.version).ok, false);
  assert.equal(new TaskStore(db, authority).verify(done.taskId, executor, true, undefined, done.version).ok, false);
  assert.equal(new TaskStore(db, authority).verify(done.taskId, reviewer, true, undefined, done.version).ok, true);
});

test('trusted host: GUI initialization is a reviewer-decided ledger approval, scoped to one name/path and time window', async t => {
  const scope = isolatedDemo(); t.after(() => scope.close());
  const db = scope.db, authority = new CallerAuthority(), controller = authority.issue(controllerEntry), reviewer = authority.issue(reviewerEntry), store = new TaskStore(db, authority);
  const approve = createLedgerInitializationApproval({ db, authority, controller, timeoutMs: 300, pollMs: 10 }), signal = new AbortController().signal;
  const decide = async (decision: 'approved' | 'rejected') => {
    for (let i = 0; i < 100; i++) {
      const [pending] = pendingApprovals(db, authority, reviewer);
      if (pending) {
        assert.match(String(pending.action), /"kind":"gui-initialization".*"name":"fixture-project"/);
        assert.throws(() => store.decideApproval(String(pending.approvalId), 'approved', controller), { code: 'AUTH' });
        store.decideApproval(String(pending.approvalId), decision, reviewer); return;
      }
      await new Promise(done => setTimeout(done, 5));
    }
  };
  const [granted] = await Promise.all([approve('fixture-project', 'D:\\fixture-project', signal), decide('approved')]);
  assert.equal(granted, true);
  assert.equal(await approve('fixture-project', 'd:\\FIXTURE-PROJECT', signal), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM approvals').get()!.n, 1);
  const [refused] = await Promise.all([approve('fixture-project', 'D:\\other', signal), decide('rejected')]);
  assert.equal(refused, false);
  assert.equal(await approve('silent', 'D:\\silent', signal), false);
  assert.deepEqual(db.prepare('SELECT decision,decided_by FROM approvals ORDER BY rowid').all().map(row => [row.decision, row.decided_by]), [['approved', REVIEWER_SID], ['rejected', REVIEWER_SID], ['rejected', 'acb:expired']]);
  assert.deepEqual(db.prepare("SELECT DISTINCT status FROM tasks WHERE kind='gui-initialization'").all().map(row => row.status), ['CANCELLED']);
  const config = defaults(scope.root), native = { listProjects: async () => ({ projects: [] }), listThreads: async () => ({ threads: [], pinnedThreads: [] }), readThread: async () => assert.fail('No read expected') };
  const path = policy(t, [controllerEntry, executorEntry, reviewerEntry]);
  assert.equal((await policyBindings({ config, authority, context: controller, db }, native, path).projects!.inspect(signal)).createWorkspace, false);
  config.desktop.enabled = true;
  assert.equal((await policyBindings({ config, authority, context: controller, db }, native, path).projects!.inspect(signal)).createWorkspace, true);
  assert.equal((await policyBindings({ config, authority, context: reviewer, db }, native, path).projects!.inspect(signal)).createWorkspace, false);
});
