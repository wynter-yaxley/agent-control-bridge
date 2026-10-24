// One real Windows smoke run through dist/mcp.js, stopping at the first failure. --scope codex|gpt
// checks one independent tool group (default all, which also relays a GPT reply to Codex).
// Optional --gpt-conversation / --codex-thread resume known isolated chats after a failure; never repeat creation or an initialization marker.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, 'gpt-conversation': { type: 'string' }, 'codex-thread': { type: 'string' }, scope: { type: 'string', default: 'all' } }, strict: true });
if (!values.name) throw new Error('--name is required');
if (!['all', 'codex', 'gpt'].includes(values.scope)) throw new Error('--scope must be all, codex or gpt');
const codexScope = values.scope !== 'gpt', gptScope = values.scope !== 'codex';
const log = (step, value) => console.log(`${step} ${JSON.stringify(value)}`);

const client = new Client({ name: 'acb-acceptance', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/mcp.js', import.meta.url)),
  ...(values.config ? ['--config', values.config] : []), ...(values['carrier-thread'] ? ['--carrier-thread', values['carrier-thread']] : []), ...(values.codex ? ['--codex', values.codex] : []), '--allow-foreground-input'], stderr: 'inherit' }));
const call = async (step, name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const value = JSON.parse(result.content[0].text);
  log(result.isError ? `FAIL ${step}` : `OK ${step}`, value);
  if (result.isError) { await client.close(); process.exit(1); }
  return value;
};
const fail = async (step, reason) => { log(`FAIL ${step}`, reason); await client.close(); process.exit(1); };
await call('0-status', 'acb_status', {});
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

// Codex group: App Server only, no window.
let codex;
if (codexScope) {
  const workspace = await call('1-workspace', 'acb_workspace_create', { name: values.name, ...(values.path ? { path: values.path } : {}) });
  codex = values['codex-thread'] ? { threadId: values['codex-thread'] } : await call('2-codex-create', 'acb_codex_create', { cwd: workspace.path, title: `${values.name} Codex`, prompt: `ACB 验收 ${stamp}：这是新建的 Codex 对话，请只回复 ACB_READY，不执行命令、不修改文件。` });
  if (values['codex-thread']) log('RESUME 2-codex', codex);
  else {
    const found = await call('3-codex-find', 'acb_codex_find', { searchTerm: stamp });
    if (!found.some(item => item.threadId === codex.threadId)) await fail('3-codex-find', 'created thread not found by search');
    const listed = await call('3b-codex-list', 'acb_codex_list', { cwd: workspace.path });
    if (!listed.threads.some(item => item.threadId === codex.threadId)) await fail('3b-codex-list', 'created thread not listed for its workspace');
  }
  const sent = await call('4-codex-send', 'acb_codex_send', { threadId: codex.threadId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。请只回复：ACB_CODEX_OK，不执行命令、不修改文件。` });
  const read = await call('5-codex-read', 'acb_codex_read', { threadId: codex.threadId, turns: 2 });
  if (read.turns.at(-1)?.turnId !== sent.turnId || read.turns.at(-1)?.reply !== sent.reply) await fail('5-codex-read', 'read does not show the reply just sent');
}

// ChatGPT group: list/read through native IPC, open/create/send through the window.
let gptReply;
if (gptScope) {
  console.log('ACTION 已授权自动恢复/激活核验过的 ChatGPT 窗口；输入期间切换窗口会停止，不会重新抢回前台');
  const gpt = values['gpt-conversation'] ? { conversationId: values['gpt-conversation'] } : await call('6-gpt-create', 'acb_gpt_create', { title: `${values.name} GPT ${stamp}` });
  if (values['gpt-conversation']) log('RESUME 6-gpt', gpt);
  const listed = await call('7-gpt-list', 'acb_gpt_list', {});
  if (!values['gpt-conversation'] && !listed.some(item => item.conversationId === gpt.conversationId)) await fail('7-gpt-list', 'created chat not in the inventory');
  await call('8-gpt-open', 'acb_gpt_open', { conversationId: gpt.conversationId });
  gptReply = await call('9-gpt-send', 'acb_gpt_send', { conversationId: gpt.conversationId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。\n\n此消息包含空行，用于验证多行 Prompt 的精确输入与回读。\n\n请只回复：ACB_GPT_OK` });
  if (gptReply.reply.trim() !== 'ACB_GPT_OK') await fail('9-gpt-reply', 'reply differs from the requested exact token');
  // Without a window the transcript gives the prompt; the reply may be only a reference there.
  const read = await call('10-gpt-read', 'acb_gpt_read', { conversationId: gpt.conversationId, turns: 2 });
  const newest = read.turns.at(-1);
  if (newest?.turnId !== gptReply.turnId || !newest.prompt?.includes(stamp) || !(newest.replyInWindowOnly || newest.reply?.trim() === 'ACB_GPT_OK')) await fail('10-gpt-read', 'read does not show the turn just sent');
  const shown = await call('10b-gpt-read-window', 'acb_gpt_read', { conversationId: gpt.conversationId, window: true });
  if (shown.turns.at(-1)?.turnId !== gptReply.turnId || shown.turns.at(-1)?.reply?.trim() !== 'ACB_GPT_OK') await fail('10b-gpt-read-window', 'window read does not show the reply just sent');
}

// Composition is the caller's choice: here a GPT reply is read back and forwarded to Codex.
if (codexScope && gptScope)
  await call('11-relay', 'acb_codex_send', { threadId: codex.threadId, prompt: `下面是另一个对话的回复，请原样复述，不执行命令、不修改文件：${gptReply.reply}` });
console.log(`ACCEPTANCE_DONE scope=${values.scope}`);
await client.close();
