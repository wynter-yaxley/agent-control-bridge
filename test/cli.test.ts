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
test('CLI contract: required title, canonical aliases, per-command help, and structured errors',async()=>{
 for(const args of [['task-create'],['task-create','-t','one','--title','two'],['task-create','--invalid']]) {
  let out='',err='';assert.equal(runCli(args,{stdout:s=>out+=s,stderr:s=>err+=s}),2);assert.equal(out,'');assert.equal(JSON.parse(err).code,'INPUT');
 }
 const commands=['project-register','help','init','migrate','schema-version','config-show','demo','watch','task-create','task-claim','task-progress','task-finish','task-renew','task-verify','task-cancel','task-resume','task-requeue','task-recover','task-list','task-show','approval-request','approval-decide','mapping-register','mapping-show','projects','status','audit','sweep','codex-status','codex-sync','codex-limits','pi-status','hermes-status','chatgpt-status','chatgpt-import','markdown-import','codex-fork-request'];
 for(const command of commands) {
  let out='',err='';
  if(command==='demo' || command==='watch') {
   const {spawnSync}=await import('node:child_process');
   const result=spawnSync(process.execPath,['src/cli.ts',command,'--help'],{encoding:'utf8',windowsHide:true});
   assert.equal(result.status,0);out=result.stdout;err=result.stderr;
  }else assert.equal(runCli([command,'--help'],{stdout:value=>out+=value,stderr:value=>err+=value}),0);
  assert.ok(out.trim());assert.equal(err,'');
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

test('CLI main entry works through a filesystem alias and never silently succeeds',async t=>{
 const {mkdtempSync,cpSync,symlinkSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {fileURLToPath}=await import('node:url');const {spawnSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'acb-cli-alias-')),real=join(root,'real'),alias=join(root,'alias');
 cpSync(fileURLToPath(new URL('../src',import.meta.url)),join(real,'src'),{recursive:true});
 symlinkSync(real,alias,process.platform==='win32'?'junction':'dir');
 t.after(()=>{rmSync(alias,{force:true});rmSync(root,{recursive:true,force:true});});
 const result=spawnSync(process.execPath,[join(alias,'src','cli.ts'),'help'],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Agent Control Bridge CLI/);assert.equal(result.stderr,'');
});

test('CLI init refuses legacy business schema; only explicit migrate can upgrade',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,mkdirSync,readFileSync,rmSync,cpSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'acb-init-legacy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'data'));
 const path=join(root,'data','legacy.db'),legacy=new DatabaseSync(path);legacy.exec(readFileSync(new URL('./fixtures/schema-v0.sql',import.meta.url),'utf8'));legacy.prepare("INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('kept','test','kept','QUEUED','2000-01-01','2000-01-01')").run();legacy.close();
 // Test the CLI from an isolated installation, without the developer's live caller policy.
 cpSync(new URL('../src',import.meta.url),join(root,'src'),{recursive:true});cpSync(new URL('../package.json',import.meta.url),join(root,'package.json'));
 const {controlledProcessEnv}=await import('../src/silent-process.ts');
 const before=readFileSync(path);const result=spawnSync(process.execPath,[join(root,'src','cli.ts'),'init','--db',path],{cwd:root,env:controlledProcessEnv(),encoding:'utf8',timeout:30000,windowsHide:true});
 assert.equal(result.status,5,result.stderr);assert.equal(result.stdout,'');assert.match(result.stderr,/SCHEMA/);assert.deepEqual(readFileSync(path),before);
 const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(check.prepare('SELECT id FROM tasks').get()!.id,'kept');}finally{check.close();}
});
