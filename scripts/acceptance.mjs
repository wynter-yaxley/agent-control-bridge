// One real run of the acceptance chain through dist/mcp.js, stopping at the first failure.
// node scripts/acceptance.mjs --config <file> --carrier-thread <id> --codex <codex.exe> --name <new workspace name> [--path <dir>] [--move-gpt]
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../dist/config.js';
import { NativeClient, closeNativeWorker } from '../dist/native.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, 'move-gpt': { type: 'boolean' } }, strict: true });
if (!values.name) throw new Error('--name is required');
const log = (step, value) => console.log(`${step} ${JSON.stringify(value)}`);
// Diagnostics: the advertised shapes of the native tools this run depends on.
const config = loadConfig(values.config, { carrierThreadId: values['carrier-thread'] });
const catalog = await new NativeClient({ carrierThreadId: config.carrierThreadId, ...config.nativeInterface }).catalog();
for (const name of ['create_thread', 'set_thread_title', 'navigate_to_codex_page', 'move_thread_to_project']) log(`SCHEMA ${name}`, catalog[name] ? { required: catalog[name].required ?? [], properties: Object.keys(catalog[name].properties ?? {}) } : null);
closeNativeWorker();

const client = new Client({ name: 'acb-acceptance', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/mcp.js', import.meta.url)),
  ...(values.config ? ['--config', values.config] : []), '--carrier-thread', config.carrierThreadId, ...(values.codex ? ['--codex', values.codex] : []), '--allow-foreground-input'], stderr: 'inherit' }));
const call = async (step, name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const value = JSON.parse(result.content[0].text);
  log(result.isError ? `FAIL ${step}` : `OK ${step}`, value);
  if (result.isError) { await client.close(); process.exit(1); }
  return value;
};
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const workspace = await call('1-workspace', 'acb_workspace_create', { name: values.name, ...(values.path ? { path: values.path } : {}) });
const gpt = await call('2-gpt-create', 'acb_gpt_create', { title: `${values.name} GPT ${stamp}`, ...(values['move-gpt'] ? { projectId: workspace.projectId } : {}) });
const codex = await call('3-codex-create', 'acb_codex_create', { projectId: workspace.projectId, title: `${values.name} Codex` });
await call('4-gpt-open', 'acb_gpt_open', { conversationId: gpt.conversationId });
await call('5-gpt-send', 'acb_gpt_send', { conversationId: gpt.conversationId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。请只回复：ACB_GPT_OK` });
await call('6-codex-send', 'acb_codex_send', { threadId: codex.threadId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。请只回复：ACB_CODEX_OK，不执行命令、不修改文件。` });
console.log('ACCEPTANCE_DONE');
await client.close();
