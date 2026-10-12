import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeDesktopReadClient, checkNativeDesktop } from '../src/native-readonly.ts';
import { defaults } from '../src/config.ts';
import { checkNativeProvisioningCapabilities } from '../src/native-capabilities.ts';
import { WINDOWS_POWERSHELL } from '../src/permissions.ts';
import { controlledProcessEnv } from '../src/silent-process.ts';
import { redact } from '../src/security.ts';

const carrier = '00000000-0000-0000-0000-000000000001', target = '00000000-0000-0000-0000-000000000002';
type Row = Record<string, any>;
function fixture(transform?: (envelope: Row, input: Row, child: ChildProcess) => unknown, silent = false) {
  const inputs: Row[] = [], options: Row[] = [], children: ChildProcess[] = []; let killed = 0;
  const spawnFn = ((_exe: string, _args: readonly string[], opts: Row) => {
    options.push(opts);
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'exitCode', { value: null, writable: true });
    child.stdout = new EventEmitter() as unknown as Readable; child.stderr = new EventEmitter() as unknown as Readable;
    child.kill = () => { killed++; Object.defineProperty(child, 'exitCode', { value: 1 }); queueMicrotask(() => child.emit('close', 1)); return true; };
    children.push(child);
    child.stdin = new Writable({ write(data, _enc, done) {
      const input = JSON.parse(String(data)); input.request = JSON.parse(input.requestJson); inputs.push(input);
      if (!silent) queueMicrotask(() => {
        const request = input.request, args = request.params.arguments;
        const result = request.method === 'tools/list' ? { tools: ['read_thread', 'list_threads', 'send_message_to_thread'].map(name => ({ name, namespace: 'codex_app', inputSchema: { type: 'object' }, description: 'synthetic private description' })) } : {
          success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(request.params.tool === 'list_projects' ? {
            schemaVersion: 2, projects: [{ projectId: target, projectKind: 'local', hostId: 'local', label: 'fixture', path: 'D:\\fixture' }],
          } : request.params.tool === 'list_threads' ? {
            pinnedThreads: [{ id: target, kind: 'chatgpt', title: 'synthetic-private-title' }], threads: [{ id: carrier, kind: 'codex' }],
          } : { thread: { id: args.threadId, kind: args.threadId === carrier ? 'codex' : 'chatgpt', title: 'fixture', cwd: 'synthetic-private-path',
            model: 'unproven-config-model', reasoningEffort: 'high', privateKey: 'synthetic-private-data' },
            turns: [{ id: 'actual-turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', phase: 'final', text: 'synthetic-private-message', content: [] }] }] }) }],
        };
        const envelope: Row = { ok: true, peer: { sameUserSignedHost: true, processId: 1234, processStartedAt: '2026-01-01T00:00:00.0000000Z', appVersion: '155.0.0.0', foregroundUnchanged: true }, response: { jsonrpc: '2.0', id: request.id, result } };
        const changed = transform ? transform(envelope, input, child) : envelope;
        if (changed !== undefined) child.stdout!.emit('data', Buffer.isBuffer(changed) ? changed : Buffer.from(JSON.stringify(changed)));
        Object.defineProperty(child, 'exitCode', { value: 0 }); child.emit('close', 0);
      });
      done();
    } });
    return child;
  }) as typeof spawn;
  return { spawnFn, inputs, options, children, killed: () => killed };
}
function client(f: ReturnType<typeof fixture>, extra: Row = {}) { return new NativeDesktopReadClient({ carrierThreadId: carrier, ...defaults().nativeInterface, timeoutMs: 1000, spawnFn: f.spawnFn, ...extra }); }

