/**
 * Error codes returned to MCP clients. Each code has one meaning and one remedy,
 * documented in the README and the agent skill.
 */
export type ErrorCode =
  /** An argument is invalid. Fix the call. */
  | 'INPUT'
  /** The desktop app is not running or not reachable, or this is not Windows. */
  | 'UNAVAILABLE'
  /** The conversation does not exist. */
  | 'NOT_FOUND'
  /** The conversation is answering another message. Wait, then read it. */
  | 'BUSY'
  /** Codex waits for an approval or an answer from the user in the desktop app. */
  | 'NEEDS_USER'
  /** The reply is still pending. Read the conversation later; do not resend. */
  | 'TIMEOUT'
  /** The turn failed or was interrupted in the app. */
  | 'FAILED'
  /** The ChatGPT window could not be found, read or used. */
  | 'WINDOW'
  /** The app answered in an unexpected way, usually after an app update. */
  | 'PROTOCOL'
  /** Answering an approval needs confirm: true: the user's choice, or the default allow they agreed to. */
  | 'UNCONFIRMED'
  /** The conversation shows no approval card with this question and button. Read it again. */
  | 'NO_APPROVAL';

export class AcbError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AcbError';
    this.code = code;
    this.details = details;
  }
}

export function toAcbError(error: unknown): AcbError {
  if (error instanceof AcbError) return error;
  return new AcbError('PROTOCOL', error instanceof Error ? error.message : String(error));
}
