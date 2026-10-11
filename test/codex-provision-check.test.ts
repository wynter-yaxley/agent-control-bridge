import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { checkCodexProvisioning } from '../src/codex-app-server.ts';

type Mode = 'normal' | 'cold-missing' | 'wrong-model' | 'wrong-effort' | 'wrong-stored-model' | 'wrong-stored-effort' | 'wrong-cwd' | 'duplicate-id' | 'mixed-listing' | 'name-rejected' | 'silent' | 'approval';
function fixture(mode: Mode = 'normal') {
  const requests: { method: string; params: Record<string, unknown> }[] = [], roots: string[] = [];
  const stored = new Map<string, { id: string; cwd: string; model: string; effort: string }>();
  let processes = 0, killed = 0;
  const spawnFn = ((_exe: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; shell?: boolean }) => {
    processes++;
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    assert.deepEqual(args, ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps', 'app-server', '--listen', 'stdio://']);
    const home = options.env?.CODEX_HOME!;assert.ok(home);assert.ok(existsSync(home));assert.equal(dirname(home), options.cwd);
    assert.equal(existsSync(join(home, 'auth.json')), false); roots.push(options.cwd!);
    const loaded = new Set<string>(), cold = processes > 1;
    const child = new EventEmitter() as ChildProcess;child.stdout=new EventEmitter() as unknown as Readable;child.stderr=new EventEmitter() as unknown as Readable;
    child.kill=()=>{killed++;queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
    const emit=(value:unknown)=>child.stdout!.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
    const thread=(item:{id:string;cwd:string})=>({...item,ephemeral:false,source:'appServer',projectId:null,status:{type:loaded.has(item.id)?'idle':'notLoaded'},preview:'private fixture text'});
    child.stdin=new Writable({write(chunk,_enc,done){
      const message=JSON.parse(String(chunk));requests.push(message);done();
      if(message.id===undefined||!message.method)return;
      queueMicrotask(()=>{
        if(mode==='silent')return;
        if(message.method==='initialize')emit({id:message.id,result:{}});
        else if(message.method==='model/list'){
          if(mode==='approval'){emit({id:'approval',method:'account/chatgptAuthTokens/refresh',params:{private:'do not record'}});return;}
          emit({id:message.id,result:{data:[{model:'gpt-fixture-a',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'gpt-fixture-b',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null}});
        }else if(message.method==='thread/start'){
          const id=mode==='duplicate-id'?'fixture-thread-one':`fixture-thread-${stored.size+1}`,item={id,cwd:message.params.cwd,model:message.params.model,effort:message.params.config.model_reasoning_effort};stored.set(id,item);loaded.add(id);
          emit({id:message.id,result:{thread:thread(item),cwd:item.cwd,model:mode==='wrong-model'?'gpt-foreign':message.params.model,reasoningEffort:mode==='wrong-effort'?'ultra':message.params.config.model_reasoning_effort,approvalPolicy:'untrusted',sandbox:{type:'readOnly'}}});
        }else if(message.method==='thread/name/set')emit(mode==='name-rejected'?{id:message.id,error:{code:-32600,message:'private error'}}:{id:message.id,result:{}});
        else if(message.method==='thread/read'){
          if(mode==='cold-missing'&&cold){emit({id:message.id,error:{code:-32600,message:'private error'}});return;}
          const item=stored.get(message.params.threadId)!;
          emit({id:message.id,result:{thread:thread(mode==='wrong-cwd'?{...item,cwd:join(item.cwd,'foreign')}:item)}});
        }else if(message.method==='thread/resume'){
          assert.deepEqual(Object.keys(message.params),['threadId']);const item=stored.get(message.params.threadId)!;loaded.add(item.id);
          emit({id:message.id,result:{thread:thread(item),model:mode==='wrong-stored-model'?'gpt-foreign':item.model,reasoningEffort:mode==='wrong-stored-effort'?'ultra':item.effort}});
        }else if(message.method==='thread/list'){
          const items=[...stored.values()].filter(item=>mode==='mixed-listing'||item.cwd===message.params.cwd);
          emit({id:message.id,result:{data:items.map(thread),nextCursor:null}});
        }else throw new Error('Unexpected diagnostic request');
      });
    }});
    return child;
  }) as typeof spawn;
  return {options:{executable:'fixture',timeoutMs:1000,spawnFn},requests,roots,killed:()=>killed};
}

test('provision check: four isolated dormant Codex IDs, model/effort and stored workspace separation',async()=>{
  const f=fixture(),result=await checkCodexProvisioning(f.options);
  assert.equal(result.ok,true);assert.equal(result.checks.length,4);assert.ok(result.checks.every(x=>x.created&&x.settingsMatch&&x.readback&&x.persisted&&x.storedSettingsMatch));
  assert.equal(result.differentModelsVerified,true);assert.equal(result.differentEffortsVerified,true);assert.equal(result.crossWorkspaceIsolationVerified,true);assert.equal(result.storedListingIsolationVerified,true);
  assert.equal(result.nativeWorkspaceBindingVerified,false);assert.equal(result.modelAccessVerified,false);assert.equal(result.fullWorkflowReady,false);assert.equal(result.temporaryResourcesRemoved,true);
  assert.ok(f.roots.every(root=>!existsSync(root)));assert.equal(f.killed(),2);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!f.requests.some(x=>/turn\/start|login|account\//.test(x.method)));
  for(const request of f.requests.filter(x=>x.method==='thread/start')){assert.equal(request.params.ephemeral,false);assert.equal(request.params.sandbox,'read-only');}
});

test('provision check: omitting listings is PARTIAL and never counts a skipped check as passed',async()=>{
 const f=fixture(),result=await checkCodexProvisioning({...f.options,skipListings:true});
 assert.equal(result.ok,false);assert.equal(result.code,'PARTIAL');assert.equal(result.listingsSkipped,true);assert.equal(result.storedListingIsolationVerified,false);assert.equal(result.temporaryResourcesRemoved,true);
 assert.equal(f.requests.filter(x=>x.method==='thread/list').length,0);assert.ok(result.checks.every(x=>x.storedSettingsMatch));
});

test('provision check: optional Codex naming addresses only its newly owned IDs',async()=>{
  const f=fixture(),result=await checkCodexProvisioning({...f.options,nameDormantThreads:true});
  assert.equal(result.ok,true);assert.ok(result.checks.every(x=>x.codexTitleSet));
  const ids=f.requests.filter(x=>x.method==='thread/name/set').map(x=>x.params.threadId);assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);
  assert.equal(result.ordinaryGptCreationVerified,false);
});

for(const mode of ['cold-missing','wrong-model','wrong-effort','wrong-stored-model','wrong-stored-effort','wrong-cwd','duplicate-id','mixed-listing','name-rejected','approval'] as const)test(`provision check: ${mode} is a failed capability check, never workflow readiness`,async()=>{
  const f=fixture(mode),result=await checkCodexProvisioning({...f.options,nameDormantThreads:mode==='name-rejected'});
  assert.equal(result.ok,false);assert.equal(result.fullWorkflowReady,false);assert.equal(result.temporaryResourcesRemoved,true);
  assert.ok(f.roots.every(root=>!existsSync(root)));assert.equal(f.requests.filter(x=>x.method==='turn/start').length,0);
  if(mode==='cold-missing'){assert.equal(result.stage,'stored-readback');assert.equal(result.differentModelsVerified,true);assert.equal(result.uniqueConversationIds,true);assert.ok(result.checks.every(x=>!x.persisted));}
});

test('provision check: finite deadline cancels an unresponsive owned process; pre-abort creates nothing',async()=>{
 const f=fixture('silent'),result=await checkCodexProvisioning({...f.options,timeoutMs:30});
 assert.equal(result.ok,false);assert.equal(result.code,'TIMEOUT');assert.equal(result.temporaryResourcesRemoved,true);
 const before=fixture(),signal=AbortSignal.abort();await assert.rejects(checkCodexProvisioning({...before.options,signal}),{code:'TIMEOUT'});assert.equal(before.roots.length,0);
});