test('native reads: current protocol, exact target, signed peer, hidden workers and no private output', async () => {
  const f = fixture(); const result = await checkNativeDesktop({ carrierThreadId: carrier, conversationId: target, expectedTitle: 'fixture', ...defaults().nativeInterface, spawnFn: f.spawnFn });
  assert.equal(result.ok, true); assert.equal(result.target?.titleMatches, true); assert.equal(result.target?.backingKind, 'chatgpt');
  assert.equal(result.fullWorkflowReady, false); assert.equal(result.target?.ordinaryChatVerified, false); assert.equal(result.target?.actualGenerationParametersVerified, false);
  assert.equal(result.target?.projectMappingVerified, false); assert.equal(result.executionAuthorized, false);
  assert.equal(f.inputs.length, 4); assert.ok(f.options.every(o => o.windowsHide === true && o.shell === false));
  assert.deepEqual(f.inputs[0].request.params, { threadStartKind: 'all' });
  for (const input of f.inputs.slice(1)) { assert.equal(input.request.params.callerSource, 'codex'); assert.equal(input.request.params.threadId, carrier); assert.equal(input.expectedProcessId, 1234); }
  assert.equal(f.inputs[3].request.params.arguments.threadId, target); assert.equal(f.inputs[3].request.params.arguments.maxOutputCharsPerItem, 0);
  assert.ok(!JSON.stringify(result).includes('synthetic-private')); assert.ok(!JSON.stringify(result).includes('unproven-config-model'));
  assert.ok(!f.inputs.some(i => /send_message|create_thread/.test(i.request.params.tool ?? '')));
  assert.equal((client(f) as any).sendMessage, undefined);
});
test('native reads: new advertised catalog metadata does not create a write transport', async () => {
  const f=fixture(e=>{e.response.result.tools.push({name:'future_project_create',namespace:'codex_app',inputSchema:{type:'object'},description:'synthetic-private-description'});return e;});
  const c=client(f),catalog=await c.catalog();
  assert.ok(catalog.some(tool=>tool.name==='future_project_create'));assert.ok(!JSON.stringify(catalog).includes('synthetic-private'));
  assert.equal((c as any).createProject,undefined);assert.equal(f.inputs.length,1);
});
test('native reads: carrier and destination validation occurs before launching a worker', async () => {
  const f = fixture(); assert.throws(() => client(f, { carrierThreadId: 'not-an-id' }), { code: 'INPUT' });
  await assert.rejects(client(f).readSummary('bad-target'), { code: 'INPUT' }); assert.equal(f.inputs.length, 0);
});
for (const extra of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { maxCandidates: 0 }, { maxFrameBytes: 4095 }]) test('native reads: rejects invalid budget ' + JSON.stringify(extra), () => assert.throws(() => client(fixture(), extra), { code: 'CONFIG' }));
test('native reads: protocol validation refusal is IPC_CONFIG, with no raw host error disclosure', async () => {
  const f = fixture(e => { e.response = { ...e.response, result: undefined, error: { code: -32602, message: 'synthetic-private credential text' } }; return e; });
  await assert.rejects(client(f).catalog(), (error: any) => error.code === 'IPC_CONFIG' && !error.message.includes('synthetic-private'));
  assert.equal(f.inputs.length, 1);
});
test('native reads: connection peer drift never triggers discovery or replay', async () => {
  const f = fixture(e => { if (f.inputs.length > 1) e.peer.processId = 9999; return e; }), c = client(f);
  await c.catalog(); await assert.rejects(c.readSummary(carrier), { code: 'OWNER' }); assert.equal(f.inputs.length, 2);
});
test('native reads: unverified peer is refused before result processing', async () => {
  const f = fixture(e => { e.peer.sameUserSignedHost = false; return e; }); await assert.rejects(client(f).catalog(), { code: 'OWNER' });
});
test('native reads: PID reuse with a different process start time is refused', async () => {
  const f = fixture(e => { if (f.inputs.length > 1) e.peer.processStartedAt = '2026-01-02T00:00:00.0000000Z'; return e; }), c = client(f);
  await c.catalog(); await assert.rejects(c.readSummary(carrier), { code: 'OWNER' }); assert.equal(f.inputs.length, 2);
});
test('native reads: identity and response shape checks fail closed', async () => {
  for (const transform of [(e: Row) => { e.response.id = 'different'; return e; }, (e: Row) => { e.response.jsonrpc = '1.0'; return e; }, (e: Row) => { e.response.result = []; return e; }]) await assert.rejects(client(fixture(transform)).catalog(), { code: 'IO' });
});
test('native reads: wrong target cannot become source evidence', async () => {
  const f = fixture(e => { const value = JSON.parse(e.response.result.contentItems[0].text); value.thread.id = carrier; e.response.result.contentItems[0].text = JSON.stringify(value); return e; });
  await assert.rejects(client(f).readSummary(target), { code: 'PROVENANCE' });
});
test('native reads: malformed, failed and oversized result shapes are refused', async () => {
  for (const change of [
    (r: Row) => { r.success = false; }, (r: Row) => { r.contentItems = []; }, (r: Row) => { r.contentItems[0].text = 'invalid JSON'; },
    (r: Row) => { const v = JSON.parse(r.contentItems[0].text); v.turns.push(v.turns[0]); r.contentItems[0].text = JSON.stringify(v); },
  ]) await assert.rejects(client(fixture(e => { change(e.response.result); return e; })).readSummary(target), { code: 'IO' });
});
test('native reads: invalid worker JSON and UTF-8 are caught without unhandled errors', async () => {
  for (const data of [Buffer.from('broken json'), Buffer.from([0xff, 0xfe])]) await assert.rejects(client(fixture(() => data)).catalog(), { code: 'IO' });
});
test('native reads: both stdout and private stderr are bounded and only owned worker is killed', async () => {
  const stdout = fixture(() => Buffer.alloc(15000)); await assert.rejects(client(stdout, { maxFrameBytes: 4096 }).catalog(), { code: 'IO' }); assert.equal(stdout.killed(), 1);
  const stderr = fixture((e, _i, child) => { child.stderr!.emit('data', Buffer.alloc(15000)); return e; }); await assert.rejects(client(stderr, { maxFrameBytes: 4096 }).catalog(), { code: 'IO' }); assert.equal(stderr.killed(), 1);
});
test('native reads: absolute timeout and cancellation close the owned worker without retry', async () => {
  const silent = fixture(undefined, true); await assert.rejects(client(silent, { timeoutMs: 10 }).catalog(), { code: 'TIMEOUT' }); assert.equal(silent.inputs.length, 1); assert.equal(silent.killed(), 1);
  const controller = new AbortController(), f = fixture(undefined, true), c = client(f, { signal: controller.signal });
  const pending = c.catalog(); controller.abort(); await assert.rejects(pending, { code: 'TIMEOUT' }); assert.equal(f.killed(), 1);
  const pre = fixture(); await assert.rejects(client(pre, { signal: controller.signal }).catalog(), { code: 'TIMEOUT' }); assert.equal(pre.inputs.length, 0);
});
test('native reads: parallel request and exhausted session budget are refused', async () => {
  const f = fixture(), c = client(f), pending = c.catalog(); await assert.rejects(c.catalog(), { code: 'CONFLICT' }); await pending;
  await c.catalog(); await c.catalog(); await c.catalog(); await assert.rejects(c.catalog(), { code: 'STATE' }); assert.equal(f.inputs.length, 4);
});
test('native reads: ambiguous catalog and non-Codex carrier cannot enter the diagnostic workflow', async () => {
  const duplicate = fixture(e => { e.response.result.tools.push(e.response.result.tools[0]); return e; }); await assert.rejects(client(duplicate).catalog(), { code: 'IO' });
  const wrong = fixture(e => { if (e.response.result.contentItems) { const v = JSON.parse(e.response.result.contentItems[0].text); if (v.thread) v.thread.kind = 'chatgpt'; e.response.result.contentItems[0].text = JSON.stringify(v); } return e; });
  await assert.rejects(checkNativeDesktop({ carrierThreadId: carrier, ...defaults().nativeInterface, spawnFn: wrong.spawnFn }), { code: 'PROVENANCE' }); assert.equal(wrong.inputs.length, 2);
});
test('native reads: worker failure reports only a fixed stage and omits supplied diagnostics', async () => {
  const f = fixture(() => ({ ok: false, code: 'IO', stage: 'synthetic-private stage', message: 'synthetic-private diagnostic' }));
  await assert.rejects(client(f).catalog(), (error: any) => error.stage === 'unknown' && !JSON.stringify(error).includes('synthetic-private'));
});

