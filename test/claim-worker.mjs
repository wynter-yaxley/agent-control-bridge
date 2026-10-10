import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { CallerAuthority } from '../src/caller.ts';
import { TaskStore } from '../src/tasks.ts';
const db = new DatabaseSync(workerData.path);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${workerData.timeout ?? 5000};`);
const authority = new CallerAuthority();
const context = authority.issue({ principal: workerData.principal, instance: workerData.instance, executor: 'pi', reviewer: false });
const store = new TaskStore(db, authority);
const barrier = new Int32Array(workerData.barrier);
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0, 10_000);
try {
  const result = workerData.operation === 'finish' ? store.executorFinished(workerData.id, context, undefined, workerData.version)
    : workerData.operation === 'cancel' ? store.cancel(workerData.id, context, undefined, workerData.version)
    : store.claim(workerData.id, context, 600, workerData.version);
  db.close(); parentPort.postMessage({ result });
} catch { db.close(); parentPort.postMessage({ result: { ok: false, code: 'IO' } }); }
