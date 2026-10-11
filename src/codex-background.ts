import type { BackgroundExecutor } from './background-runner.ts';
import { createCodexExecDelivery, type CodexExecDeliveryOptions } from './codex-exec.ts';
import { BridgeError } from './errors.ts';

// Inspection is independently installed by the authorized host. The CLI cannot
// attest desktop workspace ownership merely by echoing the requested target.
export function createCodexBackgroundExecutor(options: CodexExecDeliveryOptions & { inspect: BackgroundExecutor['inspect'] }): BackgroundExecutor {
  return {
    mode: 'codex-exec',
    inspect: options.inspect,
    async execute(content, key, target, signal, onEvent) {
      const delivery = createCodexExecDelivery({ ...options, resume: true, onEvent });
      const receipt = await delivery.deliver(content, key, signal, target);
      if (!receipt.codexConversationId || !receipt.workspacePath) throw new BridgeError('PROVENANCE', 'Background Codex receipt has no exact thread/workspace');
      return { executionId: receipt.executionId, codexConversationId: receipt.codexConversationId, workspacePath: receipt.workspacePath };
    },
  };
}