test('native project inventory: exact identity readback is separate from creation and Codex membership', async () => {
  const f = fixture(), c = client(f);
  const result = await c.projectSummary({ appProjectId: target, workspacePath: 'd:/FIXTURE/', name: 'fixture' });
  assert.equal(result.workspaceSurface, 'native-desktop'); assert.equal(result.creationVerified, false); assert.equal(result.codexMembershipVerified, false);
  assert.deepEqual(f.inputs[0].request.params.arguments, {}); assert.equal(f.inputs[0].request.params.tool, 'list_projects');
  assert.ok(!JSON.stringify(result).includes(target)); assert.ok(!JSON.stringify(result).includes('fixture'));
});
test('native project inventory: missing expectations fail before starting a worker', async () => {
  const f = fixture();
  for (const expected of [{ appProjectId: 'bad', workspacePath: 'D:\\fixture', name: 'fixture' }, { appProjectId: target, workspacePath: 'relative', name: 'fixture' }, { appProjectId: target, workspacePath: 'D:\\fixture', name: '' }]) {
    await assert.rejects(client(f).projectSummary(expected), { code: 'INPUT' });
  }
  assert.equal(f.inputs.length, 0);
});
for (const change of [{ projectKind: 'chatgpt' }, { hostId: 'remote' }, { label: 'other' }, { path: 'D:\\foreign' }]) test('native project inventory: rejects foreign resource ' + JSON.stringify(change), async () => {
  const f = fixture(e => { const result = JSON.parse(e.response.result.contentItems[0].text); Object.assign(result.projects[0], change); e.response.result.contentItems[0].text = JSON.stringify(result); return e; });
  await assert.rejects(client(f).projectSummary({ appProjectId: target, workspacePath: 'D:\\fixture', name: 'fixture' }), { code: 'PROVENANCE' });
});
for (const scenario of ['duplicate-id', 'duplicate-path', 'unknown-schema', 'missing-id']) test('native project inventory: refuses ambiguity or missing evidence ' + scenario, async () => {
  const f = fixture(e => {
    const result = JSON.parse(e.response.result.contentItems[0].text);
    if (scenario === 'duplicate-id') result.projects.push({ ...result.projects[0] });
    if (scenario === 'duplicate-path') result.projects.push({ ...result.projects[0], projectId: carrier });
    if (scenario === 'unknown-schema') result.schemaVersion = 3;
    if (scenario === 'missing-id') result.projects = [];
    e.response.result.contentItems[0].text = JSON.stringify(result); return e;
  });
  await assert.rejects(client(f).projectSummary({ appProjectId: target, workspacePath: 'D:\\fixture', name: 'fixture' }), { code: scenario === 'duplicate-path' ? 'PROVENANCE' : scenario === 'missing-id' ? 'NOT_FOUND' : 'IO' });
});
test('native provisioning diagnostic: only catalog, carrier read and native inventory; readiness remains blocked', async () => {
  const f = fixture(e => {
    if (e.response.result.tools) e.response.result.tools.push({ name: 'list_projects', namespace: 'codex_app', inputSchema: { type: 'object', additionalProperties: false, properties: {} } });
    return e;
  });
  const result = await checkNativeProvisioningCapabilities({ carrierThreadId: carrier, ...defaults().nativeInterface, spawnFn: f.spawnFn,
    expectedProject: { appProjectId: target, workspacePath: 'D:\\fixture', name: 'fixture' } });
  assert.equal(result.state, 'BLOCKED'); assert.equal(result.project?.identityMatches, true); assert.equal(result.fullWorkflowReady, false);
  assert.equal(result.catalog.ordinaryChatCreationVerified, false); assert.equal(result.catalog.nativeWorkspaceCreationVerified, false);
  assert.equal(f.inputs.length, 3); assert.deepEqual(f.inputs.map(input => input.request.params.tool ?? input.request.method), ['tools/list', 'read_thread', 'list_projects']);
  assert.ok(f.inputs.slice(1).every(input => input.expectedProcessId === 1234)); assert.ok(!JSON.stringify(result).includes('synthetic-private'));
});
test('native provisioning diagnostic: changed inventory schema is reviewed before any project call', async () => {
  const f = fixture();
  await assert.rejects(checkNativeProvisioningCapabilities({ carrierThreadId: carrier, ...defaults().nativeInterface, spawnFn: f.spawnFn,
    expectedProject: { appProjectId: target, workspacePath: 'D:\\fixture', name: 'fixture' } }), { code: 'UNSUPPORTED' });
  assert.equal(f.inputs.length, 2);
});

