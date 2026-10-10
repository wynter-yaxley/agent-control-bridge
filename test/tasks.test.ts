import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallerAuthority, type CallerContext } from '../src/caller.ts';
import { TASK_STATUSES, ALLOWED_TRANSITIONS } from '../src/types.ts';
import { fixture, snapshot } from './helpers.ts';

test('independent review is the only successful completion entrance', t => {
  const f = fixture(); t.after(() => f.db.close());
  const task = f.running();
  assert.equal(f.store.transition(task.id, 'SUCCEEDED', f.worker, task.version).ok, false);
  const finish = f.store.executorFinished(task.id, f.worker, 'fixture only', task.version);
  assert.ok(finish.ok); assert.equal(finish.task.status, 'WAITING_APPROVAL');
  assert.equal(f.store.verify(task.id, f.worker, true, undefined, finish.task.version).ok, false);
  const review = f.store.verify(task.id, f.reviewer, true, undefined, finish.task.version);
  assert.ok(review.ok); assert.equal(review.task.status, 'SUCCEEDED');
  assert.equal(f.store.verify(task.id, f.reviewer, true, undefined, finish.task.version).ok, false);
  assert.equal(f.store.cancel(task.id, f.worker, undefined, review.task.version).ok, false);
});
test('missing, JSON-forged, foreign authority, and same-principal reviewer are rejected', t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.awaiting(), before = snapshot(f.db);
  const foreign = new CallerAuthority().issue({ principal: 'user', instance: 'user', executor: 'hermes', reviewer: true });
  const self = f.authority.issue({ principal: 'fixture:pi', instance: 'review', executor: 'hermes', reviewer: true });
  for (const context of [undefined, 'user', { principal: 'user', reviewer: true }, foreign, self]) {
    assert.equal(f.store.verify(task.id, context as CallerContext, true, undefined, task.version).ok, false);
    assert.equal(snapshot(f.db), before);
  }
});
for (const operation of ['finish','cancel','renew'] as const) test(`${operation} requires matching holder and instance`, t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.running(), before = snapshot(f.db);
  for (const caller of [f.other, f.sibling, f.reviewer]) {
    const result = operation === 'finish' ? f.store.executorFinished(task.id, caller, undefined, task.version) : operation === 'cancel' ? f.store.cancel(task.id, caller, undefined, task.version) : f.store.renew(task.id, caller, 600, task.version);
    assert.equal(result.ok, false); assert.equal(snapshot(f.db), before);
  }
});
test('stale version fences duplicate commands and previous-attempt callbacks', t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.running();
  assert.equal(f.store.renew(task.id, f.worker, 600, task.version - 1).ok, false);
  const fail = f.store.transition(task.id, 'FAILED', f.worker, task.version); assert.ok(fail.ok);
  const queue = f.store.transition(task.id, 'QUEUED', f.reviewer, fail.task.version); assert.ok(queue.ok);
  const claim = f.store.claim(task.id, f.worker, 600, queue.task.version); assert.ok(claim.ok);
  assert.equal(claim.task.attempt, 2);
  assert.equal(f.store.executorFinished(task.id, f.worker, undefined, task.version).ok, false);
  assert.equal(f.store.renew(task.id, f.worker, 600).ok, false);
  assert.equal(f.store.getTask(task.id)!.status, 'RUNNING');
});
test('claim enforces executor, lease bounds, and merges state+ownership', t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.create(), before = snapshot(f.db);
  for (const seconds of [0, -1, Infinity, NaN, 86401, 1.2]) assert.equal(f.store.claim(task.id, f.worker, seconds, task.version).ok, false);
  assert.equal(f.store.claim(task.id, f.other, 600, task.version).ok, false); assert.equal(snapshot(f.db), before);
  const r = f.store.claim(task.id, f.worker, 600, task.version); assert.ok(r.ok);
  assert.equal(r.task.claimed_by, 'fixture:pi'); assert.equal(r.task.claimed_instance, 'worker-a'); assert.equal(r.task.version, 1);
});
test('expired owner cannot finish/renew; sweep deduplicates without success', t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.running();
  f.db.prepare('UPDATE tasks SET claim_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', task.id);
  assert.equal(f.store.executorFinished(task.id, f.worker, undefined, task.version).ok, false);
  assert.equal(f.store.renew(task.id, f.worker, 600, task.version).ok, false);
  assert.equal(f.store.sweepExpiredLeases(f.reviewer).length, 1);
  f.store.sweepExpiredLeases(f.reviewer);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM alerts').get()!.n, 1);
  assert.equal(f.store.getTask(task.id)!.status, 'RUNNING');
});
test('block/resume, failure/requeue, cancellation and failed review use CAS', t => {
  const f = fixture(); t.after(() => f.db.close()); let task = f.running();
  const block = f.store.transition(task.id, 'BLOCKED', f.worker, task.version); assert.ok(block.ok);
  const resume = f.store.resume(task.id, f.worker, block.task.version); assert.ok(resume.ok);
  const cancel = f.store.cancel(task.id, f.worker, 'fixture', resume.task.version); assert.ok(cancel.ok); assert.equal(cancel.task.status, 'CANCELLED');
  task = f.awaiting(); const fail = f.store.verify(task.id, f.reviewer, false, 'fixture', task.version); assert.ok(fail.ok); assert.equal(fail.task.status, 'FAILED');
  assert.equal(f.store.transition(task.id, 'QUEUED', f.worker, fail.task.version).ok, false);
});
test('all prohibited state pairs are rejected without persistence', t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const from of TASK_STATUSES) for (const to of TASK_STATUSES) {
    if (ALLOWED_TRANSITIONS[from].includes(to)) continue;
    let task = f.running();
    if (from === 'SUCCEEDED') {
      const finish = f.store.executorFinished(task.id, f.worker, undefined, task.version); assert.ok(finish.ok);
      const verified = f.store.verify(task.id, f.reviewer, true, undefined, finish.task.version); assert.ok(verified.ok); task = verified.task;
    } else f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(from, task.id);
    const before = snapshot(f.db);
    assert.equal(f.store.transition(task.id, to, f.worker, task.version).ok, false, `${from}->${to}`);
    assert.equal(snapshot(f.db), before);
  }
});
test('approval pending CAS prevents reversal/duplicate decision and self-approval', t => {
  const f = fixture(); t.after(() => f.db.close()); const task = f.create();
  const id = f.store.requestApproval(task.id, 'fixture_action', f.worker);
  assert.throws(() => f.store.decideApproval(id, 'approved', f.worker));
  f.store.decideApproval(id, 'approved', f.reviewer);
  const before = snapshot(f.db);
  assert.throws(() => f.store.decideApproval(id, 'rejected', f.reviewer));
  assert.throws(() => f.store.decideApproval('absent', 'approved', f.reviewer));
  assert.equal(snapshot(f.db), before);
});
const actions = ['create','claim','finish','verify','cancel','renew','request','decide','create-with-approval','block','resume','requeue','sweep'] as const;
for (const fault of ['events','audit_log'] as const) for (const action of actions) test(`${action}: ${fault} failure rolls back all persistent steps`, t => {
  const f = fixture(); t.after(() => f.db.close());
  let task = action === 'verify' ? f.awaiting() : ['claim','request','create-with-approval','decide'].includes(action) ? f.create() : f.running();
  let approval: string | undefined;
  if (action === 'decide') approval = f.store.requestApproval(task.id, 'fixture', f.worker);
  if (action === 'resume') { const r = f.store.transition(task.id, 'BLOCKED', f.worker, task.version); assert.ok(r.ok); task = r.task; }
  if (action === 'requeue') { const r = f.store.transition(task.id, 'FAILED', f.worker, task.version); assert.ok(r.ok); task = r.task; }
  if (action === 'sweep') f.db.prepare('UPDATE tasks SET claim_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', task.id);
  const before = snapshot(f.db);
  f.db.exec(`CREATE TRIGGER fixture_fault BEFORE INSERT ON ${fault} BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`);
  assert.throws(() => {
    switch (action) {
      case 'create': f.create(); break;
      case 'claim': f.store.claim(task.id, f.worker, 600, task.version); break;
      case 'finish': f.store.executorFinished(task.id, f.worker, undefined, task.version); break;
      case 'verify': f.store.verify(task.id, f.reviewer, true, undefined, task.version); break;
      case 'cancel': f.store.cancel(task.id, f.worker, undefined, task.version); break;
      case 'renew': f.store.renew(task.id, f.worker, 600, task.version); break;
      case 'request': f.store.requestApproval(task.id, 'fixture', f.worker); break;
      case 'decide': f.store.decideApproval(approval!, 'approved', f.reviewer); break;
      case 'create-with-approval': f.store.createTaskWithApproval({kind:'test',title:'fixture'}, 'fixture', f.worker); break;
      case 'block': f.store.transition(task.id, 'BLOCKED', f.worker, task.version); break;
      case 'resume': f.store.resume(task.id, f.worker, task.version); break;
      case 'requeue': f.store.transition(task.id, 'QUEUED', f.reviewer, task.version); break;
      case 'sweep': f.store.sweepExpiredLeases(f.reviewer); break;
    }
  });
  assert.equal(snapshot(f.db), before); assert.equal(f.db.isTransaction, false);
});
