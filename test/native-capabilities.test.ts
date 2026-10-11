import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeNativeCreationCatalog } from '../src/native-capabilities.ts';
import type { NativeToolSummary } from '../src/native-readonly.ts';

function catalog(targets = ['project', 'projectless', 'chatgptWorkCloud']): NativeToolSummary[] {
  return [
    { name: 'create_thread', namespace: 'codex_app', inputSchema: { type: 'object', required: ['prompt', 'target'], properties: {
      prompt: { type: 'string' }, target: { anyOf: targets.map(type => ({ type: 'object', additionalProperties: false, required: ['type'], properties: { type: { type: 'string', enum: [type] } } })) },
    } } },
    { name: 'list_projects', namespace: 'codex_app', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
    { name: 'set_thread_title', namespace: 'codex_app', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, threadId: { type: 'string' }, source: { type: 'string', enum: ['codex', 'chatgpt'] } } } },
  ];
}
test('native creation catalog: existing Codex, Work and rename advertisements never prove ordinary Chat or workspace creation', () => {
  const result = summarizeNativeCreationCatalog(catalog());
  assert.equal(result.createThreadSchema, 'recognized'); assert.equal(result.existingProjectCodexAdvertised, true);
  assert.equal(result.workCloudAdvertised, true); assert.equal(result.chatgptRenameAdvertised, true);
  assert.equal(result.ordinaryChatCreationVerified, false); assert.equal(result.nativeWorkspaceCreationVerified, false); assert.equal(result.ordinaryChatModeReadbackVerified, false);
  assert.equal(result.projectInventorySchemaRecognized, true);
});
test('native creation catalog: future targets and creation tools require review without enabling any RPC', () => {
  const tools = catalog(['project', 'ordinaryChat']);
  tools.push({ name: 'create_workspace', namespace: 'codex_app', inputSchema: { type: 'object' } });
  const result = summarizeNativeCreationCatalog(tools);
  assert.equal(result.createThreadSchema, 'requires-review'); assert.deepEqual(result.reviewedTargetKinds, []);
  assert.equal(result.ordinaryChatCreationVerified, false); assert.equal(result.nativeWorkspaceCreationVerified, false);
});
test('native creation catalog: absent, duplicate and referenced schemas cannot imply support', () => {
  assert.equal(summarizeNativeCreationCatalog([]).createThreadSchema, 'unavailable');
  assert.throws(() => summarizeNativeCreationCatalog([...catalog(), catalog()[0]]), { code: 'IO' });
  const tools = catalog(); tools[0].inputSchema.properties = { target: { $ref: '#/private' } };
  assert.equal(summarizeNativeCreationCatalog(tools).createThreadSchema, 'requires-review');
});
test('native creation catalog: fingerprints survive property order and tool order; changed contracts change evidence', () => {
  const tools = catalog(), first = summarizeNativeCreationCatalog(tools);
  const reordered = tools.map(tool => ({ inputSchema: tool.inputSchema, namespace: tool.namespace, name: tool.name })).reverse();
  assert.equal(summarizeNativeCreationCatalog(reordered).catalogHash, first.catalogHash);
  assert.notEqual(summarizeNativeCreationCatalog(catalog(['project'])).catalogHash, first.catalogHash);
});
