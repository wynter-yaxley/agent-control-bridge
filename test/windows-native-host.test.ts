import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {isolatedDemo} from '../src/demo-scope.ts';
import {defaults} from '../src/config.ts';
import {CallerAuthority} from '../src/caller.ts';
import {ProjectProvisioner} from '../src/project-provisioner.ts';
import {assertOrdinaryChatCapabilities} from '../src/ordinary-chat.ts';
import {createWindowsNativeProjectHost,createWindowsNativeConversationHost,WindowsNativeUi,type WindowsNativeTools} from '../src/windows-native-host.ts';

test('windows native host: authorized UI identity setup registers pinned Codex READY without generation authority',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  let path='',prompt='',chatCreated=false,grants=0;const calls:string[]=[];
  const ui=new class extends WindowsNativeUi {
    override async call(operation:Parameters<WindowsNativeUi['call']>[0],fields:Parameters<WindowsNativeUi['call']>[1]) {
      calls.push(operation);
      if(operation==='workspace-create')path=fields.path!;
      if(operation==='gpt-create'){chatCreated=true;prompt=fields.prompt!;}
      return {ok:true,ordinaryModeObserved:operation==='gpt-create',conversationId:'fixture-gpt'};
    }
  }(config);
  const native:WindowsNativeTools={
    listProjects:async()=>({projects:[{projectId:'fixture-native',projectKind:'local',hostId:'local',label:'fixture-project',path}]}),
    listThreads:async()=>({pinnedThreads:[{id:'fixture-codex',kind:'codex',title:'fixture-project Codex',projectId:'fixture-native',cwd:path}],threads:[...(chatCreated?[{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project'}]:[])]}),
    readThread:async()=>({thread:{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project',status:{type:'idle'}},turns:[{id:'fixture-turn',status:'completed',error:null,items:[{type:'userMessage',id:'fixture-user',content:[{type:'text',text:prompt}]}]}]}),
    createCodexThread:async(projectId)=>{assert.equal(projectId,'fixture-native');return {threadId:'fixture-codex'};},
  };
  const host=createWindowsNativeProjectHost({config,native,ui,authorizeInitialization:async(name,workspace)=>{grants++;assert.equal(name,'fixture-project');assert.equal(workspace,join(config.background.workspaceRoot,name));return true;}});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const provisioner=new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:1000,host});
  const operation=await provisioner.prepare('fixture-project','fixture-init',context);
  assert.equal(operation.state,'READY');assert.equal(grants,3);assert.deepEqual(calls,['workspace-create','gpt-create']);
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

test('windows native host: Codex recovery needs a recorded formal ID, not a fabricated initialization marker',async()=>{
 const config=defaults();let bodies=0,creates=0;
 const native:WindowsNativeTools={listProjects:async()=>({projects:[]}),listThreads:async()=>({pinnedThreads:[],threads:[{id:'fixture-original',kind:'codex',title:'same title',projectId:'native-fixture',cwd:'D:\\fixture'},{id:'fixture-other',kind:'codex',title:'same title',projectId:'native-fixture',cwd:'D:\\fixture'}]}),readThread:async()=>{bodies++;throw new Error('No probe body should be read');},createCodexThread:async()=>{creates++;return {threadId:'unused'};}};
 const host=createWindowsNativeProjectHost({config,native,authorizeInitialization:async()=>false});
 const resources={appProjectId:'native-fixture',name:'fixture',workspacePath:'D:\\fixture',chatgptConversationId:'fixture-gpt',initializationKey:'fixture-operation'};
 await assert.rejects(host.observePartial!(resources,'codex',new AbortController().signal),{code:'UNSUPPORTED'});
 const result=await host.observePartial!({...resources,codexConversationId:'fixture-original'},'codex',new AbortController().signal);
 assert.equal(result.codexConversationId,'fixture-original');assert.equal(bodies,0);assert.equal(creates,0);
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
