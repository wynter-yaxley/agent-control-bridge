import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { ProjectProvisioner, type ProjectHost } from '../src/project-provisioner.ts';
import { assertOrdinaryChatCapabilities } from '../src/ordinary-chat.ts';
import {BridgeError} from '../src/errors.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const scope = isolatedDemo(), root = mkdtempSync(join(tmpdir(), 'acb-project-fixture-'));
  t.after(() => { scope.close(); rmSync(root, { recursive: true, force: true }); });
  const authority = new CallerAuthority(), context = authority.issue({ principal: 'fixture:controller', instance: 'one', executor: 'hermes', controller: true, reviewer: false });
  let creates = 0;
  const host: ProjectHost = {
    authorizeInitialization:async()=>{},
    inspect: async () => ({ source: 'application-host', ordinaryChat: true, background: true, exactConversation: true, completeMessages: true, actualGenerationParameters: true, createOrdinaryChat: true, createWorkspace: true, workspaceSurface: 'native-desktop', models: ['fixture'], reasoningEfforts: ['fixture'] }),
    createWorkspace: async (_name, workspacePath) => { creates++; return { appProjectId: 'native-project-fixture', workspacePath }; },
    createOrdinaryChat: async () => ({ conversationId: 'fixture-gpt' }),
    createCodexConversation: async () => ({ conversationId: 'fixture-codex' }),
    verifyBundle: async resources => ({ ...resources, source: 'application-host', workspaceSurface: 'native-desktop', codexNativeProjectId: resources.appProjectId, kind: 'ordinary-chat' }),
  };
  return { db: scope.db, root, authority, context, host, creates: () => creates };
}
test('project provisioning: missing host records BLOCKED without creating files or registry identities', async t => {
  const f = fixture(t), project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100 });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  assert.equal(first.state, 'BLOCKED'); assert.equal((await project.prepare('fixture-project', 'fixture-event', f.context)).id, first.id);
  assert.equal(existsSync(join(f.root, 'workspaces')), false); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get()!.n, 0);
  await assert.rejects(() => project.prepare('../escape', 'fixture-escape', f.context), /name/);
});
test('project provisioning: READY requires complete native readback; request retry keeps original identities', async t => {
  const f = fixture(t), project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  assert.equal(first.state, 'READY'); assert.equal(existsSync(first.workspacePath), true);
  assert.equal((await project.prepare('fixture-project', 'fixture-event', f.context)).projectId, first.projectId); assert.equal(f.creates(), 1);
  const mapping = f.db.prepare('SELECT * FROM conversation_workspaces WHERE project_id=?').get(first.projectId)!;
  assert.equal(mapping.app_project_id, 'native-project-fixture'); assert.equal(mapping.chatgpt_conversation_name, 'fixture-project');
});
test('project provisioning: partial host failure keeps resources and never blindly recreates', async t => {
  const f = fixture(t); f.host.createOrdinaryChat = async () => { throw new Error('fixture disconnect'); };
  const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  assert.equal(first.state, 'UNCERTAIN'); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get()!.n, 0);
  assert.match(String(f.db.prepare('SELECT resources FROM project_operations WHERE id=?').get(first.id)!.resources), /native-project-fixture/);
  await project.prepare('fixture-project', 'fixture-event', f.context); assert.equal(f.creates(), 1);
  assert.equal((await project.prepare('another-project','another-event',f.context)).state,'UNCERTAIN');assert.equal(f.creates(),2);
});

test('project provisioning: two calls cannot mutate the shared host concurrently', async t => {
  const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  f.host.inspect=async()=>{await gate;return {source:'application-host',ordinaryChat:true,background:true,exactConversation:true,completeMessages:true,actualGenerationParameters:true,createOrdinaryChat:true,createWorkspace:true,workspaceSurface:'native-desktop',models:['fixture'],reasoningEfforts:['fixture']};};
  const project=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:1000,host:f.host});
  const first=project.prepare('first-project','first-event',f.context);
  await assert.rejects(()=>project.prepare('second-project','second-event',f.context),/GUI/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_operations').get()!.n,1);
  release();assert.equal((await first).state,'READY');assert.equal(f.creates(),1);
});

test('project provisioning: identity setup can precede GPT model evidence, but generation stays blocked', async t => {
  const f = fixture(t), capabilities = { ...(await f.host.inspect(new AbortController().signal)), background: false, actualGenerationParameters: false, completeMessages: false, models: [], reasoningEfforts: [] };
  f.host.inspect = async () => capabilities;
  const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
  assert.equal((await project.prepare('fixture-project', 'fixture-event', f.context)).state, 'READY');
  assert.throws(() => assertOrdinaryChatCapabilities(capabilities), { code: 'UNSUPPORTED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM execution_runs').get()!.n, 0);
});

