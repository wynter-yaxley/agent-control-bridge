import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodex, loadConfig } from '../src/config.ts';
import { hermesCommands } from '../src/mcp.ts';

function scratch(t: { after(fn: () => void): void }) { const root = mkdtempSync(join(tmpdir(), 'acb-setup-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const touch = (file: string, seconds: number) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, ''); utimesSync(file, seconds, seconds); };

test('setup: Codex is found in the desktop app (newest version folder), else on PATH, without any configured path', t => {
  const root = scratch(t);
  touch(join(root, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe'), 1000);
  touch(join(root, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'), 2000);
  assert.deepEqual(findCodex({ LOCALAPPDATA: root }, 'win32'), { path: join(root, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'), source: 'desktop' });
  touch(join(root, 'tools', 'codex'), 1000);
  assert.deepEqual(findCodex({ PATH: `${join(root, 'missing')}:${join(root, 'tools')}` }, 'linux'), { path: join(root, 'tools', 'codex'), source: 'PATH' });
  assert.equal(findCodex({ PATH: '' }, 'linux'), null);
});

test('setup: options win over ACB_* variables, which win over the config file; defaults need no file', t => {
  const root = scratch(t), file = join(root, 'config.json');
  writeFileSync(file, '\ufeff' + JSON.stringify({ codexExecutable: 'from-file', carrierThreadId: 'file-thread', timeoutMs: 120000, workspaceRoot: 'from-file' }));
  const env = { ACB_CONFIG: file, ACB_CODEX: 'from-env', ACB_WORKSPACE_ROOT: 'from-env', ACB_ALLOW_FOREGROUND_INPUT: '1', PATH: '' };
  const both = loadConfig(undefined, { codexExecutable: 'from-option' }, env);
  assert.deepEqual([both.codexExecutable, both.codexSource, both.carrierThreadId, both.timeoutMs, both.workspaceRoot, both.foregroundInput, both.debug], ['from-option', 'option', 'file-thread', 120000, 'from-env', true, false]);
  assert.equal(loadConfig(undefined, {}, env).codexSource, 'env');
  const bare = loadConfig(undefined, {}, { PATH: '' });
  assert.deepEqual([bare.codexExecutable, bare.carrierThreadId, bare.timeoutMs, bare.foregroundInput], [null, null, 240000, false]);
  assert.match(bare.workspaceRoot, /acb-workspaces$/);
  assert.throws(() => loadConfig(join(root, 'missing.json'), {}, {}), { code: 'CONFIG' });
});

test('setup: the Hermes registration and skill commands are printed for Hermes on Windows and in WSL', () => {
  const commands = hermesCommands('C:\\Program Files\\nodejs\\node.exe', 'D:\\acb\\dist\\mcp.js');
  assert.equal(commands.windows!.mcp, 'hermes mcp add acb --command "C:\\Program Files\\nodejs\\node.exe" --args "D:\\acb\\dist\\mcp.js" --allow-foreground-input');
  assert.equal(commands.windows!.skill, 'Copy-Item -Recurse -Force "D:\\acb\\skills\\agent-control-bridge" "$env:LOCALAPPDATA\\hermes\\skills\\"');
  assert.equal(commands.wsl!.mcp, "hermes mcp add acb --command '/mnt/c/Program Files/nodejs/node.exe' --args 'D:\\acb\\dist\\mcp.js' --allow-foreground-input");
  assert.equal(commands.wsl!.skill, "cp -r '/mnt/d/acb/skills/agent-control-bridge' ~/.hermes/skills/");
  assert.deepEqual(hermesCommands('/usr/bin/node', '/opt/acb/dist/mcp.js'), { local: { mcp: "hermes mcp add acb --command '/usr/bin/node' --args '/opt/acb/dist/mcp.js'", skill: "cp -r '/opt/acb/skills/agent-control-bridge' ~/.hermes/skills/" } });
});
