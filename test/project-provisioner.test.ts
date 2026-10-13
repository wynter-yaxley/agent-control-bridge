import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
