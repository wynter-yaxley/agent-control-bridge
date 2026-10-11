import { lstatSync, readFileSync } from 'node:fs';
import { BridgeError } from './errors.ts';
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export function redact(text: string): string {
  return text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[REDACTED]')
    .replace(/("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|(?:feishu[_-]?|lark[_-]?)?app[_-]?secret|client[_-]?secret|tenant[_-]?access[_-]?token)"\s*:\s*")[^"\r\n]*(")/gi, '$1[REDACTED]$2')
    .replace(/(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|(?:feishu[_-]?|lark[_-]?)?app[_-]?secret|client[_-]?secret|tenant[_-]?access[_-]?token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;"}]+/gi, '$1[REDACTED]');
}
export function safeText(text: string): string {
  return redact(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function requireNoSecrets(text: string): void {
  if (redact(text) !== text) throw new BridgeError('INPUT', 'Authentication material is not accepted');
}
export function readBounded(path: string, maximum = MAX_INPUT_BYTES): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new BridgeError('INPUT', 'Input must be a regular bounded file');
  const data = readFileSync(path);
  if (data.length > maximum) throw new BridgeError('INPUT', 'Input exceeded size limit');
  return data.toString('utf8');
}
