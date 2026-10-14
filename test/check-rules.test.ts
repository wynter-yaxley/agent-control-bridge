import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
// @ts-expect-error The release check rules are plain JavaScript without declarations.
import { scanText, scanHistory } from '../scripts/check-rules.mjs';

test('release check: local user paths are detected independently of the running account', () => {
  const scan = (text: string) => (scanText('src/fixture.ts', text) as string[]).includes('localUserPath');
  // Positive fixtures are assembled so this file itself contains no concrete account path.
  const path = (separator: string, ...parts: string[]) => parts.join(separator);
  for (const text of [`"${path('/', '', 'home', 'alice', '.config')}"`, `'${path('\\', 'C:', 'Users', 'Bob', 'AppData')}'`, `"${path('/', 'C:', 'Users', 'Carol', 'x')}"`, `"${path('/', '', 'home', 'dave')}"`]) assert.equal(scan(text), true, text);
  for (const text of ['\\Users\\[USER]\\AppData', '/home/<user>/x', '/Users/$USER/x', '%USERPROFILE%\\x', 'AU/Users/Everyone 写权限', '/home/runner/work/x', '/mnt/c/.../node.exe']) assert.equal(scan(text), false, text);
  assert.deepEqual(scanText('data/bridge.db', ''), ['privatePath']);
});

test('history check: new paths, reused original blobs and baseline expansion fail closed',t=>{
 const root=mkdtempSync(join(tmpdir(),'acb-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args:string[])=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
 const source=fileURLToPath(new URL('../',import.meta.url));
 const baseline=JSON.parse(readFileSync(new URL('../scripts/check-history-baseline.json',import.meta.url),'utf8'));
 git('init','--quiet');git('fetch','--quiet',source,'75db1e443c1853f99d642ee0e0f56f6ce5fdce61');git('checkout','--quiet','--detach','FETCH_HEAD');
 const commit=(message:string)=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m',message);
 const original=git('show',baseline[0].blob);
 git('rm','--quiet','src/hermes.ts','src/pi.ts');commit('remove historical paths');
 let result=scanHistory(git,baseline);assert.deepEqual(result.violations,[]);assert.equal(result.acknowledgedHistory.length,2);
 const benign=readFileSync(join(root,'package.json'),'utf8');mkdirSync(join(root,'data'));writeFileSync(join(root,'data','fixture.txt'),benign);
 git('add','-f','data/fixture.txt');commit('reuse benign blob at private path');git('rm','--quiet','data/fixture.txt');commit('remove private file');
 result=scanHistory(git,baseline);assert.ok(result.violations.some((finding:{path:string;kind:string})=>finding.path==='data/fixture.txt'&&finding.kind==='privatePath'));
 writeFileSync(join(root,'src','hermes.ts'),original);git('add','src/hermes.ts');commit('reintroduce registered blob');git('rm','--quiet','src/hermes.ts');commit('remove reintroduced blob');
 result=scanHistory(git,baseline);assert.ok(result.violations.some((finding:{blob:string;kind:string})=>finding.blob===baseline[0].blob&&finding.kind==='localUserPath'));
 assert.throws(()=>scanHistory(git,[...baseline,{blob:baseline[0].blob,path:'data/fixture.txt',kind:'privatePath'}]),/baseline/);
 assert.throws(()=>scanHistory(git,[{...baseline[0],blob:git('hash-object','package.json').trim()},baseline[1]]),/baseline/);
 assert.throws(()=>scanHistory(git,[{...baseline[0],kind:'githubToken'},baseline[1]]),/baseline/);
 assert.ok(scanText('src/fixture.ts','gh'+'p_'+'A'.repeat(36)).includes('githubToken'));
 assert.ok(scanText('src/hermes.ts',original).includes('localUserPath'));
});
