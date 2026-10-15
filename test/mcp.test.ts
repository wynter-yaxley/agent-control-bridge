import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The real stdio entry starts without any configuration and declares every tool.
test('mcp: the server starts with no configuration and declares its tools and instructions', async () => {
  const client = new Client({ name: 'acb-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { PATH: '', ACB_CODEX: '', ACB_CONFIG: '' }, stderr: 'pipe' }));
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['acb_codex_create', 'acb_codex_find', 'acb_codex_send', 'acb_gpt_create', 'acb_gpt_open', 'acb_gpt_send', 'acb_projects', 'acb_status', 'acb_threads', 'acb_workspace_create']);
    assert.deepEqual(tools.find(tool => tool.name === 'acb_codex_send')!.inputSchema.required, ['threadId', 'prompt']);
    assert.match(client.getInstructions() ?? '', /Reuse existing projects and conversations/);
    // Without Codex, a Codex tool fails with a clear fix instead of crashing the server.
    const failed = await client.callTool({ name: 'acb_codex_find', arguments: { searchTerm: 'x' } });
    assert.equal(failed.isError, true);
    assert.match((failed.content as { text: string }[])[0].text, /"code":"CONFIG".*Codex was not found/);
  } finally { await client.close(); }
});
