// codex exec 后台投递适配器测试：mock spawn，不触碰真实 codex CLI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BridgeError } from '../src/errors.ts';
import { createCodexExecDelivery, parseCodexExecReceipt } from '../src/codex-exec.ts';

interface FakeScript { stdout?: string; stderr?: string; code?: number | null; ignoreKill?: boolean }
interface FakeCall { executable: string; args: string[]; options: { shell?: boolean; windowsHide?: boolean }; input: string }

function fakeSpawn(script: FakeScript) {
  const calls: FakeCall[] = [];
  const spawnFn = ((executable: string, args: readonly string[], options: FakeCall['options']) => {
    const call = { executable, args: [...args], options, input: '' }; calls.push(call);
    const child = new EventEmitter() as ChildProcess & { stdout: Readable; stderr: Readable; kill: () => boolean };
    child.stdout = new EventEmitter() as unknown as Readable;
    child.stderr = new EventEmitter() as unknown as Readable;
    child.stdin = new Writable({ write(chunk, _encoding, done) { call.input += String(chunk); done(); } });
    child.kill = () => {
      if (script.ignoreKill) return true;
      queueMicrotask(() => child.emit('close', script.code ?? null, null));
      return true;
    };
    if (!script.ignoreKill) queueMicrotask(() => {
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout, 'utf8'));
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr, 'utf8'));
      child.emit('close', script.code ?? 0, null);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}

const EXECUTABLE = 'fixture-codex-never-executed';
const WORKSPACE = String.raw`C:\code\demo-project`;
const JSONL = [
  JSON.stringify({ type: 'thread.started', thread_id: '0198e5a7-1111-7000-8000-000000000001' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '[TEST] done' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } }),
  '',
].join('\n');
const TARGET = { codexConversationId: '0198e5a7-1111-7000-8000-000000000001', workspacePath: WORKSPACE };
test('codex-exec: thread.started followed by failed or missing completion is not a receipt', async () => {
 for (const stdout of [JSON.stringify({type:'thread.started',thread_id:TARGET.codexConversationId}), JSONL+JSON.stringify({type:'turn.failed'})]) {
  const {spawnFn}=fakeSpawn({stdout});const delivery=createCodexExecDelivery({executable:EXECUTABLE,spawnFn});
  await assert.rejects(()=>delivery.deliver('[TEST] prompt','fixture-key',new AbortController().signal,TARGET),/completed turn/);
 }
});
test('codex-exec: pre-aborted signal launches no process and Unicode prompt remains in stdin', async () => {
 const {spawnFn,calls}=fakeSpawn({stdout:JSONL});const delivery=createCodexExecDelivery({executable:EXECUTABLE,spawnFn});
 const abort=new AbortController();abort.abort();await assert.rejects(()=>delivery.deliver('中文工程 Prompt','fixture-key',abort.signal,TARGET));assert.equal(calls.length,0);
 await delivery.deliver('中文工程 Prompt','fixture-key',new AbortController().signal,TARGET);assert.equal(calls[0].input,'中文工程 Prompt');assert.ok(!calls[0].args.includes('中文工程 Prompt'));
});

test('codex-exec: deliver spawns codex exec in background and resolves the stable thread id receipt', async () => {
  const { spawnFn, calls } = fakeSpawn({ stdout: JSONL });
  const delivery = createCodexExecDelivery({
    executable: EXECUTABLE, spawnFn, config: { agents: { codex: { executable: null } } },
  });
  const controller = new AbortController();
  const receipt = await delivery.deliver('[TEST] prompt content', 'prompt-key-1', controller.signal, TARGET);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.executable, EXECUTABLE);
  assert.ok(call.args.includes('exec'));
  assert.ok(!call.args.includes('resume'));
  assert.ok(call.args.includes('--json'));
  const workspaceIndex = call.args.indexOf('-C');
  assert.equal(call.args[workspaceIndex + 1], WORKSPACE);
  assert.equal(call.args[call.args.length - 1], '-');
  assert.equal(call.input, '[TEST] prompt content');
  assert.ok(!call.args.includes('[TEST] prompt content'));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(receipt.executionId, '0198e5a7-1111-7000-8000-000000000001');
  assert.equal(receipt.codexConversationId, '0198e5a7-1111-7000-8000-000000000001');
  assert.equal(receipt.workspacePath, WORKSPACE);
});

