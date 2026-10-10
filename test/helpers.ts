import { createDb } from '../src/db.ts';
import { CallerAuthority } from '../src/caller.ts';
import { TaskStore } from '../src/tasks.ts';
export function fixture(path = ':memory:') {
  const db = createDb({ dbPath: path });
  const authority = new CallerAuthority();
  const worker = authority.issue({ principal: 'fixture:pi', instance: 'worker-a', executor: 'pi', reviewer: false });
  const other = authority.issue({ principal: 'fixture:codex', instance: 'worker-b', executor: 'codex', reviewer: false });
  const sibling = authority.issue({ principal: 'fixture:pi', instance: 'worker-other', executor: 'pi', reviewer: false });
  const reviewer = authority.issue({ principal: 'fixture:hermes', instance: 'reviewer-a', executor: 'hermes', reviewer: true });
  const store = new TaskStore(db, authority);
  const create = () => store.createTask({ kind: 'test', title: 'synthetic fixture', executor: 'pi' }, worker);
  const running = () => { const task = create(); const result = store.claim(task.id, worker, 600, task.version); if (!result.ok) throw new Error(result.error); return result.task; };
  const awaiting = () => { const task = running(); const result = store.executorFinished(task.id, worker, undefined, task.version); if (!result.ok) throw new Error(result.error); return result.task; };
  return { db, authority, worker, other, sibling, reviewer, store, create, running, awaiting };
}
export function snapshot(db: ReturnType<typeof createDb>): string {
  return JSON.stringify(['tasks','events','audit_log','approvals','alerts','sessions','deliverables'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
