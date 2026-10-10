import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.ts';
import { fixture, snapshot } from './helpers.ts';
test('help and invalid command/parameters never open a database', () => {
  for(const args of [[],['help'],['nonsense'],['task-claim'],['task-list','--status','INVALID'],['task-create','-e','INVALID']]) {
    let out='',err='';const code=runCli(args,{stdout:s=>out+=s,stderr:s=>err+=s});
    if(!args.length||args[0]==='help'){assert.equal(code,0);assert.match(out,/Agent Control Bridge/);assert.equal(err,'');}
    else {assert.equal(code,2);assert.equal(out,'');assert.match(err,/INPUT/);}
  }
});
for(const flags of [[],['--pass','--fail'],['--pass','--pass'],['--pass','--unknown']]) test(`review decision flags ${JSON.stringify(flags)} reject before mutation`, t => {
  const f=fixture();t.after(()=>f.db.close());const task=f.awaiting(),before=snapshot(f.db);let out='',err='';
  assert.equal(runCli(['task-verify',task.id,'--version',String(task.version),...flags],{db:f.db,authority:f.authority,context:f.reviewer,stdout:s=>out+=s,stderr:s=>err+=s}),2);
  assert.equal(out,'');assert.match(err,/INPUT/);assert.equal(snapshot(f.db),before);
});
test('pi --by user cannot impersonate reviewer; failure uses stderr/nonzero', t => {
  const f=fixture();t.after(()=>f.db.close());const task=f.awaiting(),before=snapshot(f.db);let out='',err='';
  const code=runCli(['task-verify',task.id,'--version',String(task.version),'--pass','--by','user'],{db:f.db,authority:f.authority,context:f.worker,stdout:s=>out+=s,stderr:s=>err+=s});
  assert.equal(code,3);assert.equal(out,'');assert.match(err,/AUTH/);assert.equal(snapshot(f.db),before);
});
test('missing task is nonzero; aliases -k/-t/-e parse correctly; independent host review works', t => {
  const f=fixture();t.after(()=>f.db.close());let out='',err='';
  const deps={db:f.db,authority:f.authority,context:f.worker,stdout:(s:string)=>out+=s,stderr:(s:string)=>err+=s};
  assert.equal(runCli(['task-show','missing'],deps),4);assert.match(err,/NOT_FOUND/);out='';err='';
  assert.equal(runCli(['task-create','-t','synthetic','-k','review','-e','pi'],deps),0);
  const created=JSON.parse(out);assert.equal(created.kind,'review');
  const task=f.awaiting();out='';
  assert.equal(runCli(['task-verify',task.id,'--version',String(task.version),'--pass'],{...deps,context:f.reviewer}),0);
  assert.equal(f.store.getTask(task.id)!.status,'SUCCEEDED');
});
