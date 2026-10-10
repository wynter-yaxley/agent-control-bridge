import { readBounded } from './security.ts';
export function readPiStatus(path: string | null = null) {
  const observedAt = new Date().toISOString();
  const base = { status: 'unknown', observedAt, source: 'locks-hint', freshness: 'unverified', alive: null, version: null, feishuActivity: false, feishuConnected: false, feishuPid: null, extensions: [] };
  if (!path) return { ...base, source: 'not-configured', freshness: 'unknown' };
  try {
    const value: unknown = JSON.parse(readBounded(path));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { ...base, note: 'Historical metadata cannot prove current execution or connection' };
  } catch { return { ...base, freshness: 'unknown', error: 'Metadata unavailable or invalid' }; }
}
