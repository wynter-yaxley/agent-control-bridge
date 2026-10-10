import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority, type CallerContext } from '../src/caller.ts';
import { TaskStore } from '../src/tasks.ts';
import { PromptPipeline, type ChatgptAdapter } from '../src/prompts.ts';
import { createDb } from '../src/db.ts';
function setup(t:{after:(fn:()=>void)=>void}, adapter?:ChatgptAdapter, failure=false) {
 const scope=isolatedDemo();t.after(()=>scope.close());const authority=new CallerAuthority(),store=new TaskStore(scope.db,authority);
 const controller=authority.issue({principal:'mock:controller',instance:'controller',executor:'hermes',reviewer:true});const worker=authority.issue({principal:'mock:worker',instance:'worker',executor:'codex',reviewer:false});
 const task=store.createTask({kind:'test',title:'explicit mock prompt test',executor:'codex'},controller);let count=0;
 const source:ChatgptAdapter=adapter??{source:'mock-chatgpt',capabilities:async()=>({verified:true,models:['gpt-6'],reasoningEfforts:['high']}),generate:async()=>({content:'[MOCK TEST DATA] deterministic engineering prompt',sourceMessageId:'mock-1',actualModel:'mock:gpt-6',actualReasoningEffort:'mock:high'})};
 const pipeline=new PromptPipeline(scope.db,authority,source,{model:'gpt-6',reasoningEffort:'high'},{deliver:async()=>{count++;if(failure)throw new Error('synthetic failure');return{executionId:'mock-execution'};}});
 return {scope,authority,store,controller,worker,task,pipeline,count:()=>count};
}
test('prompt: trusted mock generation, stored hash, idempotent delivery and gated Codex claim',async t=>{
 const f=setup(t);assert.equal(f.store.claim(f.task.id,f.worker,600,0).ok,false);const id=await f.pipeline.generate(f.task.id,'test requirement',f.controller);
 const row=f.scope.db.prepare('SELECT * FROM prompts WHERE id=?').get(id)!;assert.equal(row.source,'mock-chatgpt');assert.equal(row.actual_model,'mock:gpt-6');
 await f.pipeline.deliver(id,f.controller);await f.pipeline.deliver(id,f.controller);assert.equal(f.count(),1);assert.equal(f.store.claim(f.task.id,f.worker,600,0).ok,true);
});
test('prompt: ordinary worker and JSON source/context cannot mint provenance',async t=>{
 const f=setup(t);await assert.rejects(()=>f.pipeline.generate(f.task.id,'requirement',f.worker),/context/);
 await assert.rejects(()=>f.pipeline.generate(f.task.id,'requirement',{source:'chatgpt',reviewer:true} as unknown as CallerContext),/context/);
 await assert.rejects(()=>f.pipeline.deliver('self-declared-chatgpt',f.controller),/record/);
});
test('prompt: content tampering rejected before transport, including after delivery',async t=>{
 const f=setup(t);const id=await f.pipeline.generate(f.task.id,'requirement',f.controller);await f.pipeline.deliver(id,f.controller);
 f.scope.db.prepare("UPDATE prompts SET content='tampered' WHERE id=?").run(id);await assert.rejects(()=>f.pipeline.deliver(id,f.controller),/modified/);assert.equal(f.store.claim(f.task.id,f.worker,600,0).ok,false);assert.equal(f.count(),1);
});
for(const cap of [{verified:false,models:['gpt-6'],reasoningEfforts:['high']},{verified:true,models:['other'],reasoningEfforts:['high']},{verified:true,models:['gpt-6'],reasoningEfforts:['low']}])test('prompt: unsupported or unverified capabilities refuse generation',async t=>{
 let generated=false;const f=setup(t,{source:'mock-chatgpt',capabilities:async()=>cap,generate:async()=>{generated=true;throw new Error();}});await assert.rejects(()=>f.pipeline.generate(f.task.id,'requirement',f.controller),/cannot be verified/);assert.equal(generated,false);
});
test('prompt: unknown actual model/reasoning is explicitly awaiting review and cannot auto-deliver',async t=>{
 const f=setup(t,{source:'chatgpt',capabilities:async()=>({verified:true,models:['gpt-6'],reasoningEfforts:['high']}),generate:async()=>({content:'[TEST] unverified model output',sourceMessageId:'fixture',actualModel:null,actualReasoningEffort:null})});
 const id=await f.pipeline.generate(f.task.id,'requirement',f.controller);assert.equal(f.scope.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'REVIEW_REQUIRED');await assert.rejects(()=>f.pipeline.deliver(id,f.controller),/record/);
});
test('prompt: uncertain delivery remains fenced and requires independent explicit recovery',async t=>{
 const f=setup(t,undefined,true);const id=await f.pipeline.generate(f.task.id,'requirement',f.controller);await assert.rejects(()=>f.pipeline.deliver(id,f.controller));
 assert.equal(f.scope.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'DELIVERING');await assert.rejects(()=>f.pipeline.deliver(id,f.controller),/recovery/);assert.equal(f.count(),1);
 assert.equal(f.store.cancel(f.task.id,f.controller,undefined,0).ok,false);assert.throws(()=>f.pipeline.recoverDelivery(id,f.controller,false));f.pipeline.recoverDelivery(id,f.controller,true);
});
test('prompt: mock provenance is never accepted by a production database or env switch',async t=>{
 const db=createDb({dbPath:':memory:'});t.after(()=>db.close());const authority=new CallerAuthority();const caller=authority.issue({principal:'test',instance:'test',executor:'hermes',reviewer:true});
 const pipeline=new PromptPipeline(db,authority,{source:'mock-chatgpt',capabilities:async()=>({verified:true,models:['gpt-6'],reasoningEfforts:['high']}),generate:async()=>{throw new Error();}},{model:'gpt-6',reasoningEffort:'high'},{deliver:async()=>{throw new Error();}});
 await assert.rejects(()=>pipeline.generate('fake','requirement',caller),/isolated Demo/);
});
test('prompt: uncooperative adapter timeout is bounded and uncertain delivery stays fenced',async t=>{
 const f=setup(t);const adapter:ChatgptAdapter={source:'mock-chatgpt',capabilities:async()=>({verified:true,models:['gpt-6'],reasoningEfforts:['high']}),generate:async()=>({content:'[TEST] bounded adapter',sourceMessageId:'test-timeout',actualModel:'mock:gpt-6',actualReasoningEffort:'mock:high'})};
 const pipeline=new PromptPipeline(f.scope.db,f.authority,adapter,{model:'gpt-6',reasoningEffort:'high'},{deliver:async()=>new Promise(()=>{})},10);
 const id=await pipeline.generate(f.task.id,'requirement',f.controller);await assert.rejects(()=>pipeline.deliver(id,f.controller),/deadline/);
 assert.equal(f.scope.db.prepare('SELECT delivery_status FROM prompts WHERE id=?').get(id)!.delivery_status,'DELIVERING');
 await assert.rejects(()=>pipeline.deliver(id,f.controller),/recovery/);
});
