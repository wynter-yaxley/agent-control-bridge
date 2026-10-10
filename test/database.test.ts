import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDb, transaction } from '../src/db.ts';
import { fixture } from './helpers.ts';

function temporary(t: {after:(fn:()=>void)=>void}) { const root=mkdtempSync(join(tmpdir(),'bridge-db-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
test('v0 migration preserves original task data, adds fencing, and legacy ownership fails closed', t => {
  const root=temporary(t), path=join(root,'legacy.db'), legacy=new DatabaseSync(path);
  legacy.exec(readFileSync(new URL('./fixtures/schema-v0.sql',import.meta.url),'utf8'));
  legacy.prepare("INSERT INTO tasks(id,kind,title,status,executor,claimed_by,created_at,updated_at) VALUES('legacy','fixture','fixture','RUNNING','pi','pi',?,?)").run('2000-01-01','2000-01-01');
  const before=legacy.prepare('SELECT * FROM tasks').get()!; legacy.close();
  const f=fixture(path); let closed=false; t.after(()=>{if(!closed)f.db.close();}); const after=f.db.prepare('SELECT * FROM tasks').get()!;
  for (const [key,value] of Object.entries(before)) assert.equal(after[key],value,key);
  assert.equal(after.version,0); assert.equal(after.attempt,0); assert.equal(after.attempt_executor,null);
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version,2);
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
  const rules=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',stdio:['ignore','pipe','pipe']})) as {sid:string;rights:number;kind:string}[];
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
 writeFileSync(script,`import {createDb} from ${JSON.stringify(new URL('../src/db.ts',import.meta.url).href)};const db=createDb({dbPath:process.argv[2]});try{console.log(JSON.stringify({schema:db.prepare('PRAGMA user_version').get().user_version,extraEnvironmentAbsent:process.env[process.argv[3]]===undefined}));}finally{db.close();}`);
 const result=await silentProcess('isolated-acl',process.execPath,[script,path,key],{timeoutMs:30000});
 assert.ok(result.ok,result.summary);assert.deepEqual(JSON.parse(result.stdout!),{schema:2,extraEnvironmentAbsent:true});
});
