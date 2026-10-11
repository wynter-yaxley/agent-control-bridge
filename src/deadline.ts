import { BridgeError } from './errors.ts';

export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new BridgeError('CONFIG', 'Invalid operation timeout');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BridgeError('TIMEOUT', 'External outcome requires reconciliation')); }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