test('native worker: rejects write, extra fields and invalid budgets before opening any pipe', { skip: process.platform !== 'win32' }, async () => {
  const helper = fileURLToPath(new URL('../src/native-pipe-worker.ps1', import.meta.url));
  const encoded = Buffer.from(readFileSync(helper, 'utf8'), 'utf16le').toString('base64');
  for (const input of [
    { requestJson: JSON.stringify({ jsonrpc: '2.0', id: carrier, method: 'tools/call', params: { namespace: 'codex_app', callerSource: 'codex', threadId: carrier, tool: 'list_projects', arguments: { create: true }, callId: 'acb-readonly-' + carrier, turnId: 'acb-readonly-' + carrier } }), timeoutMs: 1000, maxFrameBytes: 4096, maxCandidates: 1, expectedProcessId: null },
    { requestJson: JSON.stringify({ jsonrpc: '2.0', id: carrier, method: 'tools/call', params: { tool: 'send_message_to_thread' } }), timeoutMs: 1000, maxFrameBytes: 4096, maxCandidates: 1, expectedProcessId: null },
    { requestJson: '{}', timeoutMs: 0, maxFrameBytes: 4096, maxCandidates: 1, expectedProcessId: null },
    { requestJson: '{}', timeoutMs: 1000, maxFrameBytes: 4096, maxCandidates: 1, expectedProcessId: null, unsafe: true },
  ]) await new Promise<void>((resolve, reject) => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: controlledProcessEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // Execute fixed inline source without changing Windows script policy.
    let output = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error(redact(`Owned worker test exceeded its budget (exit=${child.exitCode}, stdout=${output}, stderr=${stderr})`))); }, 15000);
    child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { stderr += data.toString(); }); child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); try { const result = JSON.parse(output); assert.equal(code, 0); assert.equal(result.ok, false); assert.equal(result.stage, 'input'); resolve(); } catch (e) { reject(e); } });
    child.stdin.end(JSON.stringify(input));
  });
  assert.ok(!/ExecutionPolicy|Stop-Process|SetForegroundWindow|SendKeys|clipboard/i.test(readFileSync(helper, 'utf8')));
});
