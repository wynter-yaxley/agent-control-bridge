import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CallerAuthority, currentPrincipal, localCaller } from '../src/caller.ts';
test('default OS caller has no reviewer rights; enabled policy binds principal/instance, not business strings',t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-policy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'policy.json'),authority=new CallerAuthority();
  const initial=localCaller(authority,path),identity=authority.resolve(initial.context)!;
  assert.equal(identity.reviewer,false);assert.equal(identity.executor,'pi');assert.equal(identity.instance,'local-cli');assert.ok(Object.isFrozen(identity));assert.ok(Object.isFrozen(initial.context));
  writeFileSync(path,JSON.stringify([{principal:identity.principal,instance:'protected-host',executor:'codex',reviewer:false}]));
  const configured=authority.resolve(localCaller(authority,path).context)!;assert.equal(configured.principal,identity.principal);assert.equal(configured.instance,'protected-host');assert.equal(configured.executor,'codex');assert.equal(configured.reviewer,false);
});
test('invalid, unknown-principal, duplicate-principal, or broad SID policy is refused',t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-policy-invalid-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'policy.json'),a=new CallerAuthority(),principal=currentPrincipal();
  const entry={principal,instance:'fixture',executor:'pi',reviewer:false};
  for(const policy of [{},[null],[{...entry,reviewer:'true'}],[{...entry,executor:'invalid'}],[entry,entry],[],[{...entry,principal:'S-1-5-11'}]]){
    writeFileSync(path,JSON.stringify(policy));assert.throws(()=>localCaller(a,path));
  }
});
test('untrusted PATH cannot replace the OS identity helper',{skip:process.platform!=='win32'},t=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-path-shadow-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));cpSync(fileURLToPath(new URL('../src',import.meta.url)),join(root,'src'),{recursive:true});
  writeFileSync(join(root,'powershell.cmd'),'@echo fake-principal\r\n');
  const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',"import {currentPrincipal} from './src/caller.ts'; console.log(currentPrincipal());"],{cwd:root,encoding:'utf8',env:{...process.env,PATH:root}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout.trim(),/^S-1-\d+(?:-\d+)+$/);assert.equal(result.stdout.includes('fake-principal'),false);
});

test('controller/reviewer overlap cannot be issued and reviewer has no implicit control',()=>{
 const a=new CallerAuthority();assert.throws(()=>a.issue({principal:'fixture:caller',instance:'one',executor:'hermes',controller:true,reviewer:true}),{code:'AUTH'});
 const r=a.issue({principal:'fixture:reviewer',instance:'one',executor:'hermes',reviewer:true});assert.equal(a.resolve(r)!.controller,false);
});
