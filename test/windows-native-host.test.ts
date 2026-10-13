import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {isolatedDemo} from '../src/demo-scope.ts';
import {defaults} from '../src/config.ts';
import {CallerAuthority} from '../src/caller.ts';
import {ProjectProvisioner} from '../src/project-provisioner.ts';
import {assertOrdinaryChatCapabilities} from '../src/ordinary-chat.ts';
import {createWindowsNativeProjectHost,createWindowsNativeConversationHost,WindowsNativeUi,type WindowsNativeTools} from '../src/windows-native-host.ts';

test('windows native host: authorized UI identity setup registers READY without generation authority',async t=>{
  const scope=isolatedDemo();t.after(()=>scope.close());const config=defaults(scope.root);
  let path='',prompt='',chatCreated=false,grants=0;const calls:string[]=[];
  const ui=new class extends WindowsNativeUi {
    override async call(operation:Parameters<WindowsNativeUi['call']>[0],fields:Parameters<WindowsNativeUi['call']>[1]) {
      calls.push(operation);
      if(operation==='workspace-create')path=fields.path!;
      if(operation==='gpt-create'){chatCreated=true;prompt=fields.prompt!;}
      return {ok:true,ordinaryModeObserved:operation==='gpt-create'};
    }
  }(config);
  const native:WindowsNativeTools={
    listProjects:async()=>({projects:[{projectId:'fixture-native',projectKind:'local',hostId:'local',label:'fixture-project',path}]}),
    listThreads:async()=>({pinnedThreads:[],threads:[{id:'fixture-codex',kind:'codex',title:'fixture-project Codex',projectId:'fixture-native',cwd:path},...(chatCreated?[{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project'}]:[])]}),
    readThread:async()=>({thread:{id:'fixture-gpt',kind:'chatgpt',title:'fixture-project',status:{type:'idle'}},turns:[{id:'fixture-turn',status:'completed',error:null,items:[{type:'userMessage',id:'fixture-user',content:[{type:'text',text:prompt}]}]}]}),
    createCodexThread:async(projectId)=>{assert.equal(projectId,'fixture-native');return {threadId:'fixture-codex'};},
  };
  const host=createWindowsNativeProjectHost({config,native,ui,authorizeInitialization:async(name,workspace)=>{grants++;assert.equal(name,'fixture-project');assert.equal(workspace,join(config.background.workspaceRoot,name));return true;}});
  const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:controller',instance:'fixture',executor:'hermes',controller:true,reviewer:false});
  const provisioner=new ProjectProvisioner(scope.db,authority,{root:config.background.workspaceRoot,timeoutMs:1000,host});
  const operation=await provisioner.prepare('fixture-project','fixture-init',context);
  assert.equal(operation.state,'READY');assert.equal(grants,1);assert.deepEqual(calls,['workspace-create','gpt-create']);
  assert.equal(scope.db.prepare('SELECT app_project_id FROM conversation_workspaces').get()!.app_project_id,'fixture-native');
  const capabilities=await host.inspect(new AbortController().signal);
  assert.equal(capabilities.background,false);assert.equal(capabilities.actualGenerationParameters,false);
  assert.throws(()=>assertOrdinaryChatCapabilities(capabilities),{code:'UNSUPPORTED'});
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n,0);
});

test('windows native host: enabled configuration cannot grant UI initialization',async()=>{
  const config=defaults();config.desktop.enabled=true;let writes=0;
  const ui=new class extends WindowsNativeUi {override async call(){writes++;return {ok:true};}}(config);
  const native={} as WindowsNativeTools;
  const host=createWindowsNativeProjectHost({config,native,ui,authorizeInitialization:async()=>false});
  await assert.rejects(host.createWorkspace('fixture-project','D:\\fixture',new AbortController().signal),{code:'AUTH'});
  assert.equal(writes,0);
});
test('windows native host: observed Codex editor newline matches once and only final output is returned',async()=>{
  const config=defaults(),path='D:\\fixture-project';let sent=false;
  const ui=new class extends WindowsNativeUi {override async call(){sent=true;return {ok:true};}}(config);
  const native:WindowsNativeTools={
    listProjects:async()=>({projects:[{projectId:'fixture-native',projectKind:'local',hostId:'local',label:'fixture-project',path}]}),
    listThreads:async()=>({pinnedThreads:[],threads:[{id:'fixture-codex',kind:'codex',title:'fixture-project Codex',projectId:'fixture-native',cwd:path}]}),
    readThread:async()=>({thread:{id:'fixture-codex',kind:'codex',title:'fixture-project Codex',status:{type:'idle'}},turns:[{id:sent?'fixture-new':'fixture-old',status:'completed',error:null,items:sent?[{type:'userMessage',id:'fixture-user',content:[{type:'text',text:'[TEST] generated prompt\n'}]},{type:'agentMessage',id:'fixture-progress',text:'[TEST] progress',phase:'commentary'},{type:'agentMessage',id:'fixture-final',text:'[TEST] complete',phase:'final_answer'}]:[]}]}),
  };
  const {executor}=createWindowsNativeConversationHost({config,native,ui,authorizeUiOperation:async()=>true});
  const receipt=await executor.execute('[TEST] generated prompt','fixture-run',{codexConversationId:'fixture-codex',workspacePath:path},new AbortController().signal);
  assert.equal(receipt.executionId,'fixture-new');assert.deepEqual(receipt.output,{content:'[TEST] complete',messageIds:['fixture-final']});
});
