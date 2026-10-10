export const EXIT_CODES = { INPUT: 2, CONFIG: 2, AUTH: 3, OWNER: 3, PROVENANCE: 3,
  STATE: 4, CONFLICT: 4, LEASE: 4, NOT_FOUND: 4, REVIEW: 4,
  DB: 5, SCHEMA: 5, AGENT: 6, DEPENDENCY: 6, UNSUPPORTED: 6, TIMEOUT: 7, EXECUTION: 8, IO: 1 } as const;
export type ErrorCode = keyof typeof EXIT_CODES;
export class BridgeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.name = 'BridgeError'; this.code = code; }
}
export function classifyError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    if (error.code.startsWith('ERR_SQLITE') || error.code === 'SQLITE_BUSY') return new BridgeError('DB', 'Database operation failed; transaction rolled back');
    if (error.code === 'ENOENT') return new BridgeError('DEPENDENCY', 'Required file or executable is unavailable');
  }
  return new BridgeError('IO', 'Operation failed; no success is implied');
}