for (const change of [{ source: 'unknown' }, { ordinaryChat: false }, { exactConversation: false }, { createOrdinaryChat: false }, { createWorkspace: false }, { ordinaryChat: 'true' }, { workspaceSurface: 'isolated-app-server' }, { workspaceSurface: 'unknown' }, { workspaceSurface: undefined }]) {
  test(`project provisioning: missing trusted creation capability ${JSON.stringify(change)} creates no resources`, async t => {
    const f = fixture(t), capabilities = await f.host.inspect(new AbortController().signal);
    f.host.inspect = async () => ({ ...capabilities, ...change }) as typeof capabilities;
    const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
    const operation = await project.prepare('fixture-project', 'fixture-event', f.context);
    assert.equal(operation.state, 'BLOCKED'); assert.equal(operation.errorCode, 'UNSUPPORTED'); assert.equal(f.creates(), 0);
    assert.equal(existsSync(join(f.root, 'workspaces')), false);
  });
}

for (const change of [{ name: 'wrong-name' }, { chatgptConversationId: 'foreign-gpt' }, { codexConversationId: 'foreign-codex' }, { appProjectId: 'foreign-workspace' }, { kind: 'work' }, { workspaceSurface: 'isolated-app-server' }, { workspaceSurface: undefined }, { codexNativeProjectId: 'foreign-project' }, { codexNativeProjectId: undefined }]) {
  test(`project provisioning: wrong bundle readback ${JSON.stringify(change)} never registers a usable mapping`, async t => {
    const f = fixture(t); f.host.verifyBundle = async resources => ({ ...resources, source: 'application-host', workspaceSurface: 'native-desktop', codexNativeProjectId: resources.appProjectId, kind: 'ordinary-chat', ...change }) as Awaited<ReturnType<ProjectHost['verifyBundle']>>;
    const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
    const first = await project.prepare('fixture-project', 'fixture-event', f.context);
    assert.equal(first.state, 'UNCERTAIN'); assert.equal(first.errorCode, 'PROVENANCE');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_conversations').get()!.n, 0);
    assert.equal((await project.prepare('fixture-project', 'fixture-event', f.context)).id, first.id); assert.equal(f.creates(), 1);
  });
}

test('project reconciliation: verifies only the recorded complete bundle without replacement creation', async t => {
  const f = fixture(t), readback = f.host.verifyBundle;
  f.host.verifyBundle = async () => { throw new Error('fixture lost readback'); };
  const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  assert.equal(first.state, 'UNCERTAIN'); assert.equal(f.creates(), 1);
  f.host.createWorkspace = async () => { assert.fail('Reconciliation must never create'); };
  f.host.createOrdinaryChat = async () => { assert.fail('Reconciliation must never create'); };
  f.host.createCodexConversation = async () => { assert.fail('Reconciliation must never create'); };
  f.host.verifyBundle = readback;
  const ready = await project.reconcile(first.id, f.context);
  assert.equal(ready.state, 'READY'); assert.equal(ready.projectId, first.projectId); assert.equal(ready.errorCode, null);
  assert.equal((await project.reconcile(first.id, f.context)).state, 'READY');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_conversations').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n, 0);
});
test('project reconciliation: incomplete resources and foreign controllers cannot supply missing IDs', async t => {
  const f = fixture(t); f.host.createOrdinaryChat = async () => { throw new Error('fixture timeout'); };
  const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 100, host: f.host });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  await assert.rejects(project.reconcile(first.id, f.context), { code: 'PROVENANCE' });
  const foreign = f.authority.issue({ principal: 'fixture:foreign', instance: 'two', executor: 'hermes', controller: true, reviewer: false });
  await assert.rejects(project.reconcile(first.id, foreign), { code: 'NOT_FOUND' });
  await assert.rejects(project.reconcile(first.id, {} as typeof f.context), { code: 'AUTH' });
  assert.equal(project.get(first.id, f.context).state, 'UNCERTAIN'); assert.equal(f.creates(), 1);
});
test('project reconciliation: mismatched readback and concurrent reconcile preserve uncertainty', async t => {
  const f = fixture(t); f.host.verifyBundle = async resources => ({ ...resources, source: 'application-host', workspaceSurface: 'native-desktop', codexNativeProjectId: resources.appProjectId, kind: 'work' }) as unknown as Awaited<ReturnType<ProjectHost['verifyBundle']>>;
  const project = new ProjectProvisioner(f.db, f.authority, { root: join(f.root, 'workspaces'), timeoutMs: 1000, host: f.host });
  const first = await project.prepare('fixture-project', 'fixture-event', f.context);
  assert.equal((await project.reconcile(first.id, f.context)).state, 'UNCERTAIN');
  let release!: () => void; const gate = new Promise<void>(done => release = done);
  f.host.verifyBundle = async resources => { await gate; return { ...resources, source: 'application-host', workspaceSurface: 'native-desktop', codexNativeProjectId: resources.appProjectId, kind: 'ordinary-chat', chatgptConversationId: 'foreign-gpt' }; };
  const active = project.reconcile(first.id, f.context);
  await assert.rejects(project.reconcile(first.id, f.context), { code: 'STATE' });
  release(); assert.equal((await active).state, 'UNCERTAIN'); assert.equal(f.creates(), 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n, 0);
});

