import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
test('config: defaults, precedence, config-relative Unicode paths, and no environment permission override', t => {
  const root=mkdtempSync(join(tmpdir(),'acb-config 中文 ')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const empty=loadConfig({cwd:root,env:{}}); assert.equal(empty.watcher.intervalMs,60000); assert.equal(empty.agents.chatgpt.model,'gpt-6'); assert.equal(empty.agents.chatgpt.reasoningEffort,'high'); assert.equal(empty.desktop.enabled,false);
  const path=join(root,'config.json'); writeFileSync(path,JSON.stringify({database:{path:'relative/example.sqlite'},watcher:{intervalMs:42}}));
  const file=loadConfig({configPath:path,cwd:root,env:{}}); assert.equal(file.database.path,join(root,'relative','example.sqlite')); assert.equal(file.watcher.intervalMs,42);
  const env=loadConfig({configPath:path,cwd:root,env:{ACB_DB_PATH:'env.sqlite',ACB_WATCH_INTERVAL_MS:'43',ACB_REVIEWER:'true'}}); assert.equal(env.database.path,join(root,'env.sqlite')); assert.equal(env.watcher.intervalMs,43);
  assert.equal(loadConfig({configPath:path,cwd:root,dbPath:'cli.sqlite',env:{ACB_DB_PATH:'env.sqlite'}}).database.path,join(root,'cli.sqlite'));
});
for(const interval of [0,-1,1.5,NaN,Infinity]) test(`config: rejects interval ${interval}`,()=>assert.throws(()=>loadConfig({env:{ACB_WATCH_INTERVAL_MS:String(interval)}})));
test('config: unknown keys, unsafe endpoint, malformed flags and credentials rejected',t=>{
 const root=mkdtempSync(join(tmpdir(),'acb-invalid-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'config.json');
 for(const value of [{watcher:{unknown:1}},{desktop:{enabled:'yes'}},{desktop:{allowPhysicalInput:true}},{desktop:{cdpUrl:'http://example.com:9222'}},{logging:{redactSecrets:false}}]){writeFileSync(path,JSON.stringify(value));assert.throws(()=>loadConfig({configPath:path,env:{}}));}
});
test('config: blocked reporting default/override and invalid thresholds',()=>{
 assert.equal(loadConfig({env:{}}).failureReporting.blockedAfterMs,600000);
 assert.equal(loadConfig({env:{ACB_BLOCKED_REPORT_MS:'120000'}}).failureReporting.blockedAfterMs,120000);
 for(const value of ['0','-1','NaN'])assert.throws(()=>loadConfig({env:{ACB_BLOCKED_REPORT_MS:value}}));
});

test('config: native interface budgets are unified and reject unsafe values', t => {
 const root=mkdtempSync(join(tmpdir(),'acb-native-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'config.json');
 assert.equal(loadConfig({cwd:root,env:{}}).nativeInterface.maxFrameBytes,2097152);
 writeFileSync(path,JSON.stringify({nativeInterface:{timeoutMs:12000,maxFrameBytes:65536,maxCandidates:8}}));
 assert.equal(loadConfig({configPath:path,env:{}}).nativeInterface.timeoutMs,12000);
 for(const value of [{timeoutMs:0},{timeoutMs:60001},{maxCandidates:33},{maxFrameBytes:4095}]){writeFileSync(path,JSON.stringify({nativeInterface:value}));assert.throws(()=>loadConfig({configPath:path,env:{}}));}
});
