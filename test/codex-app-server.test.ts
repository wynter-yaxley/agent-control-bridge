import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import { resolve } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { createCodexAppServerExecutor, inspectCodexThread } from '../src/codex-app-server.ts';
import { BridgeError } from '../src/errors.ts';

const workspace = resolve('fixture 中文 app-server');
const target = { codexConversationId: 'fixture-thread', workspacePath: workspace };
type Mode = 'normal' | 'early' | 'failed' | 'interrupted' | 'wrong-thread' | 'wrong-turn' | 'reroute' | 'approval' | 'command-approval' | 'early-approval' | 'disconnect' | 'silent-turn' | 'silent-interrupt' | 'silent-start' | 'bad-id' | 'wrong-project' | 'null-project' | 'wrong-root' | 'active' | 'wrong-model' | 'broad-sandbox' | 'corrupt' | 'oversize' | 'bad-spawn';
function fixture(mode: Mode = 'normal') {
  const requests: Record<string, unknown>[] = [];
  let hidden = false, killed = 0, exclusive = 0;
  const spawnFn = ((_executable: string, args: string[], options: { shell?: boolean; windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => {
    assert.deepEqual(args.slice(-3), ['app-server', '--listen', 'stdio://']);
    if (args.length > 3) assert.ok(JSON.stringify(args.slice(0, -3)) === JSON.stringify(['-c', 'mcp_servers.fixture-bridge.enabled=false']) || JSON.stringify(args.slice(0, -3)) === JSON.stringify(['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps']));
    hidden = options.shell === false && options.windowsHide === true;
    assert.equal(options.env?.ACB_REVIEWER, undefined);
    if (mode === 'bad-spawn') throw new Error('synthetic-private-diagnostic');
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as unknown as Readable;
    child.stderr = new EventEmitter() as unknown as Readable;
    child.kill = () => { killed++; queueMicrotask(() => child.emit('close', 0)); return true; };
    const emit = (value: unknown) => child.stdout!.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    const thread = () => ({ id: mode === 'bad-id' ? 'foreign-thread' : target.codexConversationId,
      projectId: mode === 'null-project' ? null : mode === 'wrong-project' ? 'foreign-project' : 'native-project',
      cwd: mode === 'wrong-root' ? resolve('foreign') : workspace, source: 'appServer', status: { type: mode === 'active' ? 'active' : 'idle' },
      preview: 'synthetic-private-preview', turns: [{ text: 'synthetic-private-history' }] });
    const completed = (status = 'completed', threadId = target.codexConversationId, turnId = 'fixture-turn') => ({ method: 'turn/completed', params: { threadId, ...(mode === 'wrong-turn' && turnId === 'foreign-turn' ? { turnId: 'fixture-turn' } : {}), turn: { id: turnId, status, error: status === 'failed' ? { message: 'synthetic-private-diagnostic' } : null } } });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk)); requests.push(message); done();
      if (mode==='command-approval' && message.id==='fixture-approval' && message.result?.decision==='accept') {queueMicrotask(()=>emit(completed()));return;}
      if (message.id === undefined || message.method === undefined) return;
      queueMicrotask(() => {
        if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'fixture' } });
        else if (message.method === 'thread/read') {
          if (mode === 'corrupt') child.stdout!.emit('data', Buffer.from('{invalid}\n'));
          else if (mode === 'oversize') child.stdout!.emit('data', Buffer.alloc(1024 * 1024 + 1, 65));
          else emit({ id: message.id, result: { thread: message.params.includeTurns ? { ...thread(), turns: [{ id: 'fixture-turn', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'fixture-commentary', text: 'Working...', phase: 'commentary' }, { type: 'agentMessage', id: 'fixture-answer', text: '[ISOLATED TEST] final output', phase: 'final_answer' }] }] } : thread() } });
        } else if (message.method === 'thread/resume') emit({ id: message.id, result: { thread: thread(), cwd: workspace, model: mode === 'wrong-model' ? 'gpt-foreign' : 'gpt-fixture', reasoningEffort: 'high', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', writableRoots: mode === 'broad-sandbox' ? [workspace, resolve('foreign')] : [workspace], networkAccess: false } } });
        else if (message.method === 'turn/start') {
          if (mode === 'silent-start') return;
          if (mode === 'disconnect') { child.emit('close', 1); return; }
          if (mode === 'early') emit(completed());
          if (mode === 'early-approval') emit({ id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: { threadId: target.codexConversationId, turnId: 'fixture-turn', command: 'private command' } });
          emit({ id: message.id, result: { turn: { id: 'fixture-turn', status: 'inProgress', items: [], error: null } } });
          if(mode==='command-approval') {setImmediate(()=>emit({id:'fixture-approval',method:'item/commandExecution/requestApproval',params:{threadId:target.codexConversationId,turnId:'fixture-turn',command:'[TEST] command'}}));return;}
          queueMicrotask(() => {
            if (['early', 'early-approval', 'silent-turn', 'silent-interrupt'].includes(mode)) return;
            if (mode === 'approval') emit({ id: 'fixture-approval', method: 'item/permissions/requestApproval', params: { threadId: target.codexConversationId, turnId: 'fixture-turn' } });
            else if (mode === 'reroute') emit({ method: 'model/rerouted', params: { threadId: target.codexConversationId, turnId: 'fixture-turn', toModel: 'gpt-foreign', reason: 'private-reason' } });
            else emit(completed(mode === 'failed' ? 'failed' : mode === 'interrupted' ? 'interrupted' : 'completed', mode === 'wrong-thread' ? 'foreign-thread' : target.codexConversationId, mode === 'wrong-turn' ? 'foreign-turn' : 'fixture-turn'));
          });
        } else if (message.method === 'turn/interrupt' && mode !== 'silent-interrupt') { emit({ id: message.id, result: {} }); emit(completed('interrupted')); }
      });
    } });
    return child;
  }) as typeof spawn;
  const hostInspect = async () => ({ source: 'codex-app-state' as const, local: true, conversationId: target.codexConversationId, appProjectId: 'native-project', workspacePath: workspace });
  const options = { durableExecution:false, executable: 'fixture', timeoutMs: 250, interruptTimeoutMs: 100, model: 'gpt-fixture', reasoningEffort: 'high', selfMcpServerName: 'fixture-bridge', spawnFn, inspect: hostInspect, assertExclusive: async () => { exclusive++; } };
  return { requests, options, hidden: () => hidden, killed: () => killed, exclusive: () => exclusive };
}
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected && !error.message.includes('synthetic-private');