test('project reconciliation: original GPT receipt resumes only the missing Codex phase',async t=>{
  const f=fixture(t);let gpt=0,codex=0;
  f.host.createOrdinaryChat=async()=>{gpt++;throw new Error('receipt lost');};
  f.host.createCodexConversation=async()=>{codex++;return {conversationId:'fixture-codex'};};
  f.host.observePartial=async(resources,phase)=>{assert.equal(phase,'gpt');return {...resources,chatgptConversationId:'fixture-gpt'};};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const first=await p.prepare('recover-project','recover-event',f.context);assert.equal(first.phase,'gpt');
  assert.equal((await p.reconcile(first.id,f.context)).state,'READY');assert.equal(gpt,1);assert.equal(codex,1);assert.equal(f.creates(),1);
});

test('project reconciliation: lost Codex receipt uses only original host evidence and never creates again',async t=>{
 for(const readable of [true,false]) {
  const f=fixture(t);let codex=0,gpt=0,key:string|undefined;
  f.host.createOrdinaryChat=async()=>{gpt++;return {conversationId:'fixture-gpt'};};
  f.host.createCodexConversation=async(_project,_path,_signal,operationKey)=>{codex++;key=operationKey;throw new BridgeError('IO','[TEST] formal creation receipt lost');};
  // Only this isolated host fixture has retained original-operation evidence.
  f.host.observePartial=async(resources,phase)=>{assert.equal(phase,'codex');assert.equal(resources.initializationKey,key);if(!readable)throw new BridgeError('UNSUPPORTED','Original formal receipt is unavailable');return {...resources,codexConversationId:'fixture-original-codex'};};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const first=await p.prepare('codex-recovery','codex-recovery-event',f.context);
  assert.equal(first.state,'UNCERTAIN');assert.equal(first.phase,'codex');
  if(readable) {const recovered=await p.reconcile(first.id,f.context);assert.equal(recovered.state,'READY');assert.equal(recovered.resources!.codexConversationId,'fixture-original-codex');await p.reconcile(first.id,f.context);}
  else {await assert.rejects(p.reconcile(first.id,f.context),{code:'UNSUPPORTED'});assert.equal(p.get(first.id,f.context).state,'UNCERTAIN');}
  assert.equal(codex,1);assert.equal(gpt,1);assert.equal(f.creates(),1);
  assert.equal(p.get(first.id,f.context).resources!.appProjectId,first.resources!.appProjectId);
  assert.equal(p.get(first.id,f.context).resources!.workspacePath,first.resources!.workspacePath);
 }
});

test('project reconciliation: a crash before any resource receipt releases the reservation without guessing',async t=>{
  const f=fixture(t),{promptHash}=await import('../src/prompts.ts'),{processOwner}=await import('../src/db.ts');
  const root=join(f.root,'workspaces'),path=join(root,'fixture-project'),p=new ProjectProvisioner(f.db,f.authority,{root,timeoutMs:100,host:f.host});
  const insert=(id:string,key:string,name:string,target:string)=>f.db.prepare("INSERT INTO project_operations(id,principal,event_key,request_hash,project_id,name,root_path,state,owner_token,created_at,updated_at) VALUES(?,'fixture:controller',?,?,?,?,?,'UNCERTAIN','0:dead','2000','2000')").run(id,key,promptHash(JSON.stringify({name,path:target})),`${id}-project`,name,target);
  insert('never-started','fixture-event','fixture-project',path);
  assert.equal((await p.reconcile('never-started',f.context)).state,'BLOCKED');assert.equal(f.creates(),0);
  const ready=await p.prepare('fixture-project','fixture-event',f.context);
  assert.equal(ready.id,'never-started');assert.equal(ready.state,'READY');assert.equal(f.creates(),1);
  assert.equal(f.db.prepare('SELECT owner_token FROM project_operations WHERE id=?').get('never-started')!.owner_token,processOwner());
  // A directory without a saved receipt has unknown ownership and is never released or reused.
  const other=join(root,'unknown-dir');(await import('node:fs')).mkdirSync(other,{recursive:true});insert('unknown-dir','other-event','unknown-dir',other);
  await assert.rejects(p.reconcile('unknown-dir',f.context),{code:'PROVENANCE'});assert.equal(p.get('unknown-dir',f.context).state,'UNCERTAIN');
});

