import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readCodexState,syncCodexToBridge} from '../src/codex.ts';
import {importChatgptExport} from '../src/chatgpt.ts';
import {fixture} from './helpers.ts';
test('providers: malformed nested Codex metadata fails closed without echoing content',t=>{
 const directory=mkdtempSync(join(tmpdir(),'acb-provider-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const file=join(directory,'state.json');
 for(const input of [{'selected-project':{projectId:1}},{'local-projects':[]},{'local-projects':{p:{id:'p',name:'test',rootPaths:1}}},{'thread-project-assignments':{t:{projectId:1}}},{'thread-workspace-root-hints':{t:1}}]) {
  writeFileSync(file,JSON.stringify(input));assert.ok('error' in readCodexState(file));
 }
 writeFileSync(file,JSON.stringify({'local-projects':{p:{id:'p',name:'test',rootPaths:['project']}},'thread-project-assignments':{t:{projectId:'p'}}}));assert.ok(!('error' in readCodexState(file)));
});
test('providers: cross-source identities coexist, sync preserves legacy task foreign keys and creation/observation times',t=>{
 const f=fixture();t.after(()=>f.db.close());const directory=mkdtempSync(join(tmpdir(),'acb-provider-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 f.db.exec("INSERT INTO sessions(id,external_id,source,title,state) VALUES('legacy-codex','same','codex','old','unknown');INSERT INTO sessions(id,external_id,source,title,state) VALUES('legacy-gpt','same','chatgpt','old','archived')");
 const task=f.store.createTask({sessionId:'legacy-codex',kind:'test',title:'linked'},f.worker);
 syncCodexToBridge(f.db,{projects:[],threads:[{id:'same',projectId:null,workspace:null}],selectedProjectId:null,projectOrder:[]});
 const input=join(directory,'export.JSON');writeFileSync(input,JSON.stringify([{conversation_id:'same',title:'test',create_time:100,mapping:{}}]));const result=importChatgptExport(f.db,input,join(directory,'new.md'));assert.ok(!('error' in result));
 assert.equal(f.store.getTask(task.id)!.session_id,'legacy-codex');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n,2);
 const row=f.db.prepare("SELECT * FROM sessions WHERE id='legacy-gpt'").get()!;assert.equal(row.source_created_at,new Date(100000).toISOString());assert.ok(String(row.last_observed_at)>String(row.source_created_at));
});
test('recovery: expired task stays uncompleted until independent recovery, retry clears prior ownership',t=>{
 const f=fixture();t.after(()=>f.db.close());const task=f.running();f.db.prepare("UPDATE tasks SET claim_expires_at='2000-01-01' WHERE id=?").run(task.id);
 assert.equal(f.store.recover(task.id,f.worker,'offline',task.version).ok,false);const recovered=f.store.recover(task.id,f.reviewer,'confirmed offline',task.version);assert.ok(recovered.ok);
 const retry=f.store.transition(task.id,'QUEUED',f.reviewer,recovered.task.version);assert.ok(retry.ok);assert.equal(retry.task.attempt_executor,null);assert.equal(retry.task.claimed_instance,null);assert.equal(retry.task.error,null);assert.equal(f.store.claim(task.id,f.worker,600,retry.task.version).ok,true);
});
