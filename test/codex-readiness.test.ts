import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { checkCodexReadiness } from '../src/codex-readiness.ts';

function fixture(mode:'success'|'unavailable'|'silent'){
  const requests:Record<string,unknown>[]=[];let hidden=false;
  const spawnFn=((_exe:string,_args:readonly string[],options:{windowsHide?:boolean;shell?:boolean})=>{
    hidden=options.windowsHide===true&&options.shell===false;
    const child=new EventEmitter() as ChildProcess;
    child.stdout=new EventEmitter() as unknown as Readable;child.stderr=new EventEmitter() as unknown as Readable;
    child.kill=()=>{queueMicrotask(()=>child.emit('close',0));return true;};
    child.stdin=new Writable({write(chunk,_encoding,done){
      const request=JSON.parse(String(chunk));requests.push(request);
      if(request.id && mode!=='silent')queueMicrotask(()=>{
        const result=request.id===1?{userAgent:'fixture'}:request.id===2?{account:mode==='unavailable'?null:{type:'chatgpt',email:'private-fixture@example.invalid'}}:{data:[{model:'gpt-fixture',supportedReasoningEfforts:[{reasoningEffort:'high'}],privateField:'synthetic-private-data'}]};
        child.stdout!.emit('data',Buffer.from(JSON.stringify({id:request.id,result})+'\n'));});done();
    }});return child;
  }) as typeof spawn;
  return {spawnFn,requests,hidden:()=>hidden};
}
test('Codex diagnostic: read-only methods, hidden process and account details omitted',async()=>{
  const f=fixture('success'),result=await checkCodexReadiness({executable:'fixture',timeoutMs:100,spawnFn:f.spawnFn});
  assert.equal(result.ok,true);assert.equal(result.realModelInvoked,false);assert.equal(result.ordinaryChatVerified,false);assert.equal(f.hidden(),true);
  assert.deepEqual(f.requests.map(row=>row.method),['initialize','initialized','account/read','model/list']);
  assert.ok(!JSON.stringify(result).includes('private-fixture'));assert.ok(!JSON.stringify(result).includes('synthetic-private-data'));
});
test('Codex diagnostic: unavailable account and unresponsive process fail without login or a turn',async()=>{
  const absent=fixture('unavailable');assert.equal((await checkCodexReadiness({executable:'fixture',timeoutMs:100,spawnFn:absent.spawnFn})).code,'AUTH_UNAVAILABLE');
  assert.ok(!absent.requests.some(row=>String(row.method).includes('login')));
  const silent=fixture('silent');assert.equal((await checkCodexReadiness({executable:'fixture',timeoutMs:5,spawnFn:silent.spawnFn})).code,'TIMEOUT');assert.equal(silent.requests.length,1);
});
