import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../src/demo.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('workflow: complete isolated ChatGPT mock -> bridge -> Codex mock -> independent review',async()=>{
 const result=await runDemo();assert.equal(result.mode,'ISOLATED_MOCK');assert.equal(result.realModelInvoked,false);assert.equal(result.simulatedTask.status,'SUCCEEDED');assert.equal(result.deliveries,1);assert.equal(result.duplicateNotifications,0);assert.equal(result.executorSelfReviewDenied,true);assert.equal(result.schemaVersion,6);assert.ok(Number(result.auditCount)>=7);
});
test('workflow: production DB/env cannot switch demo trust into production',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'demo','--db','ignored.db'],{encoding:'utf8',env:{...process.env,ACB_REVIEWER:'true',ACB_DEMO:'true'}});assert.equal(result.status,2);assert.equal(result.stdout,'');
});
