import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watcher } from '../src/watcher.ts';
import { fixture } from './helpers.ts';
test('watcher: default/override, invalid interval, durable restart deduplication, no self success',async t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal(new Watcher(f.db).intervalMs,60000);assert.equal(new Watcher(f.db,{intervalMs:12}).intervalMs,12);
 for(const value of [0,-1,1.5])assert.throws(()=>new Watcher(f.db,{intervalMs:value}));
 const task=f.awaiting();const first=await new Watcher(f.db).runOnce();assert.equal(first.length,1);assert.equal(first[0].taskId,task.id);
 assert.equal((await new Watcher(f.db).runOnce()).length,0);assert.equal(f.store.getTask(task.id)!.status,'WAITING_APPROVAL');
 const renewed=f.store.renew(task.id,f.worker,600,task.version);assert.ok(renewed.ok);assert.equal((await new Watcher(f.db).runOnce()).length,0);
});
test('watcher: local finish event is observed without waiting for periodic interval',async t=>{
 const f=fixture();const notices:string[]=[];const watcher=new Watcher(f.db,{onNotification:n=>notices.push(n.status)});
 t.after(()=>{watcher.stop();f.db.close();});watcher.start();await Promise.resolve();const task=f.running();f.store.executorFinished(task.id,f.worker,undefined,task.version);await Promise.resolve();await Promise.resolve();assert.deepEqual(notices,['WAITING_APPROVAL']);
});
test('watcher: simulated clock polls at 60000ms and never overlaps a slow inspection',async t=>{
 const f=fixture(); let count=0, release!:()=>void; const pending=new Promise<void>(r=>release=r);
 t.mock.timers.enable({apis:['setInterval']});const watcher=new Watcher(f.db,{inspect:async()=>{count++;await pending;}});
 watcher.start();t.mock.timers.tick(60000);await Promise.resolve();assert.equal(count,1);watcher.stop();release();await Promise.resolve();await Promise.resolve();f.db.close();
});
test('watcher: cooperative long inspection gets abort; failures do not write notifications',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.awaiting();
 const watcher=new Watcher(f.db,{timeoutMs:5,inspect:signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}))});
 const result=watcher.runOnce();const rejection=assert.rejects(result);await new Promise(r=>setTimeout(r,15));await rejection;
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM watcher_notifications').get()!.n,0);
});
test('watcher: cross-process-style change is detected at the next fallback tick',async t=>{
 const f=fixture();t.mock.timers.enable({apis:['setInterval']});const notices:string[]=[];
 const watcher=new Watcher(f.db,{onNotification:n=>notices.push(n.status)});t.after(()=>{watcher.stop();f.db.close();});watcher.start();await Promise.resolve();
 const task=f.running(); // Direct SQL simulates a separate process that has no local event emitter.
 f.db.prepare("UPDATE tasks SET status='WAITING_APPROVAL',version=version+1 WHERE id=?").run(task.id);
 t.mock.timers.tick(59999);await Promise.resolve();assert.equal(notices.length,0);
 t.mock.timers.tick(1);await Promise.resolve();await Promise.resolve();assert.deepEqual(notices,['WAITING_APPROVAL']);
});
test('watcher: overdue blocked work reports once, survives restart, and never completes the task',async t=>{
 const f=fixture();t.after(()=>f.db.close());const task=f.running();const blocked=f.store.transition(task.id,'BLOCKED',f.worker,task.version);assert.ok(blocked.ok);
 f.db.prepare("UPDATE events SET observed_at='2000-01-01' WHERE task_id=? AND type='status:RUNNING->BLOCKED'").run(task.id);
 const renewed=f.store.renew(task.id,f.worker,600,blocked.task.version);assert.ok(renewed.ok);
 const watcher=new Watcher(f.db);assert.equal(watcher.blockedAfterMs,600000);const notices=await watcher.runOnce();assert.equal(notices.length,1);assert.equal(notices[0].status,'BLOCKED');
 assert.equal((await new Watcher(f.db).runOnce()).length,0);assert.equal(f.store.getTask(task.id)!.status,'BLOCKED');
 const next=f.store.resume(task.id,f.worker,renewed.task.version);assert.ok(next.ok);assert.ok(f.store.transition(task.id,'BLOCKED',f.worker,next.task.version).ok);
 assert.equal((await watcher.runOnce()).length,0);f.db.prepare("UPDATE events SET observed_at='2000-01-01' WHERE id=(SELECT MAX(id) FROM events WHERE task_id=? AND type='status:RUNNING->BLOCKED')").run(task.id);assert.equal((await watcher.runOnce()).length,1);
});
