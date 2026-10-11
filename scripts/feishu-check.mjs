import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { checkFeishuApp } from '../src/feishu.ts';
import { randomUUID } from 'node:crypto';

export function readCredentials() {
  return new Promise((resolve,reject)=>{
    let text='';let finished=false;
    if(process.stdin.isTTY)process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    const cleanup=()=>{
      clearTimeout(timer);process.stdin.off('data',data);process.stdin.off('end',end);process.stdin.pause();
      if(process.stdin.isTTY)process.stdin.setRawMode(false);
    };
    const fail=()=>{if(finished)return;finished=true;text='';cleanup();reject(new Error('INPUT'));};
    const data=value=>{
      text+=value;if(text.length>4096||text.includes('\x03')){fail();return;}
      // Windows terminal input can deliver Enter as CR, LF, or CRLF.
      if(!/[\r\n]/.test(text))return;
      try {
        const value=JSON.parse(text);text='';
        if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='app_id,app_secret')throw new Error('INPUT');
        finished=true;cleanup();resolve(value);
      } catch {fail();}
    };
    const end=()=>fail();const timer=setTimeout(fail,120000);
    process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.resume();
    process.stderr.write('ACB_INPUT_READY: credentials via stdin; terminal echo disabled for interactive input\n');
  });
}

if(import.meta.main)try {
  const args=parseArgs({options:{config:{type:'string'},help:{type:'boolean'},'send-test-message':{type:'boolean'},'test-recipient-open-id':{type:'string'}},strict:true,tokens:true});
  const flags=args.tokens.filter(t=>t.kind==='option').map(t=>t.name);if(new Set(flags).size!==flags.length)throw new Error('INPUT');
  if(args.values.help)process.stdout.write('Feishu authentication and bot check; read-only by default.\nSupply credential JSON via stdin; never via command line or a credential file.\n--config <file> sets the official API origin and request budget.\n--send-test-message --test-recipient-open-id <id> sends one explicit test after user authorization.\n');
  else {
    if(Boolean(args.values['send-test-message'])!==Boolean(args.values['test-recipient-open-id']))throw new Error('INPUT');
    const config=loadConfig({configPath:args.values.config});
    const credentials=await readCredentials();
    let result;
    try {
      const key=randomUUID();
      const messageTest=args.values['send-test-message']?{recipientOpenId:args.values['test-recipient-open-id'],idempotencyKey:key,text:`Agent Control Bridge 飞书连通性测试：认证和 Bot 信息检查通过。这是一条测试消息，未触发 GPT 或 Codex 任务。测试编号：${key}`}:undefined;
      result=await checkFeishuApp(credentials,{...config.feishu,messageTest});
    }
    finally {credentials.app_secret='';credentials.app_id='';}
    process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;
  }
}catch(error){
  const code=error?.code==='CONFIG'?'CONFIG':'INPUT';
  process.stderr.write(JSON.stringify({ok:false,code,message:'Feishu check could not complete; private diagnostics omitted'})+'\n');process.exitCode=2;
}
