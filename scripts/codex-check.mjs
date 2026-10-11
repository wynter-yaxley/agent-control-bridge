import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { checkCodexReadiness } from '../src/codex-readiness.ts';
try {
  const args=parseArgs({options:{config:{type:'string'},executable:{type:'string'},help:{type:'boolean'}},strict:true});
  if(args.values.help)process.stdout.write('Read-only Codex app-server authentication/model diagnostic. No login, thread creation or inference.\n--config <file> --executable <absolute codex path>\n');
  else{
    const config=loadConfig({configPath:args.values.config});
    const result=await checkCodexReadiness({executable:args.values.executable??config.agents.codex.executable??'',timeoutMs:config.watcher.timeoutMs});
    process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;
  }
}catch{process.stderr.write('{"ok":false,"code":"CONFIG","privateDiagnosticsOmitted":true}\n');process.exitCode=2;}
