import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { checkCodexProjectProvisioning } from '../src/codex-app-server.ts';

type Row = Record<string, any>;
type Mode = 'normal' | 'wrong-roots' | 'changed-replay' | 'project-collision' | 'wrong-membership' | 'wrong-cwd' | 'wrong-title' | 'cold-membership' | 'cold-title' | 'mixed-listing' | 'empty-listing' | 'unsupported' | 'approval' | 'activity' | 'silent';
function fixture(mode: Mode = 'normal') {
  const requests: Row[] = [], roots: string[] = [], projects = new Map<string, Row>(), keys = new Map<string, string>(), threads = new Map<string, Row>();
  let connections = 0, kills = 0;
  const spawnFn = ((_exe: string, args: string[], options: Row) => {
    assert.deepEqual(args, ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps', 'app-server', '--listen', 'stdio://']); assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    assert.equal(existsSync(join(options.env.CODEX_HOME, 'auth.json')), false); roots.push(options.cwd); connections++;
    const cold = connections > 1, child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as unknown as Readable; child.stderr = new EventEmitter() as unknown as Readable;
    let exited = false;
    const close = () => { if (!exited) { exited = true; queueMicrotask(() => child.emit('exit', 0)); } };
    child.kill = () => { kills++; close(); return true; };
    const emit = (value: unknown) => child.stdout!.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    const thread = (item: Row) => ({ ...item, status: { type: cold ? 'notLoaded' : 'idle' }, source: 'appServer', ephemeral: false, preview: 'private fixture text' });
    child.stdin = new Writable({ final(done) { done(); close(); }, write(data, _encoding, done) {
      const message = JSON.parse(String(data)); requests.push(message); done();
      if (message.id === undefined || !message.method) return;
      queueMicrotask(() => {
        if (mode === 'silent') return;
        const p = message.params;
        let result: Row = {};
        if (message.method === 'initialize') assert.equal(p.capabilities.experimentalApi, true);
        else if (message.method === 'project/create') {
          if (mode === 'unsupported') { emit({ id: message.id, error: { code: -32601, message: 'private refusal text' } }); return; }
          if (mode === 'approval') { emit({ id: 'request', method: 'account/login/start', params: { private: 'fixture' } }); return; }
          let id = keys.get(p.idempotencyKey);
          if (!id) { id = mode === 'project-collision' ? 'same-project' : `project-${projects.size + 1}`; keys.set(p.idempotencyKey, id); projects.set(id, { id, name: p.name, roots: p.roots }); }
          result = { project: { ...projects.get(id), ...(mode === 'changed-replay' && requests.filter(x => x.method === 'project/create').length === 2 ? { id: 'foreign-project' } : {}) } };
        } else if (message.method === 'project/read') result = { project: { ...projects.get(p.projectId), ...(mode === 'wrong-roots' ? { roots: [{ path: join(options.cwd, 'foreign') }] } : {}) } };
        else if (message.method === 'model/list') result = { data: [{ model: 'gpt-fixture' }], nextCursor: null };
        else if (message.method === 'thread/start') {
          const item = { id: `thread-${threads.size + 1}`, projectId: p.projectId, cwd: p.cwd, name: null };
          threads.set(item.id, item);
          if (mode === 'activity') { emit({ method: 'turn/started', params: {} }); return; }
          result = { thread: thread({ ...item, ...(mode === 'wrong-membership' ? { projectId: 'foreign-project' } : {}), ...(mode === 'wrong-cwd' ? { cwd: join(p.cwd, 'foreign') } : {}) }), sandbox: { type: 'readOnly' }, approvalPolicy: 'untrusted' };
        } else if (message.method === 'thread/name/set') threads.get(p.threadId)!.name = p.name;
        else if (message.method === 'thread/read') result = { thread: thread({ ...threads.get(p.threadId), ...(mode === 'wrong-title' || mode === 'cold-title' && cold ? { name: 'ACB 精确命名' } : {}), ...(mode === 'cold-membership' && cold ? { projectId: 'foreign-project' } : {}) }) };
        else if (message.method === 'project/list') result = { data: [...projects.values()], nextCursor: null };
        else if (message.method === 'thread/list') result = { data: mode === 'empty-listing' ? [] : [...threads.values()].filter(item => mode === 'mixed-listing' || item.projectId === p.projectId).map(thread), nextCursor: null };
        else assert.fail('Unexpected diagnostic method');
        emit({ id: message.id, result });
      });
    } });
    return child;
  }) as typeof spawn;
  return { options: { executable: 'fixture', timeoutMs: 1000, spawnFn }, requests, roots, kills: () => kills };
}

test('project API: two durable projects, exact names, 3+1 assigned threads and cold readback', async () => {
  const f = fixture(), result = await checkCodexProjectProvisioning(f.options);
  assert.equal(result.ok, true); assert.equal(result.stage, 'complete'); assert.equal(result.projectListMatches, true);
  assert.equal(result.projects.length, 2); assert.ok(result.projects.every(x => x.created && x.idempotent && x.readback && x.persisted));
  assert.equal(result.conversations.length, 4); assert.ok(result.conversations.every(x => x.created && x.projectMatches && x.workspaceMatches && x.titleMatches && x.persisted));
  assert.deepEqual(result.listingCounts.map(x => x.observed), [3, 1]); assert.equal(result.uniqueConversationIds, true);
  assert.equal(result.nativeDesktopVerified, false); assert.equal(result.ordinaryGptCreationVerified, false); assert.equal(result.fullWorkflowReady, false);
  assert.equal(result.temporaryResourcesRemoved, true); assert.ok(f.roots.every(root => !existsSync(root))); assert.equal(f.kills(), 0);
  assert.ok(!f.requests.some(x => /turn\/start|login|account\/|delete/.test(x.method)));
  assert.ok(!JSON.stringify(result).includes('private')); assert.equal(f.requests.filter(x => x.method === 'thread/name/set').length, 8);
});
test('project API: empty dormant-thread inventory is PARTIAL, never full-workflow readiness', async () => {
  const result = await checkCodexProjectProvisioning(fixture('empty-listing').options);
  assert.equal(result.ok, false); assert.equal(result.code, 'PARTIAL'); assert.deepEqual(result.listingCounts.map(x => x.observed), [0, 0]);
  assert.ok(result.conversations.every(x => x.persisted)); assert.equal(result.temporaryResourcesRemoved, true);
});
test('project API: identity-only omits listing calls and marks the skipped evidence explicitly', async () => {
  const f = fixture(), result = await checkCodexProjectProvisioning({ ...f.options, includeListings: false });
  assert.equal(result.ok, false); assert.equal(result.code, 'PARTIAL'); assert.equal(result.listingsSkipped, true);
  assert.ok(result.conversations.every(x => x.persisted)); assert.equal(result.temporaryResourcesRemoved, true);
  assert.equal(f.requests.filter(x => x.method === 'thread/list' || x.method === 'project/list').length, 0);
});
for (const mode of ['wrong-roots', 'changed-replay', 'project-collision', 'wrong-membership', 'wrong-cwd', 'wrong-title', 'cold-membership', 'cold-title', 'mixed-listing', 'unsupported', 'approval', 'activity'] as const) test(`project API: ${mode} refuses a usable bundle`, async () => {
  const f = fixture(mode), result = await checkCodexProjectProvisioning(f.options);
  assert.equal(result.ok, false); assert.equal(result.fullWorkflowReady, false); assert.equal(result.temporaryResourcesRemoved, true);
  assert.ok(f.roots.every(root => !existsSync(root))); assert.ok(!JSON.stringify(result).includes('private'));
  if (mode === 'unsupported') assert.equal(result.rpcErrorCode, -32601);
});
test('project API: cancellation and deadlines do not leak the owned test home', async () => {
  const f = fixture('silent'), result = await checkCodexProjectProvisioning({ ...f.options, timeoutMs: 20 });
  assert.equal(result.code, 'TIMEOUT'); assert.equal(result.temporaryResourcesRemoved, true);
  const before = fixture(); await assert.rejects(checkCodexProjectProvisioning({ ...before.options, signal: AbortSignal.abort() }), { code: 'TIMEOUT' }); assert.equal(before.requests.length, 0);
});
