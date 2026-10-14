import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDb, transaction } from '../src/db.ts';
import { WINDOWS_POWERSHELL } from '../src/permissions.ts';
import { fixture } from './helpers.ts';

function temporary(t: {after:(fn:()=>void)=>void}) { const root=mkdtempSync(join(tmpdir(),'bridge-db-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
test('v3 notifications are preserved by an explicit v5 migration',t=>{
 const root=temporary(t),path=join(root,'v3.db');let db=createDb({dbPath:path});
 db.exec("INSERT INTO notification_outbox(id,dedupe_key,principal,payload,state,created_at) VALUES('kept-notice','kept-key','fixture:controller','{}','PENDING','2000-01-01'); DROP TABLE notification_delivery; DROP INDEX one_live_gui; ALTER TABLE background_requests DROP COLUMN owner_token; ALTER TABLE background_requests DROP COLUMN gui; ALTER TABLE background_requests DROP COLUMN codex_conversation_id; ALTER TABLE execution_runs DROP COLUMN owner_token; ALTER TABLE execution_runs DROP COLUMN feedback_owner_token; ALTER TABLE project_operations DROP COLUMN owner_token; ALTER TABLE project_operations DROP COLUMN phase; ALTER TABLE conversation_workspaces DROP COLUMN default_codex_conversation_id; CREATE UNIQUE INDEX one_active_background ON background_requests((1)) WHERE state IN ('GENERATING','RUNNING','UNCERTAIN'); ALTER TABLE execution_runs DROP COLUMN result_json; ALTER TABLE execution_runs DROP COLUMN feedback_state; ALTER TABLE execution_runs DROP COLUMN feedback_json; ALTER TABLE execution_runs DROP COLUMN feedback_error; PRAGMA user_version=3;");db.close();
 const before=readFileSync(path);assert.throws(()=>createDb({dbPath:path}),/explicitly/);assert.deepEqual(readFileSync(path),before);
 db=createDb({dbPath:path,allowMigrations:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,6);assert.equal(db.prepare('SELECT state FROM notification_outbox WHERE id=?').get('kept-notice')!.state,'PENDING');assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_delivery').get()!.n,0);assert.ok(db.prepare('PRAGMA table_info(execution_runs)').all().some(column=>column.name==='result_json'));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
});
// Builds an isolated v2-layout ledger with one project, mapping and task; never a business database.
function legacyV2(path: string) {
 const db=createDb({dbPath:path});
 try{
  db.exec("INSERT INTO projects(id,name,root_path,kind,created_at,updated_at) VALUES('kept-project','Kept project','fixture-root','fixture','2000-01-01','2000-01-01'); INSERT INTO conversation_workspaces(project_id,workspace_path,workspace_key,chatgpt_conversation_id,chatgpt_conversation_name,registered_at) VALUES('kept-project','fixture-root','fixture-root','kept-gpt','Kept project','2000-01-01'); INSERT INTO codex_conversations(conversation_id,project_id) VALUES('kept-codex','kept-project'); INSERT INTO tasks(id,kind,title,status,project_id,created_at,updated_at) VALUES('kept-task','fixture','Kept task','QUEUED','kept-project','2000-01-01','2000-01-01');");
  db.exec('PRAGMA foreign_keys=OFF; ALTER TABLE tasks DROP COLUMN execution_prompt_id; ALTER TABLE conversation_workspaces DROP COLUMN app_project_id; ALTER TABLE watcher_notifications DROP COLUMN delivered_at;');
  for(const table of ['notification_delivery','execution_events','execution_runs','background_requests','prompt_dispatches','prompt_generation_ops','project_access','project_operations','notification_outbox'])db.exec(`DROP TABLE ${table}`);
  db.exec('ALTER TABLE conversation_workspaces DROP COLUMN default_codex_conversation_id; PRAGMA user_version=2');
 }finally{db.close();}
}
test('v2 to current requires explicit migration and preserves existing project, mapping and task data',t=>{
 const root=temporary(t),path=join(root,'v2.db');let db;legacyV2(path);
 const before=readFileSync(path);assert.throws(()=>createDb({dbPath:path}),/explicitly/);assert.deepEqual(readFileSync(path),before);
 db=createDb({dbPath:path,allowMigrations:true});
 try{
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,6);
  const task=db.prepare('SELECT * FROM tasks WHERE id=?').get('kept-task')!;
  assert.equal(task.title,'Kept task');assert.equal(task.project_id,'kept-project');assert.equal(task.status,'QUEUED');assert.equal(task.execution_prompt_id,null);
  const mapping=db.prepare('SELECT * FROM conversation_workspaces').get()!;assert.equal(mapping.chatgpt_conversation_id,'kept-gpt');assert.equal(mapping.app_project_id,null);
  assert.equal(db.prepare('SELECT conversation_id FROM codex_conversations').get()!.conversation_id,'kept-codex');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_access').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
test('v0 migration preserves original task data, adds fencing, and legacy ownership fails closed', t => {
  const root=temporary(t), path=join(root,'legacy.db'), legacy=new DatabaseSync(path);
  legacy.exec(readFileSync(new URL('./fixtures/schema-v0.sql',import.meta.url),'utf8'));
  legacy.prepare("INSERT INTO tasks(id,kind,title,status,executor,claimed_by,created_at,updated_at) VALUES('legacy','fixture','fixture','RUNNING','pi','pi',?,?)").run('2000-01-01','2000-01-01');
  const before=legacy.prepare('SELECT * FROM tasks').get()!; legacy.close();
  const f=fixture(path); let closed=false; t.after(()=>{if(!closed)f.db.close();}); const after=f.db.prepare('SELECT * FROM tasks').get()!;
  for (const [key,value] of Object.entries(before)) assert.equal(after[key],value,key);
  assert.equal(after.version,0); assert.equal(after.attempt,0); assert.equal(after.attempt_executor,null);
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version,6);
  assert.equal(f.store.executorFinished('legacy',f.worker,undefined,0).ok,false);
  assert.equal(f.store.cancel('legacy',f.worker,undefined,0).ok,false);
  f.db.close(); closed=true; const reopened=createDb({dbPath:path}); assert.equal(reopened.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,1); reopened.close();
});
test('schema initialization failure rolls back DDL and closes the connection', t => {
  const root=temporary(t), path=join(root,'failed.db'), schema=join(root,'invalid.sql');
  writeFileSync(schema,'CREATE TABLE synthetic(id INTEGER); INSERT INTO missing_table VALUES(1);');
  assert.throws(()=>createDb({dbPath:path,schemaPath:schema}));
  const db=new DatabaseSync(path); assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='synthetic'").get()!.n,0); db.close();
});
test('newer schema is rejected without changing it', t => {
  const root=temporary(t), path=join(root,'future.db'), original=new DatabaseSync(path); original.exec('PRAGMA user_version=999'); original.close();
  assert.throws(()=>createDb({dbPath:path}),/newer/);
  const db=new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,999); db.close();
});
test('nested transactions roll back their caller when a later operation fails', t => {
  const db=createDb({dbPath:':memory:'}); t.after(()=>db.close());
  assert.throws(()=>transaction(db,()=>{transaction(db,()=>db.exec("INSERT INTO audit_log(at,actor,action) VALUES('fixture','fixture','first')")); throw new Error('fixture');}));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get()!.n,0); assert.equal(db.isTransaction,false);
});
test('database and WAL/SHM ACL contain only authorized principals', {skip:process.platform!=='win32'}, t => {
  const root=temporary(t), path=join(root,'bridge.db'), db=createDb({dbPath:path});
  try {
  db.exec('CREATE TABLE acl_fixture(id INTEGER); INSERT INTO acl_fixture VALUES(1);');
  const paths=[root,path,`${path}-wal`,`${path}-shm`].filter(existsSync);
  const payload=Buffer.from(JSON.stringify(paths)).toString('base64');
  const command=`$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $result=@(); foreach($p in $paths){$i=Get-Item -LiteralPath $p; $a=$i.GetAccessControl(); foreach($r in $a.Access){$result += [pscustomobject]@{sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;rights=[int]$r.FileSystemRights;kind=$r.AccessControlType.ToString()}}}; ConvertTo-Json -InputObject $result -Compress`;
  const rules=JSON.parse(execFileSync(WINDOWS_POWERSHELL,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']})) as {sid:string;rights:number;kind:string}[];
  assert.ok(rules.length>=paths.length*3);
  for(const rule of rules){assert.equal(rule.kind,'Allow');assert.ok(!['S-1-1-0','S-1-5-11','S-1-5-32-545'].includes(rule.sid));}
  assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,5000);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);
  } finally { db.close(); }
});
test('broad authorization SID fails closed before database creation', {skip:process.platform!=='win32'}, t => {
  const root=temporary(t), path=join(root,'not-created.db');
  assert.throws(()=>createDb({dbPath:path,authorizedSids:['S-1-5-11']}),/ACL/); assert.equal(existsSync(path),false);
});

for(const version of [0,2])test(`foreign or incomplete schema ${version} is refused without changing data`,t=>{
 const root=temporary(t),path=join(root,'foreign.db'),original=new DatabaseSync(path);
 original.exec(`CREATE TABLE unrelated(id INTEGER); INSERT INTO unrelated VALUES(17); PRAGMA user_version=${version}`);original.close();
 const before=readFileSync(path);assert.throws(()=>createDb({dbPath:path,allowMigrations:true}),/structure/);assert.deepEqual(readFileSync(path),before);
 const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('SELECT id FROM unrelated').get()!.id,17);}finally{check.close();}
});

test('isolated subprocess retains OS ACL runtime while excluding arbitrary environment data',async t=>{
 const {silentProcess}=await import('../src/silent-process.ts');const {randomUUID}=await import('node:crypto');
 const root=temporary(t),path=join(root,'isolated.db'),script=join(root,'probe.mjs'),key='ACB_TEST_ONLY_'+randomUUID().replaceAll('-','');
 process.env[key]='synthetic-only';t.after(()=>{delete process.env[key];});
 writeFileSync(script,`import {createDb} from ${JSON.stringify(new URL('../src/db.ts',import.meta.url).href)};try{const db=createDb({dbPath:process.argv[2]});try{console.log(JSON.stringify({schema:db.prepare('PRAGMA user_version').get().user_version,extraEnvironmentAbsent:process.env[process.argv[3]]===undefined}));}finally{db.close();}}catch(error){console.log(JSON.stringify({aclError:/^Cannot restrict NTFS ACL; database access refused \\(phase=(startup|entered|read|rules|apply|verify|done)\\)$/.test(error.message)?error.message:'Isolated database probe failed'}));}`);
 const result=await silentProcess('isolated-acl',process.execPath,[script,path,key],{timeoutMs:30000});
 assert.ok(result.ok,result.summary);assert.deepEqual(JSON.parse(result.stdout!),{schema:6,extraEnvironmentAbsent:true});
});

test('v2 ledger with uncheckpointed WAL: online backup -> migrated copy -> restore to a new file only',async t=>{
 const root=temporary(t),source=join(root,'data','v2.db'),raw=join(root,'raw','v2.db'),copy=join(root,'backup','v2.db'),restored=join(root,'restore','v2.db');
 const {backupDatabase,restoreDatabase}=await import('../src/db.ts'),{copyFileSync,mkdirSync,statSync}=await import('node:fs');
 legacyV2(source);
 const live=new DatabaseSync(source);
 try{
  // A committed task and Prompt stay only in the WAL while this writer is open.
  live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO tasks(id,kind,title,status,project_id,created_at,updated_at) VALUES('wal-task','fixture','WAL task','QUEUED','kept-project','2000','2000'); INSERT INTO prompts(id,task_id,source,requested_model,requested_reasoning,generated_at,prompt_hash,content,verified,delivery_status,source_conversation_id,codex_conversation_id) VALUES('wal-prompt','wal-task','mock-chatgpt','fixture','fixture','2000','fixture-hash','[TEST] prompt',1,'PENDING','kept-gpt','kept-codex');");
  assert.ok(statSync(source+'-wal').size>0);
  mkdirSync(join(root,'raw'));copyFileSync(source,raw);
  const stale=new DatabaseSync(raw,{readOnly:true});
  try{assert.equal(stale.prepare("SELECT COUNT(*) n FROM tasks WHERE id='wal-task'").get()!.n,0);}finally{stale.close();}
  const before=readFileSync(source);
  await backupDatabase(source,copy);
  assert.deepEqual(readFileSync(source),before);
 }finally{live.close();}
 // Restore is verified from the unmigrated backup into a fresh ledger.
 await restoreDatabase(copy,restored);
 const view=new DatabaseSync(restored,{readOnly:true});
 try{assert.equal(view.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(view.prepare("SELECT COUNT(*) n FROM prompts WHERE id='wal-prompt'").get()!.n,1);}finally{view.close();}
 const migrated=createDb({dbPath:copy,allowMigrations:true});
 try{
  assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version,6);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(migrated.prepare('SELECT id,status FROM tasks ORDER BY id').all().map(row=>({...row})),[{id:'kept-task',status:'QUEUED'},{id:'wal-task',status:'QUEUED'}]);
  assert.equal(migrated.prepare('SELECT content FROM prompts WHERE task_id=?').get('wal-task')!.content,'[TEST] prompt');
  const mapping=migrated.prepare('SELECT * FROM conversation_workspaces').get()!;
  assert.equal(mapping.chatgpt_conversation_id,'kept-gpt');assert.equal(mapping.app_project_id,null);assert.equal(mapping.default_codex_conversation_id,'kept-codex');
  // Structural migration grants no controller access or native project identity.
  assert.equal(migrated.prepare('SELECT COUNT(*) n FROM project_access').get()!.n,0);
 }finally{migrated.close();}
 await assert.rejects(restoreDatabase(copy,restored),{code:'CONFLICT'});await assert.rejects(backupDatabase(copy,source),{code:'CONFLICT'});
});

test('online backup includes WAL and restore refuses an existing ledger',async t=>{
 const root=temporary(t),source=join(root,'data','source.db'),copy=join(root,'backup','copy.db'),restored=join(root,'restore','new.db');
 const db=createDb({dbPath:source});try{db.exec("INSERT INTO projects(id,name,root_path,kind,created_at,updated_at) VALUES('kept','kept','fixture','fixture','2000','2000')");
 const {backupDatabase,restoreDatabase}=await import('../src/db.ts');await backupDatabase(source,copy);await restoreDatabase(copy,restored);
 const view=new DatabaseSync(restored,{readOnly:true});try{assert.equal(view.prepare('SELECT name FROM projects').get()!.name,'kept');}finally{view.close();}
 await assert.rejects(restoreDatabase(copy,source),{code:'CONFLICT'});assert.equal(db.prepare('SELECT name FROM projects').get()!.name,'kept');}finally{db.close();}
});
