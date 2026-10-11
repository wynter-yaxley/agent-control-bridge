import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { enqueueNotification } from '../src/outbox.ts';
import { NotificationDispatcher, MessageDeliveryError, type NotificationSender } from '../src/notification-delivery.ts';
import { createFeishuMessageSender } from '../src/feishu.ts';

const routing={timeoutMs:100,leaseMs:1000,route:()=>({type:'open_id' as const,id:'ou_fixture0001'}),render:()=> '[TEST] Waiting for independent acceptance'};
test('notification: sends stable key, persists a real-shaped receipt and acknowledges once',async t=>{
  const f=fixture(); t.after(()=>f.db.close());
  const id=enqueueNotification(f.db,f.authority.resolve(f.reviewer)!.principal,'fixture-send',{state:'WAITING_APPROVAL'});
  let sends=0; const sender:NotificationSender={send:async input=>{sends++;assert.equal(input.idempotencyKey,id);return {messageId:'om_fixture0001'};}};
  const dispatcher=new NotificationDispatcher(f.db,f.authority,f.reviewer,sender,routing);
  assert.deepEqual(await dispatcher.flush(),{acknowledged:1,blocked:0});
  assert.deepEqual(await dispatcher.flush(),{acknowledged:0,blocked:0});assert.equal(sends,1);
  assert.equal(f.db.prepare('SELECT state FROM notification_outbox WHERE id=?').get(id)!.state,'ACKED');
});
test('notification: timeout or crashed send stays fenced after lease expiry and restart',async t=>{
  const f=fixture(); t.after(()=>f.db.close()); let sends=0;
  const principal=f.authority.resolve(f.reviewer)!.principal;
  const first=enqueueNotification(f.db,principal,'fixture-unknown',{state:'BLOCKED'});
  const sender:NotificationSender={send:async()=>{sends++;throw new MessageDeliveryError('unknown');}};
  assert.deepEqual(await new NotificationDispatcher(f.db,f.authority,f.reviewer,sender,routing).flush(),{acknowledged:0,blocked:1});
  assert.equal(f.db.prepare('SELECT state FROM notification_delivery').get()!.state,'UNCERTAIN');
  assert.equal(new (await import('../src/outbox.ts')).NotificationOutbox(f.db,f.authority).status(f.reviewer).unresolvedDeliveries[0].id,first);
  f.db.prepare("UPDATE notification_outbox SET lease_until='2000-01-01'").run();
  const restarted=f.authority.issue({principal,instance:'restart',executor:'hermes',controller:true,reviewer:false});
  const second=enqueueNotification(f.db,principal,'fixture-later',{state:'QUEUED'});
  const succeeding:NotificationSender={send:async()=>{sends++;return {messageId:'om_fixture0002'};}};
  assert.deepEqual(await new NotificationDispatcher(f.db,f.authority,restarted,succeeding,routing).flush(),{acknowledged:1,blocked:0});
  assert.equal(sends,2);assert.equal(f.db.prepare('SELECT state FROM notification_outbox WHERE id=?').get(first)!.state,'INFLIGHT');
  assert.equal(f.db.prepare('SELECT state FROM notification_outbox WHERE id=?').get(second)!.state,'ACKED');
});
test('notification: receipt committed before acknowledgement survives restart without resending',async t=>{
  const f=fixture();t.after(()=>f.db.close());let sends=0;
  enqueueNotification(f.db,f.authority.resolve(f.reviewer)!.principal,'fixture-sent',{state:'QUEUED'});
  const sender:NotificationSender={send:async()=>{sends++;f.db.prepare("UPDATE notification_outbox SET lease_until='2000-01-01'").run();return {messageId:'om_fixture0003'};}};
  const dispatcher=new NotificationDispatcher(f.db,f.authority,f.reviewer,sender,routing);
  assert.deepEqual(await dispatcher.flush(),{acknowledged:0,blocked:1});
  assert.equal(f.db.prepare('SELECT state FROM notification_delivery').get()!.state,'SENT');
  assert.deepEqual(await dispatcher.flush(),{acknowledged:1,blocked:0});assert.equal(sends,1);
});
test('notification: deadline with an uncooperative sender fences an uncertain send',async t=>{
  const f=fixture();t.after(()=>f.db.close());enqueueNotification(f.db,f.authority.resolve(f.reviewer)!.principal,'fixture-timeout',{state:'QUEUED'});
  const sender:NotificationSender={send:async()=>new Promise(()=>{})};
  assert.deepEqual(await new NotificationDispatcher(f.db,f.authority,f.reviewer,sender,{...routing,timeoutMs:5}).flush(),{acknowledged:0,blocked:1});
  assert.equal(f.db.prepare('SELECT state FROM notification_delivery').get()!.state,'UNCERTAIN');
});
test('Feishu sender: pre-abort makes no request; normal send uses official origin and stable UUID',async()=>{
  let calls=0;const controller=new AbortController();controller.abort();
  const fetchFn=(async (_url,init)=>{calls++;return Response.json(calls%2===1?{code:0,tenant_access_token:'synthetic-token'}:{code:0,data:{message_id:'om_fixture0010'}});}) as typeof fetch;
  const sender=createFeishuMessageSender({app_id:'cli_fixtureonly',app_secret:'synthetic-fixture-secret'},{apiOrigin:'https://open.feishu.cn',timeoutMs:100,fetchFn});
  const input={destination:{type:'open_id' as const,id:'ou_fixture0001'},text:'[TEST] fixture',idempotencyKey:'fixture-key-001'};
  await assert.rejects(()=>sender.send(input,controller.signal));assert.equal(calls,0);
  assert.deepEqual(await sender.send(input,new AbortController().signal),{messageId:'om_fixture0010'});assert.equal(calls,2);
});
