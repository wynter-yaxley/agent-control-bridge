import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, now } from '../src/db.ts';
import { CallerAuthority, type CallerContext } from '../src/caller.ts';
import { ConversationRegistry } from '../src/topology.ts';
import { TaskStore } from '../src/tasks.ts';
import { PromptPipeline } from '../src/prompts.ts';
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
 let conversation='wrong';const pipeline=new PromptPipeline(f.db,f.authority,{source:'chatgpt',conversationId:'test-gpt-a',conversationName:'project-a',capabilities:async()=>({verified:true,models:['test-model'],reasoningEfforts:['test-effort']}),generate:async()=>({content:'[TEST ADAPTER] prompt',sourceConversationId:conversation,sourceConversationName:'project-a',sourceMessageId:'test-message',actualModel:'test-model',actualReasoningEffort:'test-effort'})},{model:'test-model',reasoningEffort:'test-effort'},{target:async()=>({codexConversationId:'test-codex-a',workspacePath:resolve('project-a')}),deliver:async()=>({executionId:'test-receipt',codexConversationId:'test-codex-a',workspacePath:resolve('project-a')})});
 await assert.rejects(()=>pipeline.generate(task.id,'requirement',f.controller),/another GPT/);conversation='test-gpt-a';const id=await pipeline.generate(task.id,'requirement',f.controller);await pipeline.deliver(id,f.controller);
 assert.equal(f.db.prepare('SELECT source_conversation_id,codex_conversation_id FROM prompts WHERE id=?').get(id)!.source_conversation_id,'test-gpt-a');
 const unbound=f.store.createTask({kind:'test',title:'unbound',executor:'codex'},f.controller);await assert.rejects(()=>pipeline.generate(unbound.id,'requirement',f.controller),/registered/);
});
test('topology: GPT prompt conversation must have the exact workspace project name',t=>{
 const f=fixture(t);assert.throws(()=>f.registry.register({...f.mapping,chatgptConversationName:'another project'},f.controller),/name must/);
 assert.throws(()=>f.registry.register({...f.mapping,chatgptConversationName:'Project-a'},f.controller),/name must/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversation_workspaces').get()!.n,0);
 f.registry.register(f.mapping,f.controller);
 assert.equal(f.db.prepare('SELECT chatgpt_conversation_name FROM conversation_workspaces').get()!.chatgpt_conversation_name,'project-a');
});