test('legacy adoption: migrated mappings gain access only after native readback of recorded IDs',async t=>{
  const f=fixture(t),{ConversationRegistry}=await import('../src/topology.ts'),registry=new ConversationRegistry(f.db,f.authority),path=join(f.root,'legacy');
  registry.registerProject('legacy','legacy',path,f.context);
  registry.register({projectId:'legacy',workspacePath:path,chatgptConversationId:'legacy-gpt',chatgptConversationName:'legacy',codexConversationId:'legacy-codex'},f.context);
  // Reduce to the migrated state: mapping kept, no native workspace ID and no controller access.
  f.db.prepare('DELETE FROM project_access').run();
  const foreign=f.authority.issue({principal:'fixture:foreign',instance:'two',executor:'hermes',controller:true,reviewer:false});
  await assert.rejects(async()=>registry.register({projectId:'legacy',workspacePath:path,chatgptConversationId:'legacy-gpt',chatgptConversationName:'legacy',codexConversationId:'legacy-codex'},foreign),{code:'AUTH'});
  const p=new ProjectProvisioner(f.db,f.authority,{root:f.root,timeoutMs:100,host:f.host});
  await assert.rejects(p.adopt('legacy',f.context),{code:'UNSUPPORTED'});
  let seen:unknown;f.host.verifyExisting=async input=>{seen=input;throw new BridgeError('PROVENANCE','[TEST] foreign native membership');};
  await assert.rejects(p.adopt('legacy',f.context),{code:'PROVENANCE'});
  assert.deepEqual(seen,{name:'legacy',workspacePath:resolve(path),chatgptConversationId:'legacy-gpt',codexConversationIds:['legacy-codex']});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM project_access').get()!.n,0);
  f.host.verifyExisting=async()=>({appProjectId:'native-legacy'});
  assert.deepEqual(await p.adopt('legacy',f.context),{projectId:'legacy',appProjectId:'native-legacy',adopted:true});
  assert.deepEqual(await p.adopt('legacy',f.context),{projectId:'legacy',appProjectId:'native-legacy',adopted:false});
  await assert.rejects(p.adopt('legacy',foreign),{code:'AUTH'});
  assert.equal(f.db.prepare('SELECT app_project_id FROM conversation_workspaces').get()!.app_project_id,'native-legacy');
  assert.equal(f.db.prepare('SELECT principal FROM project_access').get()!.principal,'fixture:controller');
});

