import { createHash } from 'node:crypto';
import { BridgeError } from './errors.ts';
import { NativeDesktopReadClient, type NativeReadOptions, type NativeToolSummary, type NativeProjectExpectation } from './native-readonly.ts';

type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = row(value);
  return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])])) : value;
}
const reviewedTargets = ['project', 'projectless', 'chatgptWorkCloud'] as const;

/** Diagnostic metadata only. Never install this result as ProjectHost capabilities. */
export function summarizeNativeCreationCatalog(tools: NativeToolSummary[]) {
  const catalog = tools.filter(tool => tool.namespace === 'codex_app');
  if (new Set(catalog.map(tool => tool.name)).size !== catalog.length) throw new BridgeError('IO', 'Ambiguous native tool catalog');
  const schema = catalog.find(tool => tool.name === 'create_thread')?.inputSchema;
  const properties = row(schema?.properties), target = row(properties?.target);
  const branches = Array.isArray(target?.anyOf) && target.oneOf === undefined && target.$ref === undefined ? target.anyOf : [];
  const kinds: typeof reviewedTargets[number][] = [];
  let unknownBranches = 0;
  for (const branch of branches) {
    const object = row(branch), type = row(row(object?.properties)?.type);
    const values = Array.isArray(type?.enum) ? type.enum : type?.const !== undefined ? [type.const] : [];
    if (object?.type === 'object' && object.additionalProperties === false && Array.isArray(object.required) && object.required.includes('type') &&
        values.length === 1 && reviewedTargets.includes(values[0] as typeof reviewedTargets[number])) kinds.push(values[0] as typeof reviewedTargets[number]);
    else unknownBranches++;
  }
  const recognized = schema?.type === 'object' && Array.isArray(schema.required) && schema.required.includes('prompt') && schema.required.includes('target') &&
    branches.length > 0 && unknownBranches === 0 && new Set(kinds).size === kinds.length;
  const rename = catalog.find(tool => tool.name === 'set_thread_title')?.inputSchema;
  const renameProperties = row(rename?.properties), sources = row(renameProperties?.source)?.enum;
  const list = catalog.find(tool => tool.name === 'list_projects')?.inputSchema;
  const listProperties = row(list?.properties);
  return {
    catalogHash: createHash('sha256').update(JSON.stringify(canonical([...catalog].sort((a, b) => a.name.localeCompare(b.name))))).digest('hex'),
    toolCount: catalog.length,
    createThreadSchema: !schema ? 'unavailable' as const : recognized ? 'recognized' as const : 'requires-review' as const,
    reviewedTargetKinds: recognized ? [...kinds].sort() : [],
    existingProjectCodexAdvertised: recognized && kinds.includes('project'),
    workCloudAdvertised: recognized && kinds.includes('chatgptWorkCloud'),
    chatgptRenameAdvertised: rename?.type === 'object' && Array.isArray(rename.required) && rename.required.includes('title') &&
      row(renameProperties?.threadId)?.type === 'string' && Array.isArray(sources) && sources.includes('chatgpt'),
    projectInventorySchemaRecognized: list?.type === 'object' && list.additionalProperties === false && !!listProperties && Object.keys(listProperties).length === 0 &&
      (list.required === undefined || Array.isArray(list.required) && list.required.length === 0),
    nativeWorkspaceCreationVerified: false as const,
    ordinaryChatCreationVerified: false as const,
    ordinaryChatModeReadbackVerified: false as const,
  };
}

export async function checkNativeProvisioningCapabilities(options: NativeReadOptions & { expectedProject?: NativeProjectExpectation }) {
  const client = new NativeDesktopReadClient(options);
  const catalog = summarizeNativeCreationCatalog(await client.catalog());
  const carrier = await client.readSummary(options.carrierThreadId);
  if (carrier.backingKind !== 'codex') throw new BridgeError('PROVENANCE', 'An existing Codex carrier is required');
  if (options.expectedProject && !catalog.projectInventorySchemaRecognized) throw new BridgeError('UNSUPPORTED', 'Native project inventory schema requires review');
  const project = options.expectedProject ? await client.projectSummary(options.expectedProject) : null;
  return { ok: true, readOnly: true, state: 'BLOCKED' as const, peer: client.peer, catalog, carrier, project,
    blockers: ['NATIVE_WORKSPACE_CREATOR_UNVERIFIED', 'ORDINARY_CHAT_CREATOR_UNVERIFIED', 'ORDINARY_CHAT_MODE_READBACK_UNVERIFIED'],
    messagesSent: false, realModelInvoked: false, credentialsRead: false, executionAuthorized: false, fullWorkflowReady: false };
}