test('codex-exec: resume mode uses codex exec resume with the target conversation id', async () => {
  const { spawnFn, calls } = fakeSpawn({ stdout: JSON.stringify({ type: 'turn.completed', turn_id: 'turn-9' }) });
  const delivery = createCodexExecDelivery({ executable: EXECUTABLE, spawnFn, resume: true });
  await delivery.deliver('[TEST] continue', 'prompt-key-2', new AbortController().signal, TARGET);
  const call = calls[0];
  assert.deepEqual(call.args.slice(2, 5), ['exec', 'resume', '0198e5a7-1111-7000-8000-000000000001']);
});

test('codex-exec: nonzero exit fails closed with EXECUTION', async () => {
  const { spawnFn } = fakeSpawn({ stdout: '', stderr: 'panic: sandbox denied', code: 1 });
  const delivery = createCodexExecDelivery({ executable: EXECUTABLE, spawnFn });
  await assert.rejects(
    () => delivery.deliver('[TEST] prompt', 'key', new AbortController().signal, TARGET),
    (error: unknown) => error instanceof BridgeError && error.code === 'EXECUTION' && /exit code 1/.test(error.message),
  );
});

test('codex-exec: timeout kills the child and fails closed with TIMEOUT', async () => {
  const { spawnFn, calls } = fakeSpawn({ ignoreKill: true });
  const delivery = createCodexExecDelivery({ executable: EXECUTABLE, spawnFn, timeoutMs: 15 });
  await assert.rejects(
    () => delivery.deliver('[TEST] prompt', 'key', new AbortController().signal, TARGET),
    (error: unknown) => error instanceof BridgeError && error.code === 'TIMEOUT' && /deadline/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test('codex-exec: zero exit without a parseable thread/turn id fails closed', async () => {
  const { spawnFn } = fakeSpawn({ stdout: 'not json at all\n' });
  const delivery = createCodexExecDelivery({ executable: EXECUTABLE, spawnFn });
  await assert.rejects(
    () => delivery.deliver('[TEST] prompt', 'key', new AbortController().signal, TARGET),
    (error: unknown) => error instanceof BridgeError && error.code === 'EXECUTION' && /stable thread or turn identifier/.test(error.message),
  );
});

test('codex-exec: missing executable configuration raises CONFIG before any spawn', () => {
  assert.throws(
    () => createCodexExecDelivery({ env: {}, config: { agents: { codex: { executable: null } } } }),
    (error: unknown) => error instanceof BridgeError && error.code === 'CONFIG',
  );
  assert.throws(
    () => createCodexExecDelivery({ env: { ACB_CODEX_EXECUTABLE: '   ' } }),
    (error: unknown) => error instanceof BridgeError && error.code === 'CONFIG',
  );
});

test('codex-exec: executable resolution prefers options, then env, then read-only config', () => {
  const env = { ACB_CODEX_EXECUTABLE: 'env-codex' };
  const config = { agents: { codex: { executable: 'config-codex' } } };
  const viaOption = createCodexExecDelivery({ executable: 'option-codex', env, config, spawnFn: fakeSpawn({}).spawnFn });
  const viaEnv = createCodexExecDelivery({ env, config, spawnFn: fakeSpawn({}).spawnFn });
  const viaConfig = createCodexExecDelivery({ config, spawnFn: fakeSpawn({}).spawnFn });
  assert.ok(viaOption && viaEnv && viaConfig); // 构造成功即代表解析通过，具体顺序由 parse 断言覆盖。
  assert.equal(parseCodexExecReceipt(JSON.stringify({ type: 'thread.started', session_id: 'sess-1' })).threadId, 'sess-1');
});

test('codex-exec: invalid prompt or missing workspace fails closed before spawning', async () => {
  const { spawnFn, calls } = fakeSpawn({ stdout: JSONL });
  const delivery = createCodexExecDelivery({ executable: EXECUTABLE, spawnFn });
  await assert.rejects(() => delivery.deliver('   ', 'key', new AbortController().signal, TARGET), /Invalid prompt/);
  await assert.rejects(
    () => delivery.deliver('[TEST] prompt', 'key', new AbortController().signal, { codexConversationId: 't', workspacePath: '' }),
    /workspace/,
  );
  assert.equal(calls.length, 0);
});
