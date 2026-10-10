import { silentProcess } from './silent-process.ts';
// Delegation to an already authorized tool; this module never extracts credentials.
export async function githubVisibility(preflight: { safe: boolean; commit: string }, visibility: 'public') {
  const operation = 'github-set-visibility';
  if (!preflight.safe || !/^[a-f0-9]{40}$/.test(preflight.commit)) return { operation, ok: false, code: 'PUBLICATION_GATE', needsUserAction: false, partialChanges: false, summary: 'A current verified release gate is required' };
  const check = await silentProcess('github-auth-check', 'gh', ['auth', 'status'], { timeoutMs: 10000 });
  if (!check.ok) return check;
  const result = await silentProcess(operation, 'gh', ['api', '--method', 'PATCH', 'repos/wynter-yaxley/agent-control-bridge', '-f', `visibility=${visibility}`], { mutation: true });
  if (!result.ok) return result;
  const verify = await silentProcess('github-visibility-verify', 'gh', ['api', 'repos/wynter-yaxley/agent-control-bridge', '--jq', '.visibility']);
  return { ...verify, ok: verify.ok && verify.stdout?.trim() === visibility, partialChanges: true, summary: verify.stdout?.trim() === visibility ? 'Visibility independently verified public' : 'Visibility verification failed' };
}