test('app-server: read-only inspection omits private content and closes its own hidden process', async () => {
  const f = fixture();
  const result = await inspectCodexThread({ ...f.options, conversationId: target.codexConversationId });
  assert.equal(result.appProjectId, 'native-project'); assert.equal(result.local, true);
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  assert.deepEqual(f.requests.map(r => r.method), ['initialize', 'initialized', 'thread/read']);
  assert.equal((f.requests[0].params as { capabilities: { experimentalApi: boolean } }).capabilities.experimentalApi, true);
  assert.equal((f.requests[2].params as Record<string, unknown>).includeTurns, false);
  assert.equal(f.hidden(), true); assert.equal(f.killed(), 1);
});
for (const mode of ['normal', 'early', 'null-project'] as const) test(`app-server: ${mode} exact completed turn, hidden stdin delivery, separate host ownership`, async () => {
  const f = fixture(mode), events: Record<string, unknown>[] = [], executor = createCodexAppServerExecutor(f.options);
  assert.equal((await executor.inspect(target, new AbortController().signal)).appProjectId, 'native-project');
  const receipt = await executor.execute('[ISOLATED TEST] 中文 engineering prompt', 'fixture-dispatch', target, new AbortController().signal, event => events.push(event));
  assert.equal(receipt.executionId, 'fixture-turn'); assert.equal(receipt.codexConversationId, target.codexConversationId);
  assert.deepEqual(receipt.output, { content: '[ISOLATED TEST] final output', messageIds: ['fixture-answer'] });
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1); assert.equal(f.exclusive(), 2);
  const start = f.requests.find(r => r.method === 'turn/start')!.params as Record<string, unknown>;
  assert.equal(start.model, 'gpt-fixture'); assert.equal(start.effort, 'high'); assert.equal(start.clientUserMessageId, 'fixture-dispatch');
  assert.equal(start.approvalPolicy, 'untrusted'); assert.equal((start.sandboxPolicy as Record<string, unknown>).networkAccess, false);
  assert.equal(events.at(-1)?.type, 'turn.completed'); assert.ok(!JSON.stringify(events).includes('engineering prompt'));
  assert.ok(!f.requests.some(r => String(r.method).includes('login')));
});
for (const mode of ['bad-id', 'wrong-project', 'wrong-root', 'active', 'wrong-model', 'broad-sandbox'] as const) test(`app-server: ${mode} blocks before dispatch`, async () => {
  const f = fixture(mode), executor = createCodexAppServerExecutor(f.options);
  await assert.rejects(executor.execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code(mode === 'active' ? 'CONFLICT' : 'PROVENANCE'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 0);
});
for (const mode of ['silent-start', 'silent-interrupt'] as const) test(`app-server: ${mode} retains uncertainty and never guesses or replays a turn`, async () => {
  const f = fixture(mode); f.options.timeoutMs = 30; f.options.interruptTimeoutMs = 20;
  await assert.rejects(createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code('TIMEOUT'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'turn/interrupt').length, mode === 'silent-start' ? 0 : 1);
});
for (const mode of ['failed', 'interrupted', 'disconnect'] as const) test(`app-server: ${mode} never yields a completed receipt or replays`, async () => {
  const f = fixture(mode);
  await assert.rejects(createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code('EXECUTION'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});
for (const mode of ['wrong-thread', 'wrong-turn', 'silent-turn'] as const) test(`app-server: ${mode} cannot complete this turn; deadline interrupts only its actual ID`, async () => {
  const f = fixture(mode); f.options.timeoutMs = 30;
  await assert.rejects(createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code('TIMEOUT'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  const interrupt = f.requests.find(r => r.method === 'turn/interrupt')!;
  assert.deepEqual(interrupt.params, { threadId: target.codexConversationId, turnId: 'fixture-turn' });
});
for (const mode of ['approval', 'early-approval', 'reroute'] as const) test(`app-server: ${mode} is refused and interrupted without escalation`, async () => {
  const f = fixture(mode);
  await assert.rejects(createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code(mode === 'reroute' ? 'PROVENANCE' : 'AUTH'));
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'turn/interrupt').length, 1);
  if (mode !== 'reroute') assert.equal((f.requests.find(r => r.id === 'fixture-approval')!.error as Record<string, unknown>).code, -32601);
  assert.ok(!JSON.stringify(f.requests).includes('acceptForSession'));
});
test('app-server: active abort interrupts once; pre-aborted execution never launches a process', async () => {
  const f = fixture('silent-turn'), abort = new AbortController();
  const execution = createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(execution, code('TIMEOUT'));
  assert.equal(f.requests.filter(r => r.method === 'turn/interrupt').length, 1);
  const before = fixture(); abort.abort();
  await assert.rejects(createCodexAppServerExecutor(before.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, abort.signal), code('TIMEOUT'));
  assert.equal(before.requests.length, 0);
});
test('app-server: persistence failure interrupts the turn and never reports success', async () => {
  const f = fixture();
  await assert.rejects(createCodexAppServerExecutor(f.options).execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal, () => { throw new Error('synthetic-private-diagnostic'); }), code('IO'));
  assert.equal(f.requests.filter(r => r.method === 'turn/interrupt').length, 1);
});
for (const mode of ['corrupt', 'oversize', 'bad-spawn'] as const) test(`app-server: ${mode} rejects boundedly with fixed diagnostics`, async () => {
  const f = fixture(mode);
  await assert.rejects(inspectCodexThread({ ...f.options, conversationId: target.codexConversationId }), code(mode === 'bad-spawn' ? 'DEPENDENCY' : 'EXECUTION'));
});
test('app-server: exclusion failure and invalid prompt block before any model turn', async () => {
  const f = fixture();
  const executor = createCodexAppServerExecutor({ ...f.options, assertExclusive: async () => { throw new BridgeError('CONFLICT', 'Thread is occupied'); } });
  await assert.rejects(executor.execute('[ISOLATED TEST] prompt', 'fixture-dispatch', target, new AbortController().signal), code('CONFLICT'));
  assert.equal(f.requests.length, 0);
  await assert.rejects(executor.execute('', 'fixture-dispatch', target, new AbortController().signal), code('INPUT'));
});

test('app-server: recovery reads exact original turn without resume/start or resending',async()=>{
 const f=fixture(),executor=createCodexAppServerExecutor(f.options);
 const receipt=await executor.observeExecution!('[TEST] original',target,'2000-01-01',new AbortController().signal,{executionId:'fixture-turn',dispatchId:'original-dispatch'});
 assert.equal(receipt.executionId,'fixture-turn');assert.equal(receipt.output!.messageIds[0],'fixture-answer');
 assert.ok(!f.requests.some(request=>['turn/start','thread/resume'].includes(String(request.method))));
});

test('app-server: only the installed host approves the exact original command request',async()=>{
 const f=fixture('command-approval');let approved=0;
 const executor=createCodexAppServerExecutor({...f.options,approve:async(request,signal)=>{assert.equal(signal.aborted,false);assert.equal(request.target.codexConversationId,target.codexConversationId);assert.equal(request.params.turnId,'fixture-turn');assert.equal(request.dispatchId,'fixture-dispatch');approved++;return 'accept';}});
 const receipt=await executor.execute('[TEST] authorized prompt','fixture-dispatch',target,new AbortController().signal);
 assert.equal(receipt.executionId,'fixture-turn');assert.equal(approved,1);assert.equal(f.requests.filter(r=>r.method==='turn/start').length,1);
});
