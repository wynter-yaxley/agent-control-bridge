import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { defaults } from '../src/config.ts';
import { BackgroundBridge } from '../src/background.ts';
import { createBridgeMcpServer } from '../src/mcp-server.ts';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, cpSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlledProcessEnv } from '../src/silent-process.ts';
import { ConversationRegistry } from '../src/topology.ts';

test('MCP: actual client handshake, tools discovery, blocked creation and strict source/role rejection', async t => {
  const scope = isolatedDemo(), authority = new CallerAuthority();
  const context = authority.issue({ principal: 'fixture:hermes', instance: 'fixture', executor: 'hermes', controller: true, reviewer: false });
  const bridge = new BackgroundBridge(scope.db, authority, context, defaults());
  const server = createBridgeMcpServer({ bridge, db: scope.db, authority, context, notificationLeaseMs: 30000, version: '0.2.0' });
  const client = new Client({ name: 'fixture-client', version: '0.0.0' });
  t.after(async () => { await client.close(); await server.close(); scope.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('acb_request_submit')); assert.ok(tools.includes('acb_notifications_ack')); assert.ok(!tools.some(name => /prompt_import|source_register|browser/.test(name)));
  assert.ok(tools.includes('acb_codex_target_check'));
  assert.ok(tools.includes('acb_native_target_check'));
  assert.ok(tools.includes('acb_project_reconcile'));
  const status = await client.callTool({ name: 'acb_capabilities', arguments: {} });
  const text = status.content as { type: string; text: string }[];
  assert.equal(JSON.parse(text[0].text).fullWorkflowReady, false);
  const project = await client.callTool({ name: 'acb_project_prepare', arguments: { name: 'fixture project', eventKey: 'fixture-event' } });
  assert.equal(JSON.parse((project.content as { text: string }[])[0].text).state, 'BLOCKED');
  const operationId=JSON.parse((project.content as { text: string }[])[0].text).id;
  const reconcile=await client.callTool({name:'acb_project_reconcile',arguments:{operationId}});
  assert.equal(reconcile.isError,true);assert.equal(JSON.parse((reconcile.content as {text:string}[])[0].text).code,'STATE');
  const suppliedIds=await client.callTool({name:'acb_project_reconcile',arguments:{operationId,chatgptConversationId:'caller-chosen'}});
  assert.equal(suppliedIds.isError,true);
  const spoof = await client.callTool({ name: 'acb_request_submit', arguments: { eventKey: 'fake', projectId: 'fake', title: 'fake', requirement: 'fake', reviewer: true, promptSource: 'chatgpt' } });
  assert.equal(spoof.isError, true); assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM tasks').get()!.n, 0);
});

test('MCP: official Codex inspection is limited to registered project/controller targets', async t => {
  const scope = isolatedDemo(), authority = new CallerAuthority();
  t.after(() => scope.close());
  const controller = authority.issue({ principal: 'fixture:controller', instance: 'controller', executor: 'hermes', controller: true, reviewer: false });
  const other = authority.issue({ principal: 'fixture:other', instance: 'other', executor: 'hermes', controller: true, reviewer: false });
  const registry = new ConversationRegistry(scope.db, authority), path = resolve('fixture-codex-target');
  registry.registerProject('project', 'fixture-codex-target', path, controller);
  registry.register({ projectId: 'project', workspacePath: path, appProjectId: 'native-project', chatgptConversationId: 'fixture-gpt', chatgptConversationName: 'fixture-codex-target', codexConversationId: 'fixture-codex' }, controller);
  const bridge = new BackgroundBridge(scope.db, authority, controller, defaults());
  await assert.rejects(bridge.inspectCodexTarget('project', 'foreign'), (error: unknown) => (error as { code: string }).code === 'AUTH');
  await assert.rejects(new BackgroundBridge(scope.db, authority, other, defaults()).inspectCodexTarget('project', 'fixture-codex'), (error: unknown) => (error as { code: string }).code === 'AUTH');
  await assert.rejects(bridge.inspectCodexTarget('project', 'fixture-codex'), (error: unknown) => (error as { code: string }).code === 'DEPENDENCY');
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM execution_runs').get()!.n, 0);
});

test('MCP: native reads are scoped to the registered carrier/GPT pair and grant no generation capability', async t => {
  const scope=isolatedDemo(),authority=new CallerAuthority();
  t.after(()=>scope.close());
  const context=authority.issue({principal:'fixture:native-controller',instance:'native',executor:'hermes',controller:true,reviewer:false});
  const foreign=authority.issue({principal:'fixture:foreign-controller',instance:'foreign',executor:'hermes',controller:true,reviewer:false});
  const registry=new ConversationRegistry(scope.db,authority),path=resolve('fixture-native-pair');
  registry.registerProject('native-project','fixture-native-pair',path,context);
  registry.register({projectId:'native-project',workspacePath:path,chatgptConversationId:'fixture-gpt',chatgptConversationName:'fixture-native-pair',codexConversationId:'fixture-codex'},context);
  let called=0;
  const host:import('../src/background.ts').BackgroundHostBindings={nativeInspector:async options=>{
    called++;assert.equal(options.carrierThreadId,'fixture-codex');assert.equal(options.conversationId,'fixture-gpt');assert.equal(options.expectedTitle,'fixture-native-pair');assert.ok(options.signal);
    return {ok:true,readOnly:true,peer:undefined,catalogTools:[],carrier:{identityMatches:true,backingKind:'codex',titleMatches:null,threadFields:[],turnFields:[],itemFields:[],turnCount:0,ordinaryChatVerified:false,actualGenerationParametersVerified:false,projectMappingVerified:false},inventory:{currentCarrierVisible:true,chatgptBackingVisible:true},target:null,messagesSent:false,realModelInvoked:false,credentialsRead:false,executionAuthorized:false,fullWorkflowReady:false};
  }};
  const bridge=new BackgroundBridge(scope.db,authority,context,defaults(),host),other=new BackgroundBridge(scope.db,authority,foreign,defaults(),host);
  await assert.rejects(other.inspectNativeTarget('native-project','fixture-codex'),{code:'AUTH'});
  await assert.rejects(bridge.inspectNativeTarget('native-project','foreign-codex'),{code:'AUTH'});assert.equal(called,0);
  const server=createBridgeMcpServer({bridge,db:scope.db,authority,context,notificationLeaseMs:30000,version:'0.2.0'}),client=new Client({name:'native-fixture',version:'0.0.0'});
  t.after(async()=>{await client.close();await server.close();});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  const read=await client.callTool({name:'acb_native_target_check',arguments:{projectId:'native-project',conversationId:'fixture-codex'}});
  assert.equal(read.isError,undefined);assert.equal(JSON.parse((read.content as {text:string}[])[0].text).fullWorkflowReady,false);assert.equal(called,1);
  const spoof=await client.callTool({name:'acb_native_target_check',arguments:{projectId:'native-project',conversationId:'fixture-codex',gptConversationId:'foreign-gpt',callerSource:'chatgpt'}});
  assert.equal(spoof.isError,true);assert.equal(called,1);assert.equal((await bridge.capabilities()).ordinaryChatInstalled,false);
  for(const table of ['tasks','execution_runs','prompts'])assert.equal(scope.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n,0);
});

test('MCP: unresponsive Windows diagnostic host is bounded and cannot start work', async t => {
  const scope=isolatedDemo();t.after(()=>scope.close());const authority=new CallerAuthority();
  const context=authority.issue({principal:'fixture:native-timeout',instance:'timeout',executor:'hermes',controller:true,reviewer:false}),registry=new ConversationRegistry(scope.db,authority),path=resolve('fixture-native-timeout');
  registry.registerProject('project','fixture-native-timeout',path,context);
  registry.register({projectId:'project',workspacePath:path,chatgptConversationId:'fixture-gpt',chatgptConversationName:'fixture-native-timeout',codexConversationId:'fixture-codex'},context);
  const config=defaults();config.nativeInterface.timeoutMs=5;let cancelled=false;
  const bridge=new BackgroundBridge(scope.db,authority,context,config,{nativeInspector:options=>new Promise(()=>{options.signal!.addEventListener('abort',()=>{cancelled=true;});})});
  await assert.rejects(bridge.inspectNativeTarget('project','fixture-codex'),{code:'TIMEOUT'});assert.equal(cancelled,true);
  assert.equal(scope.db.prepare('SELECT COUNT(*) n FROM execution_runs').get()!.n,0);
});

test('MCP: isolated stdio installation starts and closes without a browser, Agent or live policy', async t => {
  const temporaryRoot=resolve(tmpdir()),root=mkdtempSync(join(temporaryRoot,'acb-mcp-fixture-'));
  const client=new Client({name:'fixture-stdio',version:'0.0.0'});
  t.after(async()=>{
    await client.close();
    if(dirname(resolve(root))!==temporaryRoot||!basename(root).startsWith('acb-mcp-fixture-'))throw new Error('Unsafe fixture cleanup');
    try{unlinkSync(join(root,'node_modules'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  });
  cpSync(new URL('../src',import.meta.url),join(root,'src'),{recursive:true});
  cpSync(new URL('../package.json',import.meta.url),join(root,'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'src','mcp.ts'),'--db',join(root,'data','fixture.db')],cwd:root,env:controlledProcessEnv(),stderr:'pipe'});
  let errors='';transport.stderr?.on('data',(value:Buffer)=>{errors+=value.toString();});
  await client.connect(transport,{timeout:30000});
  const status=await client.callTool({name:'acb_capabilities',arguments:{}});
  const result=JSON.parse((status.content as {text:string}[])[0].text);
  assert.equal(result.fullWorkflowReady,false);assert.ok(result.blockers.includes('ORDINARY_CHAT_HOST_MISSING'));
  const denied=await client.callTool({name:'acb_project_prepare',arguments:{name:'fixture',eventKey:'fixture'}});
  assert.equal(denied.isError,true);assert.equal(JSON.parse((denied.content as {text:string}[])[0].text).code,'AUTH');
  assert.ok(!/Unhandled|TypeError|SyntaxError/.test(errors));
});
