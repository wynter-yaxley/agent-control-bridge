import { parseArgs } from 'node:util';
import { readCredentials } from './feishu-check.mjs';
import { loadConfig } from '../src/config.ts';
import { createFeishuMessageSender } from '../src/feishu.ts';
import { isolatedDemo } from '../src/demo-scope.ts';
import { CallerAuthority } from '../src/caller.ts';
import { enqueueNotification } from '../src/outbox.ts';
import { NotificationDispatcher } from '../src/notification-delivery.ts';

// One explicitly authorized live notification; every ledger row is isolated.
try {
  const args=parseArgs({options:{config:{type:'string'},'test-recipient-open-id':{type:'string'},'send-test-message':{type:'boolean'},help:{type:'boolean'}},strict:true});
  if(args.values.help)process.stdout.write('Isolated notification sender test. Requires explicit user authorization and --send-test-message --test-recipient-open-id <id>. Credentials via stdin only.\n');
  else{
    const recipient=args.values['test-recipient-open-id'];
    if(!args.values['send-test-message']||typeof recipient!=='string'||!/^ou_[a-z0-9]{8,64}$/i.test(recipient))throw Error('INPUT');
    const config=loadConfig({configPath:args.values.config}),credentials=await readCredentials();
    const scope=isolatedDemo();
    try{
      const authority=new CallerAuthority(),context=authority.issue({principal:'fixture:feishu-notification-check',instance:'isolated-probe',executor:'hermes',controller:true,reviewer:false});
      const id=enqueueNotification(scope.db,authority.resolve(context).principal,'isolated-notification-test',{state:'TEST_ONLY'});
      const dispatcher=new NotificationDispatcher(scope.db,authority,context,createFeishuMessageSender(credentials,config.feishu),{timeoutMs:config.feishu.timeoutMs,leaseMs:config.background.notificationLeaseMs,route:()=>({type:'open_id',id:recipient}),render:()=>`Agent Control Bridge 通知组件实测：这是一条隔离测试消息，未触发 GPT 或 Codex。测试编号：${id}`});
      const delivered=await dispatcher.flush(1);
      const row=scope.db.prepare('SELECT state,receipt_id,error_code FROM notification_delivery WHERE notification_id=?').get(id);
      const result={ok:delivered.acknowledged===1,deliveryState:row?.state??'NOT_SENT',messageId:row?.receipt_id??null,errorCode:row?.error_code??null,ledgerAcknowledged:scope.db.prepare('SELECT state FROM notification_outbox WHERE id=?').get(id).state==='ACKED',realModelInvoked:false,incomingEventVerified:false};
      process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;
    }finally{credentials.app_id='';credentials.app_secret='';scope.close();}
  }
}catch{process.stderr.write('{"ok":false,"code":"INPUT_OR_CONFIG","privateDiagnosticsOmitted":true}\n');process.exitCode=2;}
