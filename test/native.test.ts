import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient, NativeReadWorker } from '../src/native.ts';

test('native inventory: requests the supported 50 rows, keeps pinned chats, and does not assume recency sorting', async () => {
  const requests: any[] = [];
  const worker = new NativeReadWorker();
  worker.request = async input => {
    const request = JSON.parse(String(input.requestJson)); requests.push(request);
    return { ok: true, peer: { sameUserSignedHost: true, processId: 7, processStartedAt: 'stable' }, response: {
      jsonrpc: '2.0', id: request.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
        pinnedThreads: [{ id: 'pinned', kind: 'chatgpt', title: 'pinned' }],
        threads: Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, kind: 'chatgpt', title: i === 49 ? 'new chat under manual sorting' : `old ${i}` })),
        sidebarPreferences: { sorting: { chats: 'manual' } },
      }) }] },
    } };
  };
  const native = new NativeClient({ worker, carrierThreadId: '00000000-0000-0000-0000-000000000001', timeoutMs: 1000, maxFrameBytes: 2097152, maxCandidates: 128 });
  const rows = await native.listThreads();
  assert.deepEqual(requests[0].params.arguments, { limit: 50 });
  assert.equal(rows.length, 51); assert.equal(rows[0].id, 'pinned');
  assert.equal(rows[50].title, 'new chat under manual sorting');
});
