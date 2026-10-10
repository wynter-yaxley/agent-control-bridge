import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const directory = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => join(directory, name));
if (!files.length) { console.error('No test files discovered'); process.exitCode = 1; }
else {
  console.log(`Discovered ${files.length} test files`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', '--test-timeout=90000', '--test-reporter=tap', ...files], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let tail='';
  child.stdout.on('data',data=>{process.stdout.write(data);tail=(tail+data.toString()).slice(-8192);});
  child.stderr.on('data',data=>process.stderr.write(data));
  child.once('error',()=>{console.error('Test runner could not start');process.exitCode=1;});
  child.once('close',code=>{
    const count=/# tests (\d+)/.exec(tail);
    process.exitCode=code===0&&count&&Number(count[1])>0?0:1;
    if(!count||Number(count[1])===0)console.error('Test runner did not execute any tests');
  });
}
