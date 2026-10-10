import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, now } from '../src/db.ts';
import { CallerAuthority, type CallerContext } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { assertLocalCodexEvidence, assertProjectRouteEvidence, PromptPipeline, type ExecutionEvidence } from '../src/prompts.ts';
import { resolve } from 'node:path';
function fixture(t: {after:(fn:()=>void)=>void}) {
 const db=createDb({dbPath:':memory:'});t.after(()=>db.close());const authority=new CallerAuthority();
 const controller=authority.issue({principal:'test:controller',instance:'one',executor:'hermes',reviewer:true});
 for(const id of ['project-a','project-b']) db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run(id,id,resolve(id),'test',now(),now());
 const registry=new ConversationRegistry(db,authority),store=new TaskStore(db,authority);
 const mapping={projectId:'project-a',workspacePath:resolve('project-a'),chatgptConversationId:'test-gpt-a',chatgptConversationName:'project-a',codexConversationId:'test-codex-a'};
 return {db,authority,controller,registry,store,mapping};
}
test('topology: one workspace + one GPT conversation + N Codex conversations; immutable mapping',t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);f.registry.register({...f.mapping,codexConversationId:'test-codex-a2'},f.controller);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM codex_conversations').get()!.n,2);
 for(const mapping of [{...f.mapping,workspacePath:'other'},{...f.mapping,chatgptConversationId:'other'}]) assert.throws(()=>f.registry.register(mapping,f.controller),/exactly one|registered project root/);
 assert.throws(()=>f.registry.register({...f.mapping,projectId:'project-b',workspacePath:'project-b',chatgptConversationId:'gpt-b',chatgptConversationName:'project-b'},f.controller),/another project/);
});
test('topology: worker/JSON role cannot register and foreign receipts are refused',t=>{
 const f=fixture(t);assert.throws(()=>f.registry.register(f.mapping,{reviewer:true} as unknown as CallerContext),/context/);
 f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'mapped',projectId:'project-a',executor:'codex'},f.controller);
 f.registry.assertExecution(task.id,'test-codex-a',resolve('project-a'));
 assert.throws(()=>f.registry.assertExecution(task.id,'other',resolve('project-a')),/receipt/);
 assert.throws(()=>f.registry.assertExecution(task.id,'test-codex-a',resolve('project-b')),/receipt/);
});
test('topology: production generation and delivery check both conversation endpoints',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'trusted-host fixture',projectId:'project-a',executor:'codex'},f.controller);
 let conversation='wrong';const target={codexConversationId:'test-codex-a',workspacePath:resolve('project-a')};
 const evidence:ExecutionEvidence={surface:'codex-desktop',modeAttribute:'codex-local',conversationId:'test-codex-a',projectId:'project-a',workspacePath:resolve('project-a'),composerState:'ready',codexAppState:{source:'codex-app-state',threadId:'test-codex-a',projectId:'project-a',workspacePath:resolve('project-a')}};
 const pipeline=new PromptPipeline(f.db,f.authority,{source:'chatgpt',conversationId:'test-gpt-a',conversationName:'project-a',preflight:async()=>({source:'application-navigation',conversationId:'test-gpt-a',projectId:'project-a',workspacePath:resolve('project-a')}),capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>({content:'[TEST ADAPTER] prompt',sourceConversationId:conversation,sourceConversationName:'project-a',sourceMessageId:'test-message',actualModel:'test-model',actualReasoningEffort:'test-effort'})},{model:'test-model',reasoningEffort:'test-effort'},{target:async()=>target,preflight:async()=>evidence,deliver:async()=>({executionId:'test-receipt',codexConversationId:'test-codex-a',workspacePath:resolve('project-a')})});
 await assert.rejects(()=>pipeline.generate(task.id,'requirement',f.controller),/another GPT/);conversation='test-gpt-a';const id=await pipeline.generate(task.id,'requirement',f.controller);await pipeline.deliver(id,f.controller);
 assert.equal(f.db.prepare('SELECT source_conversation_id,codex_conversation_id FROM prompts WHERE id=?').get(id)!.source_conversation_id,'test-gpt-a');
 const unbound=f.store.createTask({kind:'test',title:'unbound',executor:'codex'},f.controller);await assert.rejects(()=>pipeline.generate(unbound.id,'requirement',f.controller),/registered/);
});
test('topology: project GPT generation requires current app-side route evidence before sending',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'project route guard',projectId:'project-a',executor:'codex'},f.controller);let generated=false;
 const adapter={source:'chatgpt' as const,conversationId:'test-gpt-a',conversationName:'project-a',
   preflight:async()=>({source:'application-navigation' as const,conversationId:'test-gpt-a',projectId:null,workspacePath:null,listKind:'recent' as const}),
   capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),
   generate:async()=>{generated=true;return{content:'unsafe',sourceMessageId:'x',actualModel:'test-model',actualReasoningEffort:'test-effort'};}};
 const pipeline=new PromptPipeline(f.db,f.authority,adapter,{model:'test-model',reasoningEffort:'test-effort'},{deliver:async()=>({executionId:'unused'})});
 await assert.rejects(()=>pipeline.generate(task.id,'requirement',f.controller),/Recent without verified application ownership/);assert.equal(generated,false);
});
test('topology: project GPT generation without route preflight is refused',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'missing route preflight',projectId:'project-a',executor:'codex'},f.controller);let generated=false;
 const pipeline=new PromptPipeline(f.db,f.authority,{source:'chatgpt',conversationId:'test-gpt-a',conversationName:'project-a',capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>{generated=true;throw new Error();}},{model:'test-model',reasoningEffort:'test-effort'},{deliver:async()=>({executionId:'unused'})});
 await assert.rejects(()=>pipeline.generate(task.id,'requirement',f.controller),/no app-side project route preflight/);assert.equal(generated,false);
});
test('topology: cloud Work, unknown evidence, path conflict, and target switch are blocked before production delivery',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'guarded target',projectId:'project-a',executor:'codex'},f.controller);
 const target={codexConversationId:'test-codex-a',workspacePath:resolve('project-a')};
 const source={source:'chatgpt' as const,conversationId:'test-gpt-a',conversationName:'project-a',preflight:async()=>({source:'application-navigation' as const,conversationId:'test-gpt-a',projectId:'project-a',workspacePath:resolve('project-a')}),capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>({content:'[TEST ADAPTER] guarded prompt',sourceConversationId:'test-gpt-a',sourceConversationName:'project-a',sourceMessageId:'test-message',actualModel:'test-model',actualReasoningEffort:'test-effort'})};
 let count=0;const delivery={target:async()=>target,preflight:async()=>({surface:'chatgpt-web' as const,modeAttribute:'work-cloud' as const,conversationId:'test-codex-a',projectId:'project-a',workspacePath:'/mnt/data',composerState:'missing' as const}),deliver:async()=>{count++;return{executionId:'should-not-send'};}};
 const pipeline=new PromptPipeline(f.db,f.authority,source,{model:'test-model',reasoningEffort:'test-effort'},delivery);
 const id=await pipeline.generate(task.id,'requirement',f.controller);await assert.rejects(()=>pipeline.deliver(id,f.controller),/Cloud Work/);assert.equal(count,0);assert.equal(f.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'PENDING');
});
test('topology: execution mode switching to Work during the second preflight stays before DELIVERING',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'execution state switch',projectId:'project-a',executor:'codex'},f.controller);let count=0,checks=0;
 const target={codexConversationId:'test-codex-a',workspacePath:resolve('project-a')};
 const local:ExecutionEvidence={surface:'codex-desktop',modeAttribute:'codex-local',conversationId:target.codexConversationId,projectId:'project-a',workspacePath:target.workspacePath,composerState:'ready',codexAppState:{source:'codex-app-state',threadId:target.codexConversationId,projectId:'project-a',workspacePath:target.workspacePath}};
 const work:ExecutionEvidence={...local,surface:'chatgpt-web',modeAttribute:'work-cloud',workspacePath:'/mnt/data'};
 const pipeline=new PromptPipeline(f.db,f.authority,{source:'chatgpt',conversationId:'test-gpt-a',conversationName:'project-a',preflight:async()=>({source:'application-navigation',conversationId:'test-gpt-a',projectId:'project-a',workspacePath:resolve('project-a')}),capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>({content:'[TEST ADAPTER] prompt',sourceConversationId:'test-gpt-a',sourceConversationName:'project-a',sourceMessageId:'test-message',actualModel:'test-model',actualReasoningEffort:'test-effort'})},{model:'test-model',reasoningEffort:'test-effort'},{target:async()=>target,preflight:async()=>++checks===1?local:work,deliver:async()=>{count++;return{executionId:'unsafe'};}});
 const id=await pipeline.generate(task.id,'requirement',f.controller);await assert.rejects(()=>pipeline.deliver(id,f.controller),/Cloud Work/);assert.equal(count,0);assert.equal(f.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'PENDING');
});
test('topology: production transport without preflight is refused before send',async t=>{
 const f=fixture(t);f.registry.register(f.mapping,f.controller);const task=f.store.createTask({kind:'test',title:'missing preflight',projectId:'project-a',executor:'codex'},f.controller);let count=0;
 const pipeline=new PromptPipeline(f.db,f.authority,{source:'chatgpt',conversationId:'test-gpt-a',conversationName:'project-a',preflight:async()=>({source:'application-navigation',conversationId:'test-gpt-a',projectId:'project-a',workspacePath:resolve('project-a')}),capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>({content:'[TEST ADAPTER] prompt',sourceConversationId:'test-gpt-a',sourceConversationName:'project-a',sourceMessageId:'test-message',actualModel:'test-model',actualReasoningEffort:'test-effort'})},{model:'test-model',reasoningEffort:'test-effort'},{target:async()=>({codexConversationId:'test-codex-a',workspacePath:resolve('project-a')}),deliver:async()=>{count++;return{executionId:'unsafe'};}});
 const id=await pipeline.generate(task.id,'requirement',f.controller);await assert.rejects(()=>pipeline.deliver(id,f.controller),/no local execution preflight/);assert.equal(count,0);assert.equal(f.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'PENDING');
});
test('topology: local execution evidence must agree on surface, mode, thread, project, and workspace',()=>{
 const mapping={project_id:'project-a',workspace_path:resolve('project-a')};const target={codexConversationId:'thread-a',workspacePath:resolve('project-a')};
 const valid:ExecutionEvidence={surface:'codex-desktop',modeAttribute:'codex-local',conversationId:'thread-a',projectId:'project-a',workspacePath:resolve('project-a'),composerState:'ready',codexAppState:{source:'codex-app-state',threadId:'thread-a',projectId:'project-a',workspacePath:resolve('project-a')}};
 assert.doesNotThrow(()=>assertLocalCodexEvidence(mapping,target,valid));
 assert.doesNotThrow(()=>assertLocalCodexEvidence(mapping,target,{...valid,modeAttribute:null}));
 for(const evidence of [{...valid,modeAttribute:'work-cloud' as const},{...valid,surface:'unknown' as const},{...valid,workspacePath:'/mnt/data'},{...valid,codexAppState:{...valid.codexAppState!,workspacePath:'/mnt/data'}},{...valid,composerState:'missing' as const},{...valid,modeAttribute:null,badgeText:'Work'}]) assert.throws(()=>assertLocalCodexEvidence(mapping,target,evidence));
});
test('topology: project ownership without matching application workspace evidence is refused',()=>{
 const mapping={project_id:'project-a',workspace_path:resolve('project-a'),chatgpt_conversation_id:'chat-a'};
 assert.throws(()=>assertProjectRouteEvidence(mapping,{source:'application-navigation',conversationId:'chat-a',projectId:'project-a',workspacePath:null}),/workspace conflicts/);
});
test('topology: GPT prompt conversation must have the exact workspace project name',t=>{
 const f=fixture(t);assert.throws(()=>f.registry.register({...f.mapping,chatgptConversationName:'another project'},f.controller),/name must/);
 assert.throws(()=>f.registry.register({...f.mapping,chatgptConversationName:'Project-a'},f.controller),/name must/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n,0);
 f.registry.register(f.mapping,f.controller);
 assert.equal(f.db.prepare('SELECT chatgpt_conversation_name FROM conversation_workspaces').get()!.chatgpt_conversation_name,'project-a');
});
