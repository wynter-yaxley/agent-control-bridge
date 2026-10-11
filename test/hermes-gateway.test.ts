import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { defaults } from '../src/config.ts';
import { BackgroundBridge, type BackgroundHostBindings } from '../src/background.ts';
import { HermesGatewayAdapter } from '../src/hermes-gateway.ts';
import { createBridgeMcpServer } from '../src/mcp-server.ts';
import { NotificationDispatcher } from '../src/notification-delivery.ts';

const event=()=>({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'fixture-event'},event:{sender:{sender_type:'user',sender_id:{open_id:'ou_fixture0001'}},message:{message_id:'om_fixture0001',chat_id:'oc_fixture0001',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'[ISOLATED TEST] 实现一个示例功能'})}}});
function setup(t:{after:(fn:()=>void)=>void}){
  const scope=isolatedDemo();t.after(()=>scope.close());const db=scope.db,authority=new CallerAuthority();
  const context=authority.issue({principal:'fixture:hermes',instance:'gateway',executor:'hermes',controller:true,reviewer:false});
  const reviewer=authority.issue({principal:'fixture:reviewer',instance:'reviewer',executor:null,reviewer:true});
  const worker=authority.issue({principal:'fixture:codex',instance:'worker',executor:'codex',reviewer:false});
  const registry=new ConversationRegistry(db,authority),path=resolve('isolated-gateway-workspace');
  registry.registerProject('fixture-project','isolated-gateway',path,context);
  registry.register({projectId:'fixture-project',appProjectId:'fixture-native-project',workspacePath:path,chatgptConversationId:'fixture-gpt',chatgptConversationName:'isolated-gateway',codexConversationId:'fixture-codex'},context);
  const config=defaults();config.agents.chatgpt={enabled:true,model:'fixture-model',reasoningEffort:'fixture-effort'};config.agents.codex.enabled=true;
  const bridge=new BackgroundBridge(db,authority,context,config);
  const gateway=new HermesGatewayAdapter(bridge,{projectForMessage:identity=>identity.senderOpenId==='ou_fixture0001'&&identity.chatType==='p2p'?'fixture-project':null});
  return {db,authority,context,reviewer,worker,config,path,bridge,gateway};
}
test('Hermes event: trusted routing, message dedupe and changed replay rejection',t=>{
  const f=setup(t),input=event(),first=f.gateway.accept(input);assert.equal(f.gateway.accept(input).requestId,first.requestId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,1);
  input.event.message.content=JSON.stringify({text:'changed'});assert.throws(()=>f.gateway.accept(input),/reused/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,1);
});
test('Hermes event: bot, foreign sender, unauthorized group and role text cannot authorize',t=>{
  const f=setup(t);const bot=event();bot.event.sender.sender_type='app';assert.throws(()=>f.gateway.accept(bot));
  const foreign=event();foreign.event.sender.sender_id.open_id='ou_foreign0001';assert.throws(()=>f.gateway.accept(foreign),/authorized/);
  const group=event();group.event.message.chat_type='group';assert.throws(()=>f.gateway.accept(group),/authorized/);
  const spoof={...event(),controller:true,reviewer:true,source:'chatgpt'};
  const denied=new HermesGatewayAdapter(f.bridge,{projectForMessage:()=>null});assert.throws(()=>denied.accept(spoof),/authorized/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,0);
});
test('Hermes event: named Feishu credentials are refused before persistence',t=>{
  const f=setup(t);
  for(const key of ['app_secret','appSecret','FEISHU_APP_SECRET','tenant_access_token','client_secret']){
    const input=event();input.event.message.content=JSON.stringify({text:JSON.stringify({[key]:'synthetic-credential-value'})});
    assert.throws(()=>f.gateway.accept(input),/Authentication material/);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n,0);
});
test('Hermes/MCP isolated workflow: event -> trusted fixture Prompt -> execution -> independent review -> notification receipt',async t=>{
  const f=setup(t);let executions=0;
  const host:BackgroundHostBindings={executorContext:f.worker,ordinaryChat:{
    inspect:async()=>({source:'application-host',ordinaryChat:true,background:true,exactConversation:true,completeMessages:true,actualGenerationParameters:true,createOrdinaryChat:true,createWorkspace:true,models:['fixture-model'],reasoningEfforts:['fixture-effort']}),
    inspectConversation:async()=>({kind:'ordinary-chat',name:'isolated-gateway',source:'application-navigation',conversationId:'fixture-gpt',projectId:'fixture-native-project',workspacePath:f.path}),
    generate:async()=>({content:'[ISOLATED TEST] Engineering Prompt',sourceMessageId:'fixture-source-message',sourceConversationId:'fixture-gpt',sourceConversationName:'isolated-gateway',actualModel:'fixture-model',actualReasoningEffort:'fixture-effort',complete:true,evidenceSource:'application-host'}),
  },executor:{mode:'mock',inspect:async target=>({source:'codex-app-state',local:true,conversationId:target.codexConversationId,appProjectId:'fixture-native-project',workspacePath:f.path}),execute:async(content,_key,target)=>{executions++;assert.equal(content,'[ISOLATED TEST] Engineering Prompt');return {executionId:'fixture-execution',codexConversationId:target.codexConversationId,workspacePath:target.workspacePath};}}};
  const bridge=new BackgroundBridge(f.db,f.authority,f.context,f.config,host);
  const gateway=new HermesGatewayAdapter(bridge,{projectForMessage:()=> 'fixture-project'}),request=gateway.accept(event());
  await bridge.tick();const pending=bridge.get(request.requestId);assert.equal(pending.state,'WAITING_APPROVAL');assert.equal(executions,1);
  const reviewerBridge=new BackgroundBridge(f.db,f.authority,f.reviewer,f.config);
  assert.throws(()=>createBridgeMcpServer({bridge,db:f.db,authority:f.authority,context:f.reviewer,notificationLeaseMs:1000,version:'0.2.0'}),/same caller/);
  const server=createBridgeMcpServer({bridge:reviewerBridge,db:f.db,authority:f.authority,context:f.reviewer,notificationLeaseMs:1000,version:'0.2.0'});
  const client=new Client({name:'fixture-independent-reviewer',version:'0.0.0'});const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  try{
    const accepted=await client.callTool({name:'acb_review_submit',arguments:{taskId:pending.taskId,expectedVersion:pending.version,pass:true,reason:'Isolated fixture acceptance'}});assert.ok(!accepted.isError);
    assert.equal(bridge.get(request.requestId).state,'SUCCEEDED');
    let sends=0;const dispatcher=new NotificationDispatcher(f.db,f.authority,f.context,{send:async()=>({messageId:`om_fixture000${++sends}`})},{timeoutMs:100,leaseMs:1000,route:()=>({type:'open_id',id:'ou_fixture0001'}),render:payload=>JSON.stringify(payload)});
    const delivered=await dispatcher.flush();assert.equal(delivered.blocked,0);assert.equal(delivered.acknowledged,3);
    assert.deepEqual(await dispatcher.flush(),{acknowledged:0,blocked:0});assert.equal(sends,3);
  }finally{await client.close();await server.close();}
});
