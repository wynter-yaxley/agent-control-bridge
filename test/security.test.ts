import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { safeText, redact } from '../src/security.ts';
test('security: credentials never reach task titles, event notes, or terminal control bytes',t=>{
 const f=fixture();t.after(()=>f.db.close());assert.throws(()=>f.store.createTask({kind:'test',title:'password='+'synthetic-marker'},f.worker));
 const task=f.running();const finish=f.store.executorFinished(task.id,f.worker,'Authorization: Bearer '+'synthetic-marker',task.version);assert.ok(finish.ok);
 const payload=String(f.db.prepare("SELECT payload FROM events WHERE type='executor_finished'").get()!.payload);assert.equal(payload.includes('synthetic-marker'),false);
 assert.equal(safeText(String.fromCharCode(27)+'[2J').includes(String.fromCharCode(27)),false);
});
test('security: quoted JSON credential fields are redacted without invalid JSON',()=>{
 const raw=JSON.stringify({nested:{password:'synthetic-fixture',api_key:'synthetic-fixture'}});
 const result=JSON.parse(redact(raw));assert.equal(result.nested.password,'[REDACTED]');assert.equal(result.nested.api_key,'[REDACTED]');
});
