// One real run of the acceptance chain through dist/mcp.js, stopping at the first failure.
// node scripts/acceptance.mjs --config <file> --carrier-thread <id> --codex <codex.exe> --name <new workspace name> [--path <dir>] [--gpt-project <existing ChatGPT project name>]
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../dist/config.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, 'gpt-project': { type: 'string' } }, strict: true });
if (!values.name) throw new Error('--name is required');
const log = (step, value) => console.log(`${step} ${JSON.stringify(value)}`);
const config = loadConfig(values.config, { carrierThreadId: values['carrier-thread'] });

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
const codex = await call('2-codex-create', 'acb_codex_create', { cwd: workspace.path, title: `${values.name} Codex`, prompt: `ACB 验收 ${stamp}：这是新建的 Codex 对话，请只回复 ACB_READY，不执行命令、不修改文件。` });
const found = await call('3-codex-find', 'acb_codex_find', { searchTerm: stamp });
if (!found.some(item => item.threadId === codex.threadId)) { log('FAIL 3-codex-find', 'created thread not found by search'); process.exit(1); }
// The bridge never takes the foreground: the user brings ChatGPT to the front now.
console.log('ACTION 请在 15 秒内把 ChatGPT 桌面窗口切到前台，并在运行期间不要操作键盘鼠标');
await new Promise(done => setTimeout(done, 15000));
const gpt = await call('4-gpt-create', 'acb_gpt_create', { title: `${values.name} GPT ${stamp}` });
// A chat started in an existing ChatGPT project (the project is not created here).
const project = values['gpt-project'];
if (project) {
  const inProject = await call('4b-gpt-project', 'acb_gpt_create', { title: `${values.name} GPT 项目 ${stamp}`, project });
  if (inProject.project?.name !== project) { log('FAIL 4b-gpt-project', 'project not confirmed'); process.exit(1); }
} else log('SKIP 4b-gpt-project', 'no --gpt-project given');
await call('5-gpt-open', 'acb_gpt_open', { conversationId: gpt.conversationId });
const gptReply = await call('6-gpt-send', 'acb_gpt_send', { conversationId: gpt.conversationId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。请只回复：ACB_GPT_OK` });
await call('7-codex-send', 'acb_codex_send', { threadId: codex.threadId, prompt: `这是 Agent Control Bridge 验收测试 ${stamp}。请只回复：ACB_CODEX_OK，不执行命令、不修改文件。` });
// Relay: the GPT reply is forwarded to the Codex conversation.
await call('8-relay', 'acb_codex_send', { threadId: codex.threadId, prompt: `下面是另一个对话的回复，请原样复述，不执行命令、不修改文件：${gptReply.reply}` });
console.log(project ? 'ACCEPTANCE_DONE' : 'ACCEPTANCE_INCOMPLETE 4b-gpt-project skipped');
await client.close();
