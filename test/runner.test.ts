import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('test discovery refuses an empty fixture suite instead of reporting green', t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-empty-tests-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'scripts'));mkdirSync(join(root,'test'));
  cpSync(fileURLToPath(new URL('../scripts/test.mjs',import.meta.url)),join(root,'scripts','test.mjs'));
  const result=spawnSync(process.execPath,[join(root,'scripts','test.mjs')],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/No test files/);assert.equal(result.stdout,'');
});