test('project provisioning: an existing root, including a drive root, is never passed to mkdir',async t=>{
  const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module'),{parse}=await import('node:path'),{randomUUID}=await import('node:crypto');
  // The isolated ledger is created before mkdir is instrumented.
  const f=fixture(t),real=fs.mkdirSync,calls:{path:string;recursive:boolean}[]=[];let create=true;
  // Windows Node fails mkdirSync('D:\\',{recursive:true}) with EPERM; reproduce that for any existing root.
  const mocked=t.mock.method(fs,'mkdirSync',((target:string,options?:{recursive?:boolean})=>{
    calls.push({path:String(target),recursive:!!options?.recursive});
    if(fs.existsSync(target)){const error=Object.assign(new Error('EPERM: operation not permitted, mkdir'),{code:'EPERM'});throw error;}
    return create?real(target,options):undefined;
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  // Each project registers its own native workspace identity.
  f.host.createWorkspace=async(name,workspacePath)=>({appProjectId:`native-${name}`,workspacePath});
  f.host.createOrdinaryChat=async appProjectId=>({conversationId:`${appProjectId}-gpt`});f.host.createCodexConversation=async appProjectId=>({conversationId:`${appProjectId}-codex`});
  // Drive/filesystem root of the temp directory: nothing is created there (mkdir is recorded only).
  create=false;const drive=parse(f.root).root,name=`acb-fixture-${randomUUID()}`;
  const atRoot=await new ProjectProvisioner(f.db,f.authority,{root:drive,timeoutMs:100,host:f.host}).prepare(name,'drive-root',f.context);
  assert.equal(atRoot.state,'READY');assert.deepEqual(calls,[{path:join(drive,name),recursive:false}]);
  // Ordinary existing root: only the workspace directory is created; a missing root is created recursively.
  create=true;calls.length=0;
  const plain=await new ProjectProvisioner(f.db,f.authority,{root:f.root,timeoutMs:100,host:f.host}).prepare('plain-root','plain-root',f.context);
  assert.equal(plain.state,'READY');assert.deepEqual(calls,[{path:join(f.root,'plain-root'),recursive:false}]);assert.equal(fs.existsSync(join(f.root,'plain-root')),true);
  calls.length=0;const nested=join(f.root,'missing','nested');
  assert.equal((await new ProjectProvisioner(f.db,f.authority,{root:nested,timeoutMs:100,host:f.host}).prepare('nested-root','nested-root',f.context)).state,'READY');
  assert.deepEqual(calls,[{path:nested,recursive:true},{path:join(nested,'nested-root'),recursive:false}]);
});

test('project recovery: a lost workspace stays PROVENANCE until an explicit, verified, audited restart',async t=>{
  const f=fixture(t),{writeFileSync,rmSync:remove}=await import('node:fs');let attempts=0,listed:{projectId:string;label:string}[]=[];
  f.host.createWorkspace=async(_name,workspacePath)=>{attempts++;if(attempts<2)throw new BridgeError('TIMEOUT','[TEST] workspace-create timed out at workspace-confirm');return {appProjectId:'native-after-restart',workspacePath};};
  const root=join(f.root,'workspaces'),p=new ProjectProvisioner(f.db,f.authority,{root,timeoutMs:100,host:f.host});
  const first=await p.prepare('restart-project','restart-event',f.context);
  assert.equal(first.state,'UNCERTAIN');assert.equal(first.phase,'workspace');assert.deepEqual(first.stages,{directoryCreated:true,nativeWorkspace:false,gptConversation:false,codexConversations:0,codexRequested:1,codexPending:null});
  // Reconciliation has no receipt to follow and never creates: only PROVENANCE.
  await assert.rejects(p.reconcile(first.id,f.context),{code:'PROVENANCE'});assert.equal(attempts,1);
  await assert.rejects(p.restartWorkspace(first.id,f.context),{code:'UNSUPPORTED'});
  f.host.nativeWorkspaces=async()=>listed;
  listed=[{projectId:'native-late',label:'restart-project'}];
  await assert.rejects(p.restartWorkspace(first.id,f.context),{code:'PROVENANCE'});
  listed=[];writeFileSync(join(first.workspacePath,'unknown.txt'),'[TEST]');
  await assert.rejects(p.restartWorkspace(first.id,f.context),{code:'PROVENANCE'});
  remove(join(first.workspacePath,'unknown.txt'));assert.equal(attempts,1);assert.equal(p.get(first.id,f.context).state,'UNCERTAIN');
  const ready=await p.restartWorkspace(first.id,f.context);
  assert.equal(ready.state,'READY');assert.equal(ready.resources!.appProjectId,'native-after-restart');assert.equal(attempts,2);assert.equal(ready.id,first.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='project_workspace_restart'").get()!.n,1);
  await assert.rejects(p.restartWorkspace(first.id,f.context),{code:'STATE'});
  // The restart budget is bounded; further failures are reported, not retried.
  f.host.createWorkspace=async()=>{throw new BridgeError('TIMEOUT','[TEST] still timing out');};
  const stuck=await p.prepare('stuck-project','stuck-event',f.context);
  for(let i=0;i<2;i++)assert.equal((await p.restartWorkspace(stuck.id,f.context)).state,'UNCERTAIN');
  await assert.rejects(p.restartWorkspace(stuck.id,f.context),{code:'CONFLICT'});
  const foreign=f.authority.issue({principal:'fixture:foreign',instance:'two',executor:'hermes',controller:true,reviewer:false});
  await assert.rejects(p.restartWorkspace(stuck.id,foreign),{code:'NOT_FOUND'});
});

test('project provisioning: two Codex conversations get distinct formal receipts in one workspace, without recreation',async t=>{
  const f=fixture(t),created:number[]=[];
  f.host.createCodexConversation=async(_project,_path,_signal,_key,index=0)=>{created.push(index);return {conversationId:`fixture-codex-${index}`};};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const ready=await p.prepare('two-codex','two-codex-event',f.context,{codexConversations:2});
  assert.equal(ready.state,'READY');assert.deepEqual(created,[0,1]);assert.deepEqual(ready.resources!.extraCodexConversationIds,['fixture-codex-1']);
  assert.equal(ready.stages!.codexConversations,2);
  assert.deepEqual(f.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=? ORDER BY conversation_id').all(ready.projectId).map(row=>row.conversation_id),['fixture-codex-0','fixture-codex-1']);
  assert.equal(f.db.prepare('SELECT default_codex_conversation_id d FROM conversation_workspaces WHERE project_id=?').get(ready.projectId)!.d,'fixture-codex-0');
  assert.equal((await p.prepare('two-codex','two-codex-event',f.context,{codexConversations:2})).id,ready.id);assert.deepEqual(created,[0,1]);
  await assert.rejects(p.prepare('two-codex','two-codex-event',f.context),{code:'CONFLICT'});
  await assert.rejects(p.prepare('bad-count','bad-count',f.context,{codexConversations:5}),{code:'INPUT'});
  // A repeated receipt is refused and nothing is registered; a lost extra receipt is not guessed.
  f.host.createCodexConversation=async()=>({conversationId:'fixture-codex'});
  const repeated=await p.prepare('repeat-codex','repeat-event',f.context,{codexConversations:2});
  assert.equal(repeated.state,'UNCERTAIN');assert.equal(repeated.errorCode,'PROVENANCE');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects WHERE name=?').get('repeat-codex')!.n,0);
  let extra=0;f.host.createCodexConversation=async(_project,_path,_signal,_key,index=0)=>{if(index){extra++;throw new BridgeError('IO','[TEST] receipt lost');}return {conversationId:'lost-codex-0'};};
  const lost=await p.prepare('lost-codex','lost-event',f.context,{codexConversations:2});
  // Without a host that reads the conversation's own initialization receipt, nothing is inferred.
  assert.equal(lost.phase,'codex.extra');await assert.rejects(p.reconcile(lost.id,f.context),{code:'PROVENANCE'});assert.equal(extra,1);
});

test('project provisioning: without a formal Codex creator the bundle waits for verified operator-created conversations',async t=>{
  const f=fixture(t),capabilities=await f.host.inspect(new AbortController().signal);let created=0;const verified:string[]=[];
  f.host.inspect=async()=>({...capabilities,createCodexConversation:false});
  f.host.createCodexConversation=async()=>{created++;throw new BridgeError('UNSUPPORTED','[TEST] no formal creator');};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const waiting=await p.prepare('attach-project','attach-event',f.context,{codexConversations:2});
  assert.equal(waiting.state,'BLOCKED');assert.equal(waiting.errorCode,'CODEX_ATTACH_REQUIRED');assert.equal(waiting.phase,'codex.attach');
  assert.deepEqual(waiting.stages,{directoryCreated:true,nativeWorkspace:true,gptConversation:true,codexConversations:0,codexRequested:2,codexPending:null});
  assert.match(String(f.db.prepare("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE '%codex-attach%'").get()!.payload),/acb_project_attach_codex/);
  await assert.rejects(p.attachCodex(waiting.id,'operator-codex-1',f.context),{code:'UNSUPPORTED'});
  f.host.verifyCodexMember=async input=>{if(input.conversationId==='foreign-codex')throw new BridgeError('PROVENANCE','[TEST] other workspace');assert.equal(input.appProjectId,'native-project-fixture');verified.push(input.conversationId);};
  await assert.rejects(p.attachCodex(waiting.id,'foreign-codex',f.context),{code:'PROVENANCE'});
  await assert.rejects(p.attachCodex(waiting.id,'fixture-gpt',f.context),{code:'CONFLICT'});
  await assert.rejects(p.attachCodex(waiting.id,'bad id!',f.context),{code:'INPUT'});
  assert.equal(p.get(waiting.id,f.context).stages!.codexConversations,0);
  const half=await p.attachCodex(waiting.id,'operator-codex-1',f.context);
  assert.equal(half.state,'BLOCKED');assert.equal(half.stages!.codexConversations,1);
  assert.equal((await p.attachCodex(waiting.id,'operator-codex-1',f.context)).stages!.codexConversations,1);
  const foreign=f.authority.issue({principal:'fixture:foreign',instance:'two',executor:'hermes',controller:true,reviewer:false});
  await assert.rejects(p.attachCodex(waiting.id,'operator-codex-2',foreign),{code:'NOT_FOUND'});
  const ready=await p.attachCodex(waiting.id,'operator-codex-2',f.context);
  assert.equal(ready.state,'READY');assert.deepEqual(verified,['operator-codex-1','operator-codex-2']);assert.equal(created,0);
  assert.deepEqual(f.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=? ORDER BY conversation_id').all(ready.projectId).map(row=>row.conversation_id),['operator-codex-1','operator-codex-2']);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='project_codex_attach'").get()!.n,2);
  // READY keeps accepting verified members of the same workspace.
  assert.equal((await p.attachCodex(waiting.id,'operator-codex-3',f.context)).stages!.codexConversations,3);
});

test('READY project: verified Codex conversations are added by attach or one formal creation per approved attempt, never resent',async t=>{
  const f=fixture(t),signal=new AbortController().signal,{randomUUID}=await import('node:crypto');
  f.host.createWorkspace=async(name,workspacePath)=>({appProjectId:`native-${name}`,workspacePath});
  f.host.createOrdinaryChat=async(appProjectId)=>({conversationId:`${appProjectId}-gpt`});f.host.createCodexConversation=async appProjectId=>({conversationId:`${appProjectId}-codex`});
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const declared=await f.host.inspect(signal);f.host.inspect=async()=>({...declared,createCodexConversation:true});
  const ready=await p.prepare('one-codex','one-codex-event',f.context),other=await p.prepare('other-project','other-event',f.context);
  assert.equal(ready.state,'READY');assert.equal(other.state,'READY');
  const hash=f.db.prepare('SELECT request_hash FROM project_operations WHERE id=?').get(ready.id)!.request_hash,id=ready.id;
  await assert.rejects(p.attachCodex(id,'operator-codex',f.context),{code:'UNSUPPORTED'});
  const verified:string[]=[];
  f.host.verifyCodexMember=async input=>{if(input.conversationId.startsWith('foreign'))throw new BridgeError('PROVENANCE','[TEST] other workspace');assert.equal(input.appProjectId,'native-one-codex');assert.equal(input.name,'one-codex');verified.push(input.conversationId);};
  // Same-project repeats are idempotent; GPT, other projects and foreign workspaces are refused.
  assert.equal((await p.attachCodex(id,'native-one-codex-codex',f.context)).stages!.codexConversations,1);
  for(const [conversation,code] of [['native-one-codex-gpt','CONFLICT'],['native-other-project-codex','CONFLICT'],['native-other-project-gpt','CONFLICT'],['foreign-codex','PROVENANCE'],['bad id!','INPUT']] as const)
    await assert.rejects(p.attachCodex(id,conversation,f.context),{code},conversation);
  const foreign=f.authority.issue({principal:'fixture:foreign',instance:'two',executor:'hermes',controller:true,reviewer:false});
  await assert.rejects(p.attachCodex(id,'operator-codex',foreign),{code:'NOT_FOUND'});
  f.db.prepare('INSERT INTO project_access(project_id,principal) VALUES(?,?)').run(ready.projectId,'fixture:foreign');
  await assert.rejects(p.attachCodex(id,'operator-codex',f.context),{code:'AUTH'});
  f.db.prepare('DELETE FROM project_access WHERE principal=?').run('fixture:foreign');
  assert.equal(verified.length,0);
  const attached=await p.attachCodex(id,'operator-codex',f.context);
  assert.equal(attached.state,'READY');assert.deepEqual(attached.resources!.extraCodexConversationIds,['operator-codex']);assert.equal(attached.stages!.codexConversations,2);
  assert.equal((await p.attachCodex(id,'operator-codex',f.context)).stages!.codexConversations,2);assert.deepEqual(verified,['operator-codex']);
  // Formal creation: one reviewer approval per attempt, codex-thread only, the pending index saved first.
  const scopes:{operationId:string;attempt:string;effects:string[]}[]=[];let calls=0,lose=false;
  f.host.authorizeInitialization=async(name,path,_signal,scope)=>{assert.equal(name,'one-codex');assert.equal(path.toLowerCase(),ready.workspacePath.toLowerCase());scopes.push(scope);};
  f.host.createCodexConversation=async(appProjectId,workspacePath,_signal,key,index,scope)=>{
    calls++;assert.equal(appProjectId,'native-one-codex');assert.equal(workspacePath.toLowerCase(),ready.workspacePath.toLowerCase());assert.equal(key,id);assert.equal(scope,scopes.at(-1));
    assert.equal(p.get(id,f.context).stages!.codexPending,index);
    if(lose)throw new BridgeError('IO','[TEST] create_thread reply lost');return {conversationId:`formal-codex-${index}`};
  };
  const created=await p.createCodex(id,f.context);
  assert.deepEqual(created.resources!.extraCodexConversationIds,['operator-codex','formal-codex-2']);assert.equal(created.stages!.codexPending,null);
  assert.deepEqual(scopes.map(scope=>[scope.operationId,scope.effects]),[[id,['codex-thread']]]);
  f.host.authorizeInitialization=async()=>{throw new BridgeError('AUTH','[TEST] reviewer rejected');};
  await assert.rejects(p.createCodex(id,f.context),{code:'AUTH'});assert.equal(p.get(id,f.context).stages!.codexPending,null);assert.equal(calls,1);
  f.host.authorizeInitialization=async(_name,_path,_signal,scope)=>{scopes.push(scope);};
  const capabilities=await f.host.inspect(signal),inspect=f.host.inspect;f.host.inspect=async()=>({...capabilities,createCodexConversation:false});
  await assert.rejects(p.createCodex(id,f.context),{code:'UNSUPPORTED'});f.host.inspect=inspect;
  // A lost receipt stays pending; the next call reads the original receipt and never creates again.
  lose=true;await assert.rejects(p.createCodex(id,f.context),{code:'IO'});
  assert.equal(p.get(id,f.context).stages!.codexPending,3);assert.equal(calls,2);assert.notEqual(scopes.at(-1)!.attempt,scopes[0].attempt);
  assert.match(String(f.db.prepare("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE ?").get(`project:${id}:codex-create:3:%`)!.payload),/never resent/);
  await assert.rejects(p.createCodex(id,f.context),{code:'UNSUPPORTED'});
  let observed:unknown;f.host.observeCodexCreation=async input=>{observed=input;return undefined;};
  await assert.rejects(p.createCodex(id,f.context),{code:'PROVENANCE'});assert.deepEqual({appProjectId:observed.appProjectId,workspacePath:observed.workspacePath.toLowerCase(),operationKey:observed.operationKey,index:observed.index},{appProjectId:'native-one-codex',workspacePath:ready.workspacePath.toLowerCase(),operationKey:id,index:3});
  f.host.observeCodexCreation=async()=>'recovered-codex-3';
  const recovered=await p.createCodex(id,f.context);
  assert.equal(recovered.stages!.codexConversations,4);assert.equal(recovered.stages!.codexPending,null);assert.equal(calls,2);
  assert.deepEqual(f.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=? ORDER BY conversation_id').all(ready.projectId).map(row=>row.conversation_id),['formal-codex-2','native-one-codex-codex','operator-codex','recovered-codex-3']);
  await assert.rejects(p.createCodex(id,f.context),{code:'CONFLICT'});await assert.rejects(p.attachCodex(id,'operator-codex-5',f.context),{code:'CONFLICT'});
  assert.deepEqual(f.db.prepare("SELECT action,detail FROM audit_log WHERE action IN ('project_codex_add','project_codex_create') ORDER BY rowid").all().map(row=>[row.action,String(row.detail).replace(id,'<id>')]),
    [['project_codex_add','operation=<id> conversation=operator-codex source=attach'],['project_codex_create','operation=<id> index=2'],['project_codex_add','operation=<id> conversation=formal-codex-2 source=created'],
     ['project_codex_create','operation=<id> index=3'],['project_codex_add','operation=<id> conversation=recovered-codex-3 source=recovered']]);
  // The original request fingerprint and requested count are unchanged; READY creation needs READY.
  assert.equal(f.db.prepare('SELECT request_hash FROM project_operations WHERE id=?').get(id)!.request_hash,hash);assert.equal(recovered.stages!.codexRequested,1);
  assert.equal((await p.prepare('one-codex','one-codex-event',f.context)).id,id);
  const blocked=await new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'blocked'),timeoutMs:100}).prepare('blocked-project','blocked-event',f.context);
  await assert.rejects(p.createCodex(blocked.id,f.context),{code:'STATE'});assert.ok(randomUUID());
});
test('project provisioning: a hidden or ambiguous native workspace entry stops before approval, directory or restart budget',async t=>{
  const f=fixture(t);let entry='offscreen',approvals=0;
  f.host.probeWorkspaceEntry=async()=>{if(entry!=='ready')throw new BridgeError('STATE',`[TEST] entry ${entry}`);};
  f.host.authorizeInitialization=async()=>{approvals++;};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const blocked=await p.prepare('entry-project','entry-event',f.context);
  assert.equal(blocked.state,'BLOCKED');assert.equal(blocked.errorCode,'STATE');assert.equal(existsSync(blocked.workspacePath),false);assert.equal(approvals,0);assert.equal(f.creates(),0);
  entry='ready';f.host.createWorkspace=async()=>{throw new BridgeError('TIMEOUT','[TEST] workspace-create timed out');};
  const uncertain=await p.prepare('entry-project','entry-event',f.context);
  assert.equal(uncertain.id,blocked.id);assert.equal(uncertain.state,'UNCERTAIN');assert.equal(approvals,1);
  f.host.nativeWorkspaces=async()=>[];entry='ambiguous';
  await assert.rejects(p.restartWorkspace(uncertain.id,f.context),{code:'STATE'});
  assert.equal(approvals,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='project_workspace_restart'").get()!.n,0);
});
test('project provisioning: a Codex creation refused before any effect waits for attach instead of staying uncertain',async t=>{
  const f=fixture(t),capabilities=await f.host.inspect(new AbortController().signal);let created=0;
  f.host.inspect=async()=>({...capabilities,createCodexConversation:true});
  f.host.createCodexConversation=async()=>{created++;throw new BridgeError('AUTH','[TEST] reviewer rejected codex-thread');};
  f.host.verifyCodexMember=async()=>{};
  const p=new ProjectProvisioner(f.db,f.authority,{root:join(f.root,'workspaces'),timeoutMs:100,host:f.host});
  const waiting=await p.prepare('refused-codex','refused-event',f.context);
  assert.equal(waiting.state,'BLOCKED');assert.equal(waiting.phase,'codex.attach');assert.equal(waiting.errorCode,'CODEX_ATTACH_REQUIRED');assert.equal(created,1);
  assert.match(String(f.db.prepare("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE '%codex-attach%'").get()!.payload),/reviewer rejected/);
  assert.equal((await p.attachCodex(waiting.id,'operator-codex',f.context)).state,'READY');
  // On a READY project the same refusal releases the pending index; nothing is left to recover.
  f.host.createCodexConversation=async()=>{created++;throw new BridgeError('UNSUPPORTED','[TEST] create_thread schema incompatible');};
  await assert.rejects(p.createCodex(waiting.id,f.context),{code:'UNSUPPORTED'});
  const after=p.get(waiting.id,f.context);assert.equal(after.stages!.codexPending,null);assert.equal(after.stages!.codexConversations,1);assert.equal(created,2);
});
