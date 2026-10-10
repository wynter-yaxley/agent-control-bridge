import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '../src/db.ts';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('migration: constraints reject direct invalid data and direct success even with ordinary SQL',t=>{
 const db=createDb({dbPath:':memory:'});t.after(()=>db.close());
 assert.throws(()=>db.exec("INSERT INTO projects(id,name,root_path,kind,created_at,updated_at) VALUES(NULL,'fixture','','fixture','','')"));
 assert.throws(()=>db.exec("INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('bad','test','test','INVALID','','')"));
 assert.throws(()=>db.exec("INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('bad','test','test','SUCCEEDED','','')"));
 db.exec("INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('task','test','test','WAITING_APPROVAL','','')");assert.throws(()=>db.exec("UPDATE tasks SET status='SUCCEEDED' WHERE id='task'"));
 assert.throws(()=>db.exec("INSERT INTO alerts(id,task_id,severity,message,created_at) VALUES('x','missing','warn','test','')"));
});
test('migration: existing legacy DB requires explicit upgrade and invalid legacy data rolls back without deletion',t=>{
 const root=mkdtempSync(join(tmpdir(),'acb-migrate-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'legacy.sqlite');
 const db=new DatabaseSync(path);db.exec(readFileSync(new URL('./fixtures/schema-v0.sql',import.meta.url),'utf8'));db.exec("INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('bad','test','test','INVALID','','')");db.close();
 assert.throws(()=>createDb({dbPath:path}),/upgrade/);assert.throws(()=>createDb({dbPath:path,allowMigrations:true}),/Legacy/);
 const after=new DatabaseSync(path,{readOnly:true});assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(after.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,1);after.close();
});
