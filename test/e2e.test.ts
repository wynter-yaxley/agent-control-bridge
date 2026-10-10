import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TaskStore } from '../src/tasks.ts';
import { CallerAuthority } from '../src/caller.ts';

function isolated(t: {after:(fn:()=>void)=>void}) {
  const root=mkdtempSync(join(tmpdir(),'bridge-e2e path-'));
  cpSync(fileURLToPath(new URL('../src',import.meta.url)),join(root,'src'),{recursive:true});
  cpSync(fileURLToPath(new URL('../package.json',import.meta.url)),join(root,'package.json'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cli=(...args:string[])=>spawnSync(process.execPath,['--experimental-strip-types',join(root,'src','cli.ts'),...args],{encoding:'utf8',timeout:20000,cwd:root});
  return {root,cli};
}
test('e2e: actual CLI lifecycle, spoof denial, stale owner denial and independent host acceptance (synthetic only)',{timeout:60000},t=>{
  const {root,cli}=isolated(t);
  const init=cli('init');assert.equal(init.status,0,init.stderr);
  const created=cli('task-create','-t','Synthetic e2e task','-k','test','-e','pi');assert.equal(created.status,0,created.stderr);
  const task=JSON.parse(created.stdout);
  const claimed=cli('task-claim',task.id,'--version','0','-e','pi');assert.equal(claimed.status,0,claimed.stderr);
  const running=JSON.parse(claimed.stdout).task;assert.equal(running.version,1);assert.equal(running.status,'RUNNING');
  const duplicate=cli('task-claim',task.id,'--version','0');assert.equal(duplicate.status,4);assert.equal(duplicate.stdout,'');
  const wrongExecutor=cli('task-finish',task.id,'--version','1','-e','codex');assert.equal(wrongExecutor.status,3);
  const finished=cli('task-finish',task.id,'--version','1','-e','pi');assert.equal(finished.status,0,finished.stderr);
  const awaiting=JSON.parse(finished.stdout).task;assert.equal(awaiting.status,'WAITING_APPROVAL');
  const spoof=cli('task-verify',task.id,'--version','2','--pass','--by','user');assert.equal(spoof.status,3);assert.equal(spoof.stdout,'');assert.match(spoof.stderr,/AUTH/);
  const noLabel=cli('task-verify',task.id,'--version','2','--pass');assert.equal(noLabel.status,3);assert.match(noLabel.stderr,/reviewer/);
  const both=cli('task-verify',task.id,'--version','2','--pass','--fail');assert.equal(both.status,2);assert.equal(both.stdout,'');
  const show=cli('task-show',task.id);assert.equal(show.status,0,show.stderr);assert.equal(JSON.parse(show.stdout).task.status,'WAITING_APPROVAL');
  // Synthetic host capability simulates the separate authorized reviewer.
  const db=new DatabaseSync(join(root,'data','bridge.db'));
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const authority=new CallerAuthority(), store=new TaskStore(db,authority);
    const context=authority.issue({principal:'fixture:independent-reviewer',instance:'fixture-reviewer',executor:'hermes',reviewer:true});
    const accepted=store.verify(task.id,context,true,'synthetic test only',2);assert.ok(accepted.ok);assert.equal(accepted.task.status,'SUCCEEDED');
    const audit=db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='task_verify_pass'").get()!;assert.equal(audit.n,1);
  } finally {db.close();}
});
test('e2e: export CLI overwrite negatives preserve input/output hashes and emit nonzero stderr',{timeout:60000},t=>{
  const {root,cli}=isolated(t),input=join(root,'fixture.JSON'),output=join(root,'fixture.conversations.md');
  writeFileSync(input,JSON.stringify([{conversation_id:'fixture',title:'Synthetic export'}]));
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');const original=hash(input);
  const same=cli('chatgpt-import',input,'--output',input);assert.equal(same.status,1);assert.equal(same.stdout,'');assert.equal(hash(input),original);
  const imported=cli('chatgpt-import',input);assert.equal(imported.status,0,imported.stderr);const saved=hash(output);
  const overwrite=cli('chatgpt-import',input);assert.equal(overwrite.status,1);assert.equal(overwrite.stdout,'');assert.match(overwrite.stderr,/overwrite/);
  assert.equal(hash(input),original);assert.equal(hash(output),saved);
});
