// Acceptance run against the real desktop app through dist/mcp.js. It creates one Codex and
// one ChatGPT conversation named "ACB smoke <time>" and stops at the first failure.
// Usage: npm run smoke [-- --scope codex|gpt]
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: { scope: { type: 'string', default: 'all' } } });
if (!['all', 'codex', 'gpt'].includes(values.scope)) throw new Error('--scope must be all, codex or gpt');
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const name = `ACB smoke ${stamp}`;

const client = new Client({ name: 'acb-smoke', version: '1' });
const entry = fileURLToPath(new URL('../dist/mcp.js', import.meta.url));
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'inherit' }));

async function call(step, tool, args = {}) {
  const started = Date.now();
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
  const value = JSON.parse(result.content[0].text);
  console.log(
    `${result.isError ? 'FAIL' : 'OK'} ${step} ${tool} ${Date.now() - started}ms ${JSON.stringify(value).slice(0, 400)}`,
  );
  if (result.isError) await stop(1);
  return value;
}

async function expect(step, condition) {
  if (condition) return;
  console.log(`FAIL ${step}`);
  await stop(1);
}

async function stop(code) {
  await client.close();
  process.exit(code);
}

await call('status', 'acb_status');

if (values.scope !== 'gpt') {
  const created = await call('codex-create', 'acb_codex_create', {
    prompt: `${name}: reply with exactly ACB_CODEX_READY. Do not run commands or edit files.`,
    title: name,
    folder: `acb-smoke-${stamp}`,
  });
  await expect('codex-create reply', created.turn.reply.includes('ACB_CODEX_READY'));
  const listed = await call('codex-list', 'acb_codex_list', { limit: 50 });
  await expect(
    'codex-list contains it',
    listed.some((thread) => thread.id === created.threadId),
  );
  const prompt = `${name}: reply with exactly ACB_CODEX_OK. Do not run commands or edit files.`;
  const sent = await call('codex-send', 'acb_codex_send', { threadId: created.threadId, prompt });
  await expect('codex-send reply', sent.turn.reply.includes('ACB_CODEX_OK'));
  const again = await call('codex-send-again', 'acb_codex_send', { threadId: created.threadId, prompt });
  await expect('codex-send-again is not resent', again.alreadySent && again.turn.turnId === sent.turn.turnId);
  const read = await call('codex-read', 'acb_codex_read', { threadId: created.threadId, turns: 3 });
  await expect('codex-read shows both turns', read.turns.length === 2 && read.turns[1].turnId === sent.turn.turnId);
  await call('open', 'acb_open', { id: created.threadId });
}

if (values.scope !== 'codex') {
  const created = await call('gpt-create', 'acb_gpt_create', {
    prompt: `${name}: reply with exactly ACB_GPT_READY`,
    title: name,
  });
  await expect('gpt-create reply', created.turn.reply?.includes('ACB_GPT_READY') && created.title === name);
  const listed = await call('gpt-list', 'acb_gpt_list', { limit: 50 });
  await expect(
    'gpt-list contains it',
    listed.some((thread) => thread.id === created.conversationId),
  );
  const prompt = `${name}\n\nThis message has blank lines.\n\nReply with exactly ACB_GPT_OK`;
  const sent = await call('gpt-send', 'acb_gpt_send', { conversationId: created.conversationId, prompt });
  await expect('gpt-send reply', sent.turn.reply?.trim() === 'ACB_GPT_OK');
  const read = await call('gpt-read', 'acb_gpt_read', { conversationId: created.conversationId, turns: 2, page: true });
  await expect('gpt-read shows the reply', read.turns.at(-1).reply?.trim() === 'ACB_GPT_OK');
}

console.log(`ACCEPTANCE_DONE scope=${values.scope}`);
await stop(0);
