import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { defaults } from '../src/config.ts';
import {processOwner} from '../src/db.ts';
import { BackgroundBridge, type BackgroundHostBindings } from '../src/background.ts';
import type { OrdinaryChatCapabilities, OrdinaryChatHost } from '../src/ordinary-chat.ts';
import type { BackgroundExecutor } from '../src/background-runner.ts';
import { NativeChatMessageHost, type NativeChatPage } from '../src/native-messages.ts';
import {BridgeError} from '../src/errors.ts';

export const hostCapabilities: OrdinaryChatCapabilities = { source: 'application-host', ordinaryChat: true, background: true, exactConversation: true, completeMessages: true, actualGenerationParameters: true, createOrdinaryChat: true, createWorkspace: true, models: ['fixture-model'], reasoningEfforts: ['fixture-effort'] };
function setup(t: { after: (fn: () => void) => void }, install = true) {
  const scope = isolatedDemo(); t.after(() => scope.close());
  const db = scope.db, authority = new CallerAuthority();
  const controller = authority.issue({ principal: 'fixture:controller', instance: 'controller', executor: 'hermes', reviewer: false, controller: true });
  const worker = authority.issue({ principal: 'fixture:worker', instance: 'worker', executor: 'codex', reviewer: false });
  const reviewer = authority.issue({ principal: 'fixture:reviewer', instance: 'reviewer', executor: null, reviewer: true });
  const registry = new ConversationRegistry(db, authority), store = new TaskStore(db, authority);
  const config = defaults(); config.agents.chatgpt = { enabled: true, model: 'fixture-model', reasoningEffort: 'fixture-effort' }; config.agents.codex.enabled = true;
  const path = resolve('fixture-project'); registry.registerProject('project', 'fixture-project', path, controller);
  registry.register({ projectId: 'project', workspacePath: path, appProjectId: 'native-project', chatgptConversationId: 'fixture-gpt', chatgptConversationName: 'fixture-project', codexConversationId: 'fixture-codex' }, controller);
  let generated = 0, executed = 0;
  const ordinaryChat: OrdinaryChatHost = {
    inspect: async () => hostCapabilities,
    inspectConversation: async () => ({ kind: 'ordinary-chat', name: 'fixture-project', source: 'application-navigation', conversationId: 'fixture-gpt', projectId: 'native-project', workspacePath: path }),
    generate: async () => { generated++; return { content: '[ISOLATED TEST] engineering prompt', sourceMessageId: 'fixture-message', sourceConversationId: 'fixture-gpt', sourceConversationName: 'fixture-project', actualModel: 'fixture-model', actualReasoningEffort: 'fixture-effort', complete: true, evidenceSource: 'application-host' }; },
  };
  const executor: BackgroundExecutor = {
    mode: 'mock',
    inspect: async target => ({ source: 'codex-app-state', local: true, conversationId: target.codexConversationId, appProjectId: 'native-project', workspacePath: path }),
    execute: async (content, key, target, _signal, onEvent) => {
      executed++; assert.equal(content, '[ISOLATED TEST] engineering prompt');
      const run = db.prepare('SELECT * FROM execution_runs WHERE id=?').get(key)!;
      const task = store.getTask(String(run.task_id))!;
      assert.equal(task.status, 'RUNNING'); assert.equal(task.attempt, 1); assert.equal(task.claimed_by, 'fixture:worker'); assert.equal(task.execution_prompt_id, run.prompt_id);
      onEvent?.({ type: 'thread.started' }); onEvent?.({ type: 'turn.completed' });
      return { executionId: 'fixture-execution', codexConversationId: target.codexConversationId, workspacePath: path };
    },
  };
  const host: BackgroundHostBindings = install ? { ordinaryChat, executor, executorContext: worker } : {};
  const bridge = new BackgroundBridge(db, authority, controller, config, host);
  const submit = (eventKey = 'fixture-feishu-event') => bridge.submit({ eventKey, projectId: 'project', title: 'isolated requirement', requirement: '[TEST] create the feature' });
  return { db, authority, controller, worker, reviewer, store, config, host, ordinaryChat, executor, bridge, submit, generated: () => generated, executed: () => executed };
}
test('background: queued requirement -> trusted ordinary GPT -> claim before execution -> independent acceptance', async t => {
  const f = setup(t); const request = f.submit(); assert.equal(f.submit().requestId, request.requestId);
  assert.equal(await f.bridge.tick(), true); const complete = f.bridge.get(request.requestId);
  assert.equal(complete.state, 'WAITING_APPROVAL'); assert.equal(complete.taskStatus, 'WAITING_APPROVAL'); assert.equal(complete.lastEvent?.kind, 'turn.completed');
  assert.equal(f.generated(), 1); assert.equal(f.executed(), 1); assert.equal(await f.bridge.tick(), false);
  assert.equal(f.store.verify(complete.taskId, f.worker, true, undefined, complete.version).ok, false);
  assert.equal(f.store.verify(complete.taskId, f.reviewer, true, undefined, complete.version).ok, true);
  assert.equal(f.bridge.get(request.requestId).taskStatus, 'SUCCEEDED');
});
test('background: missing host blocks durably; raw requirement never invokes an executor', async t => {
  const f = setup(t, false), request = f.submit(); await f.bridge.tick();
  assert.equal(f.bridge.get(request.requestId).state, 'BLOCKED'); assert.equal(f.bridge.get(request.requestId).taskStatus, 'QUEUED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n, 0); assert.equal(f.executed(), 0);
  assert.equal((await f.bridge.capabilities()).fullWorkflowReady, false);
  assert.equal(await f.bridge.tick(), false);
  assert.throws(() => f.bridge.submit({ eventKey: 'fixture-feishu-event', projectId: 'project', title: 'changed', requirement: 'changed' }), /reused/);
});
test('background: another controller cannot read requests or acknowledge its notifications', async t => {
  const f = setup(t), request = f.submit();
  const other = f.authority.issue({ principal: 'fixture:other', instance: 'other', executor: 'hermes', reviewer: false, controller: true });
  const otherBridge = new BackgroundBridge(f.db, f.authority, other, f.config);
  assert.throws(() => otherBridge.get(request.requestId), /not found/); assert.deepEqual(otherBridge.outbox.pull(other), []);
  assert.throws(() => otherBridge.submit({eventKey:'foreign',projectId:'project',title:'foreign',requirement:'foreign'}),/assigned/);
});
test('background: overlapping polls do not generate or execute twice', async t => {
  const f = setup(t), original = f.ordinaryChat.generate;
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  f.ordinaryChat.generate = async (...args) => { await pending; return original(...args); };
  f.submit(); const first = f.bridge.tick(); await Promise.resolve(); assert.equal(await f.bridge.tick(), false);
  release(); await first; assert.equal(f.generated(), 1); assert.equal(f.executed(), 1);
});
test('background: unknown actual model remains null and permits delivery awaiting independent acceptance', async t => {
  const f = setup(t), original = f.ordinaryChat.generate;
  f.ordinaryChat.generate = async (...args) => ({ ...await original(...args), actualModel: null });
  const request = f.submit(); await f.bridge.tick(); assert.equal(f.bridge.get(request.requestId).state, 'WAITING_APPROVAL'); assert.equal(f.executed(), 1);
  const prompt=f.db.prepare('SELECT verified,actual_model FROM prompts').get()!;
  assert.equal(prompt.verified, 1);assert.equal(prompt.actual_model,null);
});
test('background: switched local execution target is rejected before claim or spawn', async t => {
  const f = setup(t); f.executor.inspect = async target => ({ source: 'codex-app-state', local: false, conversationId: target.codexConversationId, appProjectId: 'other', workspacePath: '/fixture/other' });
  const request = f.submit(); await f.bridge.tick();
  assert.equal(f.executed(), 0); assert.equal(f.bridge.get(request.requestId).taskStatus, 'QUEUED'); assert.equal(f.bridge.get(request.requestId).attempt, 0);
});
test('background: external timeout remains fenced and rejects automatic retry', async t => {
  const f = setup(t); f.config.background.timeoutMs = 15;
  f.executor.execute = async () => new Promise(() => {});
  const request = f.submit(); await f.bridge.tick(); const current = f.bridge.get(request.requestId);
  assert.equal(current.state, 'UNCERTAIN'); assert.equal(current.taskStatus, 'RUNNING');
  assert.throws(() => f.bridge.retryBlocked(request.requestId), /reconciled/);
  assert.equal(await f.bridge.tick(), false); assert.equal(f.db.prepare('SELECT state FROM execution_runs').get()!.state, 'UNCERTAIN');
});
test('background: starting another observer never changes a possibly live task holder', async t => {
  const f = setup(t), request = f.submit(); f.db.prepare("UPDATE background_requests SET state='RUNNING' WHERE id=?").run(request.requestId);
  f.db.prepare("UPDATE background_requests SET owner_token=? WHERE state='RUNNING'").run(processOwner());
  f.bridge.start(); await f.bridge.shutdown();
  assert.equal(f.bridge.get(request.requestId).state, 'RUNNING'); assert.equal(f.executed(), 0);
});

test('background: native message host resolves the registered GPT reply and never executes it', async t => {
  const f = setup(t, false); let reads = 0, sends = 0;
  f.host.chatgptMessages = new NativeChatMessageHost({
    readThread: async input => {
      assert.equal(input.threadId, 'fixture-gpt'); assert.equal(input.maxOutputCharsPerItem, 20000);
      const result: NativeChatPage = { thread: { id: 'fixture-gpt', kind: 'chatgpt', title: 'fixture-project', status: { type: 'idle' } }, turns: [] };
      if (++reads > 1) result.turns.push({ id: 'fixture-turn', status: 'completed', error: null, items: [
        { type: 'userMessage', id: 'fixture-turn', content: [{ type: 'text', text: '[TEST] marker' }] },
        { type: 'agentMessage', id: 'fixture-reply', text: '::chatgpt-content-reference{index="0" source_message_id="fixture-reply"}' },
      ] });
      return result;
    },
    sendMessage: async input => { sends++; assert.deepEqual(input, { threadId: 'fixture-gpt', prompt: '[TEST] marker' }); return { threadId: input.threadId }; },
  });
  f.host.gptReader = async conversationId => ({ source: 'visible-dom', conversationId, browserTitle: 'fixture-project', kind: 'unknown',
    completionVerified: true, actualModel: null, actualReasoningEffort: null, responseInProgress: false,
    messages: [{ role: 'assistant', sourceMessageId: 'fixture-reply', text: '[TEST] reply', hash: 'fixture' }] });
  const result = await f.bridge.sendChatgptMessage('project', '[TEST] marker');
  assert.equal(result.status, 'completed'); assert.equal(result.reply, '[TEST] reply'); assert.equal(result.replySource, 'visible-dom'); assert.equal(sends, 1); assert.equal(f.executed(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM prompts').get()!.n, 0);
});

test('background: completed output is stored and GPT feedback is sent once without accepting the task', async t => {
  const f = setup(t), execute = f.executor.execute; let generations = 0;
  f.executor.execute = async (...args) => ({ ...await execute(...args), output: { content: '[TEST] files changed; tests passed', messageIds: ['fixture-result'] } });
  const generate = f.ordinaryChat.generate;
  f.ordinaryChat.generate = async (...args) => { generations++; return {...await generate(...args),actualModel:null,actualReasoningEffort:null}; };
  const request = f.submit(); await f.bridge.tick();
  assert.equal(generations, 2); assert.equal(f.executed(), 1);
  const result = f.bridge.executionResult(request.requestId);
  assert.equal(result.output?.content, '[TEST] files changed; tests passed'); assert.equal(result.feedbackState, 'COMPLETE');
  assert.equal(result.feedback.actualModel,null);assert.equal(result.feedback.actualReasoningEffort,null);
  await f.bridge.reviewExecution(request.requestId); assert.equal(generations, 2);
  assert.equal(f.bridge.get(request.requestId).taskStatus, 'WAITING_APPROVAL');
});

test('background: unknown GPT feedback keeps the completed execution and is never resent', async t => {
  const f = setup(t), execute = f.executor.execute, generate = f.ordinaryChat.generate; let generations = 0;
  f.executor.execute = async (...args) => ({ ...await execute(...args), output: { content: '[TEST] completed result', messageIds: ['fixture-result'] } });
  f.ordinaryChat.generate = async (...args) => { if (++generations === 2) throw new Error('fixture transport failed'); return generate(...args); };
  const request = f.submit(); await f.bridge.tick();
  assert.equal(f.bridge.executionResult(request.requestId).feedbackState, 'UNCERTAIN');
  assert.equal(f.bridge.get(request.requestId).taskStatus, 'WAITING_APPROVAL');
  await assert.rejects(f.bridge.reviewExecution(request.requestId), { code: 'CONFLICT' });
  assert.equal(generations, 2); assert.equal(f.executed(), 1);
});
test('background: lost execution receipt is read back without rerunning and completes GPT feedback',async t=>{
  const f=setup(t),execute=f.executor.execute;let receipt:Awaited<ReturnType<typeof execute>>;
  f.executor.execute=async(...args)=>{args[4]?.({type:'turn.started',turnId:'fixture-execution'});receipt={...await execute(...args),output:{content:'[TEST] completed before receipt loss',messageIds:['fixture-final']}};throw new BridgeError('IO','fixture receipt lost');};
  f.executor.observeExecution=async(content,_target,startedAfter,_signal,original)=>{assert.equal(content,'[ISOLATED TEST] engineering prompt');assert.ok(Date.parse(startedAfter));assert.equal(original?.executionId,'fixture-execution');return receipt;};
  const request=f.submit();await f.bridge.tick();assert.equal(f.bridge.get(request.requestId).state,'UNCERTAIN');
  const {spawnSync}=await import('node:child_process');
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {processOwner} from ${JSON.stringify(new URL('../src/db.ts',import.meta.url).href)};console.log(processOwner());`],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0);
  f.db.prepare("UPDATE background_requests SET state='RUNNING',owner_token=? WHERE id=?").run(child.stdout.trim(),request.requestId);
  f.db.prepare("UPDATE execution_runs SET state='RUNNING',owner_token=?").run(child.stdout.trim());
  f.db.prepare("UPDATE tasks SET claim_expires_at='2000-01-01' WHERE id=?").run(request.taskId);
  f.bridge.start();await f.bridge.shutdown();assert.equal(f.bridge.get(request.requestId).state,'UNCERTAIN');
  await f.bridge.reconcileExecution(request.requestId);
  assert.equal(f.executed(),1);assert.equal(f.generated(),2);assert.equal(f.bridge.get(request.requestId).taskStatus,'WAITING_APPROVAL');
  assert.equal(f.bridge.executionResult(request.requestId).feedbackState,'COMPLETE');
});

test('background: scoped UI text is captured before pair diagnostics without generation authority',async t=>{
  const f=setup(t,false);
  const order:string[]=[];
  f.host.nativeInspector=async()=>{order.push('diagnostic');return {target:{identityMatches:true,backingKind:'chatgpt',titleMatches:true}} as any;};
  f.host.gptReader=async()=>{throw new BridgeError('UNSUPPORTED','Current-instance CDP unavailable');};
  f.host.gptUiReader=async(id,name,carrier)=>{
    order.push('ui');
    assert.equal(id,'fixture-gpt');assert.equal(name,'fixture-project');assert.equal(carrier,'fixture-codex');
    return {source:'windows-uia',conversationId:id,browserTitle:name,kind:'unknown',completionVerified:true,actualModel:null,actualReasoningEffort:null,responseInProgress:false,messages:[{role:'assistant',text:'fixture reply',sourceMessageId:'fixture-message',hash:'fixture'}]};
  };
  const observed=await f.bridge.readGptMessages('project','fixture-codex');
  assert.deepEqual(order,['ui','diagnostic']);
  assert.equal(observed.visible.source,'windows-uia');assert.equal(observed.executionAuthorized,false);assert.equal(f.executed(),0);
});

test('background: dead generation/project owners become reconcilable and another workspace continues',async t=>{
 const f=setup(t),old=f.submit('old-request');
 const {spawnSync}=await import('node:child_process');
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {processOwner} from ${JSON.stringify(new URL('../src/db.ts',import.meta.url).href)};console.log(processOwner());`],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0);
 const dead=child.stdout.trim();f.db.prepare("UPDATE background_requests SET state='GENERATING',owner_token=? WHERE id=?").run(dead,old.requestId);
 f.db.prepare("INSERT INTO prompt_generation_ops(task_id,request_hash,state,created_at) VALUES(?,?,'GENERATING','2000')").run(old.taskId,'original-hash');
 f.db.prepare("INSERT INTO project_operations(id,principal,event_key,request_hash,project_id,name,root_path,state,owner_token,phase,created_at,updated_at) VALUES('interrupted','fixture:controller','init','hash','pending','pending','fixture-pending','PROVISIONING',?,'workspace','2000','2000')").run(dead);
 f.bridge.start();await f.bridge.shutdown();assert.equal(f.bridge.get(old.requestId).state,'UNCERTAIN');assert.equal(f.db.prepare('SELECT state FROM project_operations').get()!.state,'UNCERTAIN');assert.equal(f.generated(),0);
 const registry=new ConversationRegistry(f.db,f.authority),path=resolve('other-fixture-project');registry.registerProject('other','other-fixture-project',path,f.controller);
 registry.register({projectId:'other',workspacePath:path,appProjectId:'native-other',chatgptConversationId:'gpt-other',chatgptConversationName:'other-fixture-project',codexConversationId:'codex-other'},f.controller);
 const request=f.bridge.submit({eventKey:'other-task',projectId:'other',title:'fixture',requirement:'[TEST] other',codexConversationId:'codex-other'});
 const {promptHash}=await import('../src/prompts.ts');
 f.db.prepare("INSERT INTO prompts(id,task_id,source,requested_model,requested_reasoning,generated_at,prompt_hash,content,source_message_id,verified,delivery_status,source_conversation_id) VALUES('prepared',?,'mock-chatgpt','fixture','fixture','2000',?,'[ISOLATED TEST] engineering prompt','fixture-message',1,'PENDING','gpt-other')").run(request.taskId,promptHash('[ISOLATED TEST] engineering prompt'));
 f.executor.inspect=async target=>({source:'codex-app-state',local:true,conversationId:target.codexConversationId,appProjectId:'native-other',workspacePath:path});
 const originalExecute=f.executor.execute;f.executor.execute=async(...args)=>({...await originalExecute(...args),workspacePath:path});
 delete f.host.ordinaryChat;
 assert.equal(await f.bridge.tick(),true);assert.equal(f.bridge.get(request.requestId).state,'WAITING_APPROVAL');assert.equal(f.executed(),1);assert.equal(f.generated(),0);
 await assert.rejects(async()=>f.bridge.submit({eventKey:'wrong',projectId:'other',title:'fixture',requirement:'fixture',codexConversationId:'fixture-codex'}),{code:'PROVENANCE'});
});

test('background: durable execution survives MCP disconnect, renews its lease and is never resent',async t=>{
 const f=setup(t);f.config.background.timeoutMs=20;f.config.background.leaseSeconds=1;
 let done!:()=>void;const gate=new Promise<void>(resolve=>done=resolve);
 Object.assign(f.executor,{durable:true});
 const execute=f.executor.execute;f.executor.execute=async(...args)=>{args[4]?.({type:'turn.started',turnId:'fixture-execution'});await gate;return execute(...args);};
 const request=f.submit('durable');
 const {createBridgeMcpServer}=await import('../src/mcp-server.ts'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const client=new Client({name:'isolated',version:'0.0.0'}),server=createBridgeMcpServer({bridge:f.bridge,db:f.db,authority:f.authority,context:f.controller,notificationLeaseMs:1000,version:'0.2.0'});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);
 const running=f.bridge.tick();await new Promise(resolve=>setTimeout(resolve,50));await client.close();await server.close();
 assert.equal(f.bridge.get(request.requestId).state,'RUNNING');const before=f.db.prepare('SELECT claim_expires_at FROM tasks WHERE id=?').get(request.taskId)!.claim_expires_at;
 await new Promise(resolve=>setTimeout(resolve,1100));const after=f.db.prepare('SELECT claim_expires_at FROM tasks WHERE id=?').get(request.taskId)!.claim_expires_at;assert.ok(String(after)>String(before));
 done();await running;assert.equal(f.executed(),1);assert.equal(f.bridge.get(request.requestId).state,'WAITING_APPROVAL');assert.equal(f.db.prepare('SELECT execution_id FROM execution_runs').get()!.execution_id,'fixture-execution');
});
