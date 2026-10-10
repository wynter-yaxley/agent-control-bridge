import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentProcess } from '../src/silent-process.ts';
test('silent process: missing dependency and failure cannot report success',async()=>{
 const missing=await silentProcess('mock','acb-nonexistent-executable',[]);assert.equal(missing.ok,false);assert.equal(missing.code,'DEPENDENCY');
 const fail=await silentProcess('mock',process.execPath,['-e','process.stderr.write("authentication failed"); process.exit(3)']);assert.equal(fail.ok,false);assert.equal(fail.code,'AUTH');assert.equal(fail.needsUserAction,true);assert.equal(fail.stdout,undefined);
});
test('silent process: timeout, output redaction and no interactive stdin',async()=>{
 const timeout=await silentProcess('mock',process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:20,mutation:true});assert.equal(timeout.code,'TIMEOUT');assert.equal(timeout.partialChanges,true);
 const okay=await silentProcess('mock',process.execPath,['-e','console.log("password="+"synthetic-marker")']);assert.equal(okay.ok,true);assert.equal(okay.stdout?.includes('synthetic-marker'),false);
});
