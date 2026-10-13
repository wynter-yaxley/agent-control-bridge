import type { ChatgptAdapter, Generation, ProjectRouteEvidence } from './prompts.ts';
import { BridgeError } from './errors.ts';

export interface OrdinaryChatCapabilities {
  source: 'application-host';
  ordinaryChat: boolean;
  background: boolean;
  exactConversation: boolean;
  completeMessages: boolean;
  actualGenerationParameters: boolean;
  createOrdinaryChat: boolean;
  createWorkspace: boolean;
  models: string[];
  reasoningEfforts: string[];
}
export interface OrdinaryChatHost {
  inspect(signal: AbortSignal): Promise<OrdinaryChatCapabilities>;
  inspectConversation(conversationId: string, signal: AbortSignal): Promise<ProjectRouteEvidence & { kind: 'ordinary-chat' | 'work' | 'unknown'; name: string }>;
  generate(conversationId: string, requirement: string, options: { model: string; reasoningEffort: string; signal: AbortSignal }): Promise<Generation & { complete: boolean; evidenceSource: 'application-host' | 'unknown' }>;
  observeGeneration?(conversationId: string, request: string, signal: AbortSignal): Promise<Generation & { complete: boolean; evidenceSource: 'application-host' | 'unknown' }>;
}

export function assertOrdinaryChatCapabilities(capabilities: OrdinaryChatCapabilities, provisioning = false): void {
  // Focus-changing hosts enforce a trusted per-operation UI authorization.
  // Model/effort observations are optional under the current user policy.
  if (capabilities.source !== 'application-host' || capabilities.ordinaryChat !== true || capabilities.exactConversation !== true ||
      (provisioning ? capabilities.createOrdinaryChat !== true || capabilities.createWorkspace !== true : capabilities.completeMessages !== true)) {
    throw new BridgeError('UNSUPPORTED', 'Ordinary GPT creation or complete message readback is unavailable');
  }
}

// Only trusted embedding code can install this host object. No JSON tool accepts it.
export function createOrdinaryChatAdapter(host: OrdinaryChatHost, conversationId: string, conversationName: string): ChatgptAdapter {
  return {
    source: 'chatgpt', conversationId, conversationName,
    async capabilities() {
      const capabilities = await host.inspect(new AbortController().signal);
      assertOrdinaryChatCapabilities(capabilities);
      return { verified: true, models: capabilities.models, reasoningEfforts: capabilities.reasoningEfforts };
    },
    async preflight(target, signal) {
      const actual = await host.inspectConversation(conversationId, signal);
      if (actual.kind !== 'ordinary-chat' || actual.name !== conversationName || target.conversationId !== conversationId) throw new BridgeError('PROVENANCE', 'Ordinary GPT conversation identity or title does not match');
      return actual;
    },
    async generate(requirement, options) {
      const result = await host.generate(conversationId, requirement, options);
      if (!result.complete || result.evidenceSource !== 'application-host') throw new BridgeError('PROVENANCE', 'A complete host-observed GPT generation is required');
      return result;
    },
    observeGeneration: host.observeGeneration ? async(request,signal)=>{
      const result=await host.observeGeneration!(conversationId,request,signal);
      if(!result.complete || result.evidenceSource!=='application-host')throw new BridgeError('PROVENANCE','A complete host-observed original generation is required');
      return result;
    } : undefined,
  };
}
