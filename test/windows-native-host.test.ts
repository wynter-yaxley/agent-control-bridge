import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {isolatedDemo} from '../src/demo-scope.ts';
import {defaults} from '../src/config.ts';
import {CallerAuthority} from '../src/caller.ts';
import {ProjectProvisioner} from '../src/project-provisioner.ts';
import {assertOrdinaryChatCapabilities} from '../src/ordinary-chat.ts';
import {createWindowsNativeProjectHost,createWindowsNativeConversationHost,codexInitializationPrompt,WindowsNativeUi,type WindowsNativeTools} from '../src/windows-native-host.ts';

test('windows native host: authorized UI identity setup registers pinned Codex READY without generation authority',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  let path='',prompt='',codexPrompt='',chatCreated=false,codexCreated=false;const calls:string[]=[],grants:Record<string,unknown>[]=[];
  const ui=new class extends WindowsNativeUi {
    override async call(operation:Parameters<WindowsNativeUi['call']>[0],fields:Parameters<WindowsNativeUi['call']>[1]) {
      calls.push(operation);
      if(operation==='workspace-entry')return {ok:true,entry:{state:'ready' as const,count:1}};
      if(operation==='workspace-create')path=fields.path!;
      if(operation==='gpt-create'){chatCreated=true;prompt=fields.prompt!;}
      return {ok:true,ordinaryModeObserved:operation==='gpt-create',conversationId:'fixture-gpt'};
    }
  }(config);
  const native:WindowsNativeTools={
    listProjects:async()=>({projects:[{projectId:'fixture-native',projectKind:'local',hostId:'local',label:'fixture-project',path}]}),
    listThreads:async()=>({pinnedThreads:codexCreated?[{id:'fixture-codex',kind:'codex',title:'fixture-project Codex',projectId:'fixture-native',cwd:path}]:[],threads:[...(chatCreated?[{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project'}]:[])]}),
    readThread:async id=>id==='fixture-codex'?{thread:{id,kind:'codex',title:'fixture-project Codex',status:{type:'idle'}},turns:[{id:'codex-turn',status:'completed',error:null,items:[{type:'userMessage',id:'codex-user',content:[{type:'text',text:`${codexPrompt}\n`}]}]}]}:
      {thread:{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project',status:{type:'idle'}},turns:[{id:'fixture-turn',status:'completed',error:null,items:[{type:'userMessage',id:'fixture-user',content:[{type:'text',text:prompt}]}]}]},
    // The formal creator makes a new thread; it is listed only after creation.
    createCodexThread:async input=>{assert.equal(input.projectId,'fixture-native');assert.equal(input.title,'fixture-project Codex');codexPrompt=input.prompt;codexCreated=true;return {threadId:'fixture-codex'};},
  };
  const host=createWindowsNativeProjectHost({config,native,ui,authorizeInitialization:async(name,workspace,_signal,request)=>{grants.push({...request});assert.equal(name,'fixture-project');assert.equal(workspace,join(config.background.workspaceRoot,name));return true;}});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const provisioner=new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:1000,host});
  const operation=await provisioner.prepare('fixture-project','fixture-init',context);
  assert.equal(operation.state,'READY');assert.deepEqual(calls,['workspace-entry','workspace-create','gpt-create']);
  // One attempt of this operation: the up-front request, then each effect it listed.
  assert.deepEqual(grants.map(grant=>grant.effect),[undefined,'native-workspace','ordinary-gpt','codex-thread']);
  assert.ok(grants.every(grant=>grant.operationId===operation.id && grant.attempt===grants[0].attempt && JSON.stringify(grant.effects)==='["native-workspace","ordinary-gpt","codex-thread"]'));
  assert.equal(codexPrompt,codexInitializationPrompt(operation.id,0));
  assert.equal(scope.db.prepare('SELECT app_project_id FROM conversation_workspaces').get()!.app_project_id,'fixture-native');
  const capabilities=await host.inspect(new AbortController().signal);
  assert.equal(capabilities.background,false);assert.equal(capabilities.actualGenerationParameters,false);
  assert.throws(()=>assertOrdinaryChatCapabilities(capabilities),{code:'UNSUPPORTED'});
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n,0);
});

test('windows native host: a fresh Bridge process restores a crashed project to READY without recreating or resending',async t=>{
  const scope=isolatedDemo();let recovered:typeof scope.db|undefined;
  t.after(()=>{recovered?.close();scope.close();});
  const dbPath=join(scope.root,'demo.sqlite'),state=join(scope.root,'desktop.json');
  const {spawnSync}=await import('node:child_process'),{createDb}=await import('../src/db.ts'),{BackgroundBridge}=await import('../src/background.ts'),{fileDesktop}=await import('./fixtures/native-desktop.ts');
  const url=(path:string)=>JSON.stringify(new URL(path,import.meta.url).href);
  // Process one creates every resource, then exits before verification/READY.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {createDb} from ${url('../src/db.ts')};import {defaults} from ${url('../src/config.ts')};import {CallerAuthority} from ${url('../src/caller.ts')};
    import {ProjectProvisioner} from ${url('../src/project-provisioner.ts')};import {createWindowsNativeProjectHost} from ${url('../src/windows-native-host.ts')};import {fileDesktop} from ${url('./fixtures/native-desktop.ts')};
    const config=defaults(${JSON.stringify(scope.root)}),db=createDb({dbPath:${JSON.stringify(dbPath)}}),authority=new CallerAuthority();
    const context=authority.issue({principal:'fixture:controller',instance:'first',executor:'hermes',controller:true,reviewer:false});
    const host=createWindowsNativeProjectHost({config,...fileDesktop(${JSON.stringify(state)},config),authorizeInitialization:async()=>true});
    host.verifyBundle=async()=>process.exit(75);
    await new ProjectProvisioner(db,authority,{root:config.background.workspaceRoot,timeoutMs:5000,host}).prepare('fixture-project','fixture-init',context);`],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,75,child.stderr);
  const db=recovered=createDb({dbPath}),config=defaults(scope.root);
  const crashed=db.prepare('SELECT * FROM project_operations').get()!,original=JSON.parse(String(crashed.resources));
  assert.equal(crashed.state,'PROVISIONING');assert.equal(crashed.phase,'verify');
  assert.ok(original.appProjectId && original.chatgptConversationId && original.codexConversationId);
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'second',executor:'hermes',controller:true,reviewer:false});
  const bridge=new BackgroundBridge(db,authority,context,config,{});bridge.start();await bridge.shutdown();
  assert.equal(db.prepare('SELECT state FROM project_operations').get()!.state,'UNCERTAIN');
  const desktop=fileDesktop(state,config),host=createWindowsNativeProjectHost({config,native:desktop.native,ui:desktop.ui,authorizeInitialization:async()=>assert.fail('Recovery must not request initialization')});
  const provisioner=new ProjectProvisioner(db,authority,{root:config.background.workspaceRoot,timeoutMs:5000,host});
  const id=String(crashed.id),before=desktop.load();
  // Foreign ownership stays rejected: a same-title GPT without this receipt, then a Codex thread in another project.
  desktop.update(s=>{s.pages[original.chatgptConversationId].turns[0].items[0]={type:'userMessage',id:'foreign',content:[{type:'text',text:'[TEST] foreign same-title chat'}]};});
  assert.equal((await provisioner.reconcile(id,context)).errorCode,'PROVENANCE');
  desktop.update(s=>{s.pages=before.pages;s.threads.find(item=>item.id===original.codexConversationId)!.projectId='native-foreign';});
  assert.equal((await provisioner.reconcile(id,context)).errorCode,'PROVENANCE');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n,0);
  desktop.update(s=>{s.threads=before.threads;});
  const ready=await provisioner.reconcile(id,context);
  assert.equal(ready.state,'READY');assert.deepEqual(ready.resources,original);
  const after=desktop.load();
  assert.deepEqual(after.creates,{workspace:1,gpt:1,codex:1});assert.deepEqual(after.uiCalls,['workspace-create','gpt-create']);
  const mapping=db.prepare('SELECT * FROM conversation_workspaces').get()!;
  assert.equal(mapping.app_project_id,original.appProjectId);assert.equal(mapping.chatgpt_conversation_id,original.chatgptConversationId);
  assert.equal(db.prepare('SELECT conversation_id FROM codex_conversations').get()!.conversation_id,original.codexConversationId);
});

test('windows native host: enabled configuration cannot grant UI initialization',async()=>{
  const config=defaults();config.desktop.enabled=true;let writes=0;
  const ui=new class extends WindowsNativeUi {override async call(){writes++;return {ok:true};}}(config);
  const native={} as WindowsNativeTools;
  const host=createWindowsNativeProjectHost({config,native,ui,authorizeInitialization:async()=>false});
  await assert.rejects(host.createWorkspace('fixture-project','D:\\fixture',new AbortController().signal),{code:'AUTH'});
  await assert.rejects(host.createOrdinaryChat('fixture-native','fixture-project',new AbortController().signal),{code:'PROVENANCE'});
  assert.equal(writes,0);
});

test('windows native host: a lost Codex receipt is recovered only from this operation\'s own initialization prompt in its workspace',async()=>{
 const config=defaults(),signal=new AbortController().signal,key='00000000-0000-4000-8000-000000000001',prompt=codexInitializationPrompt(key,0);let creates=0;
 const thread=(id:string,projectId:string,text:string)=>({row:{id,kind:'codex',title:'same title',projectId,cwd:'D:\\fixture'},page:{thread:{id,kind:'codex',title:'same title',status:{type:'idle'}},turns:[{id:`turn-${id}`,status:'completed',error:null,items:[{type:'userMessage',id:`user-${id}`,content:[{type:'text',text}]}]}]}});
 let threads=[thread('fixture-plain','native-fixture','[TEST] other work'),thread('fixture-foreign','native-other',prompt)];
 const native:WindowsNativeTools={listProjects:async()=>({projects:[]}),listThreads:async()=>({pinnedThreads:[],threads:threads.map(item=>item.row)}),readThread:async id=>threads.find(item=>item.row.id===id)!.page as never,createCodexThread:async()=>{creates++;return {threadId:'unused'};}};
 const host=createWindowsNativeProjectHost({config,native,authorizeInitialization:async()=>false});
 const resources={appProjectId:'native-fixture',name:'fixture',workspacePath:'D:\\fixture',chatgptConversationId:'fixture-gpt',initializationKey:key};
 await assert.rejects(host.observePartial!({...resources,initializationKey:'not-an-operation'},'codex',signal),{code:'UNSUPPORTED'});
 // A same-title thread without the prompt, or the prompt in another workspace, is not a receipt.
 await assert.rejects(host.observePartial!(resources,'codex',signal),{code:'PROVENANCE'});
 threads.push(thread('fixture-original','native-fixture',`${prompt}\n`));
 assert.equal((await host.observePartial!(resources,'codex',signal)).codexConversationId,'fixture-original');
 await assert.rejects(host.observePartial!(resources,'codex.extra',signal),{code:'PROVENANCE'});
 threads.push(thread('fixture-copy','native-fixture',prompt));
 await assert.rejects(host.observePartial!(resources,'codex',signal),{code:'PROVENANCE'});
 threads=threads.slice(0,1);
 assert.equal((await host.observePartial!({...resources,codexConversationId:'fixture-plain'},'codex',signal)).codexConversationId,'fixture-plain');assert.equal(creates,0);
});
// Component fixtures prove ordering and identity gates, not a live desktop send.
test('windows native host: same title with a different UI conversation ID is rejected',async()=>{
  const config=defaults();
  const ui=new class extends WindowsNativeUi {override async call(_op:Parameters<WindowsNativeUi['call']>[0],fields:Parameters<WindowsNativeUi['call']>[1]){
    assert.equal(fields.conversationId,'target-id');
    return {ok:true,snapshot:{title:'same title',text:'',ordinaryComposer:true,pid:1,conversationId:'different-id'}};
  }}(config);
  const native={readThread:async()=>({thread:{id:'target-id',kind:'chatgpt',title:'same title',status:{type:'idle'}},turns:[]})} as unknown as WindowsNativeTools;
  const {ordinaryChat}=createWindowsNativeConversationHost({config,native,ui,authorizeUiOperation:async()=>true});
  await assert.rejects(ordinaryChat.inspectConversation('target-id',new AbortController().signal),{code:'PROVENANCE'});
});

test('windows native host: final body is read after native completion and correlated to the same assistant',async()=>{
  const config=defaults();const calls:string[]=[];let sent=false;
  const prompt='[TEST] requirement';
  const page=()=>({thread:{id:'target-id',kind:'chatgpt',title:'same title',status:{type:'idle'}},turns:[{id:sent?'new-turn':'old-turn',status:'completed',error:null,items:sent?[{type:'userMessage',id:'user',content:[{type:'text',text:prompt}]},{type:'agentMessage',id:'assistant',text:'[reference]'}]:[]}]});
  const native={readThread:async()=>{calls.push(sent?'native-completed':'native-before');return page();}} as unknown as WindowsNativeTools;
  const ui=new class extends WindowsNativeUi {override async call(op:Parameters<WindowsNativeUi['call']>[0],fields:Parameters<WindowsNativeUi['call']>[1]){
    assert.equal(fields.conversationId,'target-id');calls.push(op);
    if(op==='chat-send'){sent=true;return {ok:true,body:'[TEST] partial'};}
    assert.equal(calls.at(-2),'native-completed');
    return {ok:true,conversationId:'target-id',completionVerified:true,body:'[TEST] final body'};
  }}(config);
  const {ordinaryChat}=createWindowsNativeConversationHost({config,native,ui,authorizeUiOperation:async()=>true});
  const result=await ordinaryChat.generate('target-id',prompt,{signal:new AbortController().signal,model:config.agents.chatgpt.model,reasoningEffort:config.agents.chatgpt.reasoningEffort});
  assert.equal(result.content,'[TEST] final body');assert.equal(result.sourceMessageId,'assistant');assert.equal(result.complete,true);assert.equal(result.completionEvidence?.turnId,'new-turn');
  assert.deepEqual(calls,['native-before','chat-send','native-completed','chat-read-reply','native-completed']);
});

test('windows native host: synthetic native completion cannot approve unfinished UI; reconciliation never sends',async()=>{
  const config=defaults();let sends=0;
  const native={readThread:async()=>({thread:{id:'target-id',kind:'chatgpt',title:'same title',status:{type:'idle'}},turns:[{id:'turn',status:'completed',error:null,items:[{type:'userMessage',id:'user',content:[{type:'text',text:'[TEST] request'}]},{type:'agentMessage',id:'assistant',text:'[reference]'}]}]})} as unknown as WindowsNativeTools;
  const ui=new class extends WindowsNativeUi {override async call(op:Parameters<WindowsNativeUi['call']>[0]){if(op==='chat-send')sends++;return {ok:true,conversationId:'target-id',completionVerified:false,body:'[TEST] partial'};}}(config);
  const {ordinaryChat}=createWindowsNativeConversationHost({config,native,ui,authorizeUiOperation:async()=>true});
  await assert.rejects(ordinaryChat.observeGeneration!('target-id','[TEST] request',new AbortController().signal),{code:'PROVENANCE'});
  assert.equal(sends,0);
});

test('windows native host: title-only observer never grants conversation identity',async()=>{
  const config=defaults(),ui=new class extends WindowsNativeUi {override async call(){return {ok:true,snapshot:{title:'same title',text:'',ordinaryComposer:true,pid:1,conversationId:null}};}}(config);
  const {createWindowsNativeGptReader}=await import('../src/windows-native-host.ts');
  const read=createWindowsNativeGptReader(config,undefined,ui);
  const result=await read('requested-id','same title','carrier');
  assert.equal(result.identityStatus,'titleOnly');assert.equal(result.conversationId,null);assert.equal(result.messages.length,0);
  // UIA failures report the failed stage instead of inventing a name.
  const {BridgeError}=await import('../src/errors.ts');
  const missing=new class extends WindowsNativeUi {override async call():Promise<never>{throw new BridgeError('OWNER','Native UI operation failed at chatgpt-window (RuntimeException, line 1)');}}(config);
  const unavailable=await createWindowsNativeGptReader(config,undefined,missing)('requested-id','same title','carrier');
  assert.equal(unavailable.identityStatus,'unavailable');assert.equal(unavailable.browserTitle,'');assert.match(unavailable.reason!,/^OWNER: .*chatgpt-window/);
  const blank=new class extends WindowsNativeUi {override async call(){return {ok:true,snapshot:{title:' ',text:'',ordinaryComposer:true,pid:1,conversationId:null}};}}(config);
  assert.equal((await createWindowsNativeGptReader(config,undefined,blank)('requested-id','same title','carrier')).identityStatus,'unavailable');
});

test('windows native host: legacy ownership comes from recorded Codex membership, never a name match',async()=>{
  const config=defaults(),signal=new AbortController().signal;
  const state={projects:[{projectId:'native-legacy',projectKind:'local',hostId:'local',label:'legacy',path:'D:\\legacy'},{projectId:'native-other',projectKind:'local',hostId:'local',label:'legacy',path:'D:\\other'}],
    threads:[{id:'legacy-codex',kind:'codex',title:'legacy Codex',projectId:'native-legacy',cwd:'D:\\legacy'},{id:'other-codex',kind:'codex',title:'legacy Codex',projectId:'native-other',cwd:'D:\\other'}],
    gpt:{id:'legacy-gpt',kind:'chatgpt',title:'legacy',status:{type:'idle'}}};
  const native:WindowsNativeTools={listProjects:async()=>({projects:state.projects}),listThreads:async()=>({threads:[],pinnedThreads:state.threads}),readThread:async()=>({thread:state.gpt,turns:[]})};
  const host=createWindowsNativeProjectHost({config,native,authorizeInitialization:async()=>assert.fail('Adoption never initializes')});
  const input={name:'legacy',workspacePath:'d:\\LEGACY',chatgptConversationId:'legacy-gpt',codexConversationIds:['legacy-codex']};
  assert.deepEqual(await host.verifyExisting!(input,signal),{appProjectId:'native-legacy'});
  for(const change of [{codexConversationIds:['other-codex']},{codexConversationIds:['legacy-codex','other-codex']},{codexConversationIds:['missing']},{workspacePath:'D:\\other'},{name:'renamed'}])
    await assert.rejects(host.verifyExisting!({...input,...change},signal),{code:'PROVENANCE'},JSON.stringify(change));
  state.gpt={...state.gpt,kind:'codex'};await assert.rejects(host.verifyExisting!(input,signal),{code:'PROVENANCE'});
});

test('windows native host: two Codex conversations are distinct members of the new workspace; stale receipts and duplicate paths are refused',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  const {fileDesktop}=await import('./fixtures/native-desktop.ts'),desktop=fileDesktop(join(scope.root,'desktop.json'),config);
  const host=createWindowsNativeProjectHost({config,...desktop,authorizeInitialization:async()=>true});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const ready=await new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:5000,host}).prepare('two-codex','two-codex',context,{codexConversations:2});
  assert.equal(ready.state,'READY');const state=desktop.load(),codex=state.threads.filter(item=>item.kind==='codex');
  assert.deepEqual(state.creates,{workspace:1,gpt:1,codex:2});assert.deepEqual(codex.map(item=>item.title),['two-codex Codex','two-codex Codex 2']);
  assert.ok(codex.every(item=>item.projectId===ready.resources!.appProjectId && item.cwd===ready.resources!.workspacePath));
  assert.deepEqual([ready.resources!.codexConversationId,...ready.resources!.extraCodexConversationIds!],codex.map(item=>item.id));
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM codex_conversations').get()!.n,2);
  const signal=new AbortController().signal,existing=codex[0].id,appProjectId=ready.resources!.appProjectId!;
  const stale=createWindowsNativeProjectHost({config,native:{...desktop.native,createCodexThread:async()=>({threadId:existing})},ui:desktop.ui,authorizeInitialization:async()=>true});
  const {randomUUID}=await import('node:crypto'),grantFor=(...effects:('native-workspace'|'codex-thread')[])=>({operationId:ready.id,attempt:randomUUID(),effects});
  // Without this attempt's approval for the exact effect nothing is created.
  await assert.rejects(stale.createCodexConversation(appProjectId,ready.resources!.workspacePath!,signal,ready.id,2),{code:'AUTH'});
  await assert.rejects(stale.createCodexConversation(appProjectId,ready.resources!.workspacePath!,signal,ready.id,2,grantFor('native-workspace')),{code:'AUTH'});
  await assert.rejects(stale.createCodexConversation(appProjectId,ready.resources!.workspacePath!,signal,ready.id,2,grantFor('codex-thread')),{code:'PROVENANCE'});
  // An index whose receipt already exists is never created again.
  await assert.rejects(host.createCodexConversation(appProjectId,ready.resources!.workspacePath!,signal,ready.id,1,grantFor('codex-thread')),{code:'CONFLICT'});
  assert.deepEqual((await host.observePartial!({...ready.resources!,extraCodexConversationIds:[]},'codex.extra',signal)).extraCodexConversationIds,[codex[1].id]);
  await assert.rejects(host.createWorkspace('renamed',ready.resources!.workspacePath!,signal),{code:'AUTH'});
  await assert.rejects(host.createWorkspace('renamed',ready.resources!.workspacePath!,signal,grantFor('native-workspace')),{code:'CONFLICT'});
  assert.deepEqual(await host.nativeWorkspaces!(ready.resources!.workspacePath!.toUpperCase(),signal),[{projectId:appProjectId,label:'two-codex'}]);
  assert.equal(desktop.load().creates.workspace,1);
});

test('windows native host: recorded threads outside the recent inventory window are read exactly, never assumed',async()=>{
  const config=defaults(),signal=new AbortController().signal;let read:Record<string,unknown>={id:'old-codex',kind:'codex',title:'legacy Codex',status:{type:'idle'},projectId:'native-old',cwd:'D:\\old'};
  const native:WindowsNativeTools={listProjects:async()=>({projects:[{projectId:'native-old',projectKind:'local',hostId:'local',label:'old',path:'D:\\old'}]}),
    listThreads:async()=>({threads:[],pinnedThreads:[]}),readThread:async()=>({thread:read,turns:[]}) as unknown as Awaited<ReturnType<WindowsNativeTools['readThread']>>};
  const host=createWindowsNativeProjectHost({config,native,authorizeInitialization:async()=>false});
  await host.verifyCodexMember!({appProjectId:'native-old',workspacePath:'d:\\OLD',conversationId:'old-codex'},signal);
  const {executor}=createWindowsNativeConversationHost({config,native,authorizeUiOperation:async()=>false});
  assert.equal((await executor.inspect({codexConversationId:'old-codex',workspacePath:'D:\\old'},signal)).appProjectId,'native-old');
  for(const change of [{projectId:'native-other'},{cwd:'D:\\elsewhere'},{kind:'chatgpt'},{id:'different-id'},{projectId:undefined}]) {
    read={id:'old-codex',kind:'codex',title:'legacy Codex',status:{type:'idle'},projectId:'native-old',cwd:'D:\\old',...change};
    await assert.rejects(host.verifyCodexMember!({appProjectId:'native-old',workspacePath:'D:\\old',conversationId:'old-codex'},signal),{code:'PROVENANCE'},JSON.stringify(change));
  }
});

test('windows native host: a lost create_thread reply is recovered from its receipt; READY adds a second Codex once',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  const {fileDesktop}=await import('./fixtures/native-desktop.ts'),desktop=fileDesktop(join(scope.root,'desktop.json'),config);
  const host=createWindowsNativeProjectHost({config,...desktop,authorizeInitialization:async()=>true});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const provisioner=new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:5000,host});
  desktop.update(state=>{state.failCodexReply=true;});
  const ready=await provisioner.prepare('lost-reply','lost-reply',context);
  assert.equal(ready.state,'READY');assert.equal(desktop.load().creates.codex,1);
  assert.equal(ready.resources!.codexConversationId,desktop.load().threads.find(item=>item.kind==='codex')!.id);
  // The original request asked for one; a second is added to the READY project, verified and registered once.
  desktop.update(state=>{state.failCodexReply=false;});
  const added=await provisioner.createCodex(ready.id,context);
  const codex=desktop.load().threads.filter(item=>item.kind==='codex');
  assert.equal(added.state,'READY');assert.equal(codex.length,2);assert.deepEqual(added.resources!.extraCodexConversationIds,[codex[1].id]);assert.equal(codex[1].title,'lost-reply Codex 2');
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM codex_conversations').get()!.n,2);
  // A lost reply for the added one is recovered on the next call without a second create.
  desktop.update(state=>{state.failCodexReply=true;});
  const third=await provisioner.createCodex(ready.id,context);
  assert.equal(third.stages!.codexConversations,3);assert.equal(desktop.load().creates.codex,3);
});

test('windows native host: a hidden add-project entry blocks creation before approval, directory or UI effect',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  const {fileDesktop}=await import('./fixtures/native-desktop.ts'),desktop=fileDesktop(join(scope.root,'desktop.json'),config);let approvals=0;
  desktop.update(state=>{state.entry={state:'offscreen',count:1,offscreen:true,enabled:true,invoke:true,scrollItem:true,arranged:true};});
  const host=createWindowsNativeProjectHost({config,...desktop,authorizeInitialization:async()=>{approvals++;return true;}});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const blocked=await new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:5000,host}).prepare('hidden-entry','hidden-entry',context);
  assert.equal(blocked.state,'BLOCKED');assert.equal(blocked.errorCode,'STATE');assert.equal(approvals,0);assert.deepEqual(desktop.load().uiCalls,[]);
  assert.match(String(scope.db.prepare("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE '%BLOCKED:STATE%'").get()!.payload),/offscreen/);
  const {existsSync}=await import('node:fs');assert.equal(existsSync(blocked.workspacePath),false);
});

test('windows native host: create_thread refusals before the call are UNSUPPORTED; a reply lost after it is read back',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root),signal=new AbortController().signal;
  const {fileDesktop}=await import('./fixtures/native-desktop.ts'),{BridgeError}=await import('../src/errors.ts'),{randomUUID}=await import('node:crypto');
  const desktop=fileDesktop(join(scope.root,'desktop.json'),config),path='D:\\refusals',key=randomUUID();
  desktop.update(state=>{state.projects.push({projectId:'native-refusals',projectKind:'local',hostId:'local',label:'refusals',path});});
  const attempt={operationId:key,attempt:randomUUID(),effects:['codex-thread' as const]};
  for(const code of ['IPC_CONFIG','INPUT','UNSUPPORTED'] as const) {
    const host=createWindowsNativeProjectHost({config,native:{...desktop.native,createCodexThread:async()=>{throw new BridgeError(code,'[TEST] refused');}},authorizeInitialization:async()=>true});
    await assert.rejects(host.createCodexConversation('native-refusals',path,signal,key,0,attempt),{code:'UNSUPPORTED'},code);
  }
  // The peer check after the reply is not proof of no effect: the receipt is read back.
  const host=createWindowsNativeProjectHost({config,native:{...desktop.native,createCodexThread:async input=>{await desktop.native.createCodexThread!(input,signal);throw new BridgeError('OWNER','[TEST] peer changed after reply');}},authorizeInitialization:async()=>true});
  const created=await host.createCodexConversation('native-refusals',path,signal,key,0,attempt);
  assert.equal(created.conversationId,desktop.load().threads.find(item=>item.kind==='codex')!.id);assert.equal(desktop.load().creates.codex,1);
});
