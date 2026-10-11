import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeishuApp } from '../src/feishu.ts';
import { spawnSync } from 'node:child_process';
import { controlledProcessEnv } from '../src/silent-process.ts';

const credentials={app_id:'cli_fixtureonly',app_secret:'synthetic-fixture-secret'};
const options={apiOrigin:'https://open.feishu.cn',timeoutMs:100};
test('Feishu input: CR, LF and CRLF accept credential input without echo or network calls',()=>{
  const moduleUrl=new URL('../scripts/feishu-check.mjs',import.meta.url).href;
  const script=`import {readCredentials} from ${JSON.stringify(moduleUrl)};const value=await readCredentials();console.log(JSON.stringify({accepted:value.app_id==='cli_fixtureonly'}));value.app_secret='';`;
  for(const newline of ['\r','\n','\r\n']){
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(credentials)+newline,encoding:'utf8',timeout:10000,windowsHide:true,env:controlledProcessEnv()});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).accepted,true);
    assert.ok(!result.stdout.includes(credentials.app_secret));assert.ok(!result.stderr.includes(credentials.app_secret));
  }
});
test('Feishu: authentication then bot info uses two fixed endpoints and omits secrets',async()=>{
  const requests:{url:string;init:RequestInit}[]=[];const token='synthetic-fixture-token';
  const fetchFn=(async(url,init)=>{
    requests.push({url:String(url),init:init!});
    return Response.json(requests.length===1?{code:0,expire:7200,tenant_access_token:token}:{code:0,bot:{app_name:`Fixture ${credentials.app_secret} ${token}`,open_id:'ou_fixture',activate_status:2},unexpected_secret:credentials.app_secret});
  }) as typeof fetch;
  const result=await checkFeishuApp(credentials,{...options,fetchFn});
  assert.equal(result.ok,true);assert.equal(result.messaging.status,'NOT_TESTED');assert.equal(requests.length,2);
  assert.ok(requests[0].url.endsWith('/auth/v3/tenant_access_token/internal'));assert.ok(requests[1].url.endsWith('/bot/v3/info'));
  assert.equal(requests[0].init.redirect,'error');assert.equal((requests[1].init.headers as Record<string,string>).authorization,`Bearer ${token}`);
  const output=JSON.stringify(result);assert.ok(!output.includes(credentials.app_secret));assert.ok(!output.includes(token));
});
test('Feishu: only an explicit target sends one message and returns a stable receipt',async()=>{
  const requests:{url:string;body:unknown}[]=[];
  const fetchFn=(async(url,init)=>{
    requests.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):null});
    return Response.json(requests.length===1?{code:0,tenant_access_token:'synthetic-token'}:requests.length===2?{code:0,bot:{open_id:'ou_fixture'}}:{code:0,data:{message_id:'om_fixture0001'}});
  }) as typeof fetch;
  const result=await checkFeishuApp(credentials,{...options,fetchFn,messageTest:{recipientOpenId:'ou_fixture0001',idempotencyKey:'fixture-key-001',text:'[TEST] connection only'}});
  assert.equal(requests.length,3);assert.ok(requests[2].url.endsWith('/im/v1/messages?receive_id_type=open_id'));
  assert.equal((requests[2].body as {uuid:string}).uuid,'fixture-key-001');assert.equal(result.messaging.messageId,'om_fixture0001');assert.equal(result.incomingEvents,'NOT_TESTED');
});
test('Feishu: rejected credentials stop before bot call and do not return echoed diagnostics',async()=>{
  let calls=0;const fetchFn=(async()=>{calls++;return Response.json({code:10014,msg:credentials.app_secret});}) as typeof fetch;
  const result=await checkFeishuApp(credentials,{...options,fetchFn});
  assert.equal(result.authentication.status,'FAIL');assert.equal(result.authentication.apiCode,10014);assert.equal(result.bot.status,'NOT_TESTED');assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(credentials.app_secret));
});
test('Feishu: untrusted origin makes no request; uncooperative transport is bounded',async()=>{
  let calls=0;const fetchFn=(async()=>{calls++;return new Promise(()=>{});}) as typeof fetch;
  await assert.rejects(()=>checkFeishuApp(credentials,{...options,apiOrigin:'https://example.invalid',fetchFn}),/official/);assert.equal(calls,0);
  const result=await checkFeishuApp(credentials,{...options,timeoutMs:5,fetchFn});assert.equal(result.authentication.errorCode,'TIMEOUT');
});
