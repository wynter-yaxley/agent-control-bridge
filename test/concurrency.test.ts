import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.ts';

async function race(path: string, id: string, version: number, operations: { operation?: string; principal: string; instance: string; timeout?: number }[]) {
  const barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
  let ready = 0;
  return Promise.all(operations.map(operation => new Promise<{ok: boolean; code?: string}>((resolve, reject) => {
    const worker = new Worker(new URL('./claim-worker.mjs', import.meta.url), { workerData: { path, id, version, barrier, ...operation } });
    const deadline = setTimeout(() => { void worker.terminate(); reject(new Error('Fixture barrier timed out')); }, 15000);
    worker.on('error', error => { clearTimeout(deadline); reject(error); });
    worker.on('message', message => {
      if (message.ready) { ready++; if (ready === operations.length) { Atomics.store(state, 0, 1); Atomics.notify(state, 0); } }
      else { clearTimeout(deadline); resolve(message.result); }
    });
  })));
}
test('barrier: independent SQLite connections double-claim, exactly one wins (10 rounds)', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-race-')), path = join(root, 'bridge.db');
  const f = fixture(path); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  for (let round = 0; round < 10; round++) {
    const task = f.create();
    const results = await race(path, task.id, task.version, [{principal:'fixture:pi-a',instance:'a'}, {principal:'fixture:pi-b',instance:'b'}]);
    assert.equal(results.filter(r => r.ok).length, 1);
    const stored = f.store.getTask(task.id)!;
    assert.equal(stored.status, 'RUNNING'); assert.equal(stored.version, 1); assert.equal(stored.attempt, 1);
    assert.equal(stored.claimed_by, stored.attempt_executor); assert.equal(stored.claimed_instance, stored.attempt_instance);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=? AND type='claimed'").get(task.id)!.n, 1);
  }
});
test('barrier: finish versus cancel with the same version yields one committed outcome', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-cas-')), path = join(root, 'bridge.db');
  const f = fixture(path); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const task = f.running();
  const results = await race(path, task.id, task.version, [{operation:'finish',principal:'fixture:pi',instance:'worker-a'}, {operation:'cancel',principal:'fixture:pi',instance:'worker-a'}]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(f.store.getTask(task.id)!.version, 2);
  assert.ok(['WAITING_APPROVAL','CANCELLED'].includes(f.store.getTask(task.id)!.status));
});
test('SQLite lock conflict rolls back and retry is possible after release', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-lock-')), path = join(root, 'bridge.db');
  const f = fixture(path); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const task = f.create(); f.db.exec('BEGIN IMMEDIATE');
  try {
    const [result] = await race(path, task.id, task.version, [{principal:'fixture:pi',instance:'worker-a',timeout:50}]);
    assert.equal(result.ok, false); assert.equal(f.store.getTask(task.id)!.status, 'QUEUED');
  } finally { f.db.exec('ROLLBACK'); }
  assert.ok(f.store.claim(task.id, f.worker, 600, task.version).ok);
});
