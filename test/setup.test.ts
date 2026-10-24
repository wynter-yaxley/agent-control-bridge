import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodex, loadConfig, refreshCodex } from '../src/config.ts';
import { hermesCommands } from '../src/mcp.ts';
import { status } from '../src/check.ts';

function scratch(t: { after(fn: () => void): void }) { const root = mkdtempSync(join(tmpdir(), 'acb-setup-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const touch = (file: string, seconds: number) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, ''); utimesSync(file, seconds, seconds); };

test('setup: Codex is found in the desktop app (newest version folder), else on PATH, without any configured path', t => {
  const root = scratch(t);
  touch(join(root, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe'), 1000);
  touch(join(root, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'), 2000);
  assert.deepEqual(findCodex({ LOCALAPPDATA: root }, 'win32'), { path: join(root, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe'), source: 'desktop' });
  // PATH is split by the separator of the given platform, not of the host.
  touch(join(root, 'win', 'codex.exe'), 1000);
  assert.deepEqual(findCodex({ PATH: `${join(root, 'missing')};${join(root, 'win')}` }, 'win32'), { path: join(root, 'win', 'codex.exe'), source: 'PATH' });
  // Windows paths contain ":" (drive letters), so the ":"-separated case runs on other hosts only.
  if (process.platform !== 'win32') {
    touch(join(root, 'tools', 'codex'), 1000);
    assert.deepEqual(findCodex({ PATH: `${join(root, 'missing')}:${join(root, 'tools')}` }, 'linux'), { path: join(root, 'tools', 'codex'), source: 'PATH' });
  }
  assert.equal(findCodex({ PATH: '' }, 'linux'), null);
});

test('setup: a long-running server follows a desktop app update to the new codex.exe; a vanished configured path fails fast', t => {
  const root = scratch(t), env = { LOCALAPPDATA: root, PATH: '' };
  const old = join(root, 'OpenAI', 'Codex', 'bin', '6257d9e8f63c0f2b', 'codex.exe');
  touch(old, 1000);
  const config = loadConfig(undefined, {}, env);
  refreshCodex(config, env, 'win32');
  assert.deepEqual([config.codexExecutable, config.codexSource], [old, 'desktop']);
  // The update removes the old version folder and installs a new one (2026-10-21, 10-24).
  rmSync(join(old, '..'), { recursive: true });
  const updated = join(root, 'OpenAI', 'Codex', 'bin', '2993767bd1dfb009', 'codex.exe');
  touch(updated, 2000); touch(join(root, 'OpenAI', 'Codex', 'bin', 'c602dfdab3808440', 'rg.exe'), 3000);
  refreshCodex(config, env, 'win32');
  assert.deepEqual([config.codexExecutable, config.codexSource], [updated, 'desktop']);
  // Installed after the server started: found on the next use.
  const late = loadConfig(undefined, {}, { PATH: '' });
  assert.equal(late.codexExecutable, null);
  refreshCodex(late, env, 'win32');
  assert.equal(late.codexExecutable, updated);
  // A configured path is used as given, but a missing absolute file is reported, not spawned.
  const pinned = loadConfig(undefined, { codexExecutable: old }, env);
  assert.throws(() => refreshCodex(pinned, env, 'win32'), (error: any) => error.code === 'DEPENDENCY' && error.message.includes(old) && /--codex/.test(error.details.fix));
  const bare = loadConfig(undefined, { codexExecutable: 'codex' }, env);
  refreshCodex(bare, env, 'win32');
  assert.equal(bare.codexExecutable, 'codex');
  // A relative path with a directory is a file too (resolved like spawn does, from the cwd).
  const relative = loadConfig(undefined, { codexExecutable: join('missing-runtime', 'codex.exe') }, env);
  assert.throws(() => refreshCodex(relative, env, 'win32'), { code: 'DEPENDENCY' });
});

// On Windows the check would go on to the real desktop pipe, so it runs elsewhere only.
test('setup: acb_status names the server process and a vanished configured codex.exe, even with a configured carrier thread', { skip: process.platform === 'win32' && 'would contact the real desktop app' }, async t => {
  const root = scratch(t), gone = join(root, 'gone', 'codex.exe');
  const result: any = await status(loadConfig(undefined, { codexExecutable: gone, carrierThreadId: '00000000-0000-0000-0000-000000000001' }, { PATH: '' }));
  assert.equal(result.server.pid, process.pid); assert.match(result.server.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.codex.code, 'DEPENDENCY'); assert.ok(result.codex.message.includes(gone)); assert.match(result.codex.fix, /--codex/);
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
