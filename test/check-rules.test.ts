import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The release check rules are plain JavaScript without declarations.
import { scanText } from '../scripts/check-rules.mjs';

test('release check: local user paths are detected independently of the running account', () => {
  const scan = (text: string) => (scanText('src/fixture.ts', text) as string[]).includes('localUserPath');
  // Positive fixtures are assembled so this file itself contains no concrete account path.
  const path = (separator: string, ...parts: string[]) => parts.join(separator);
  for (const text of [`"${path('/', '', 'home', 'alice', '.config')}"`, `'${path('\\', 'C:', 'Users', 'Bob', 'AppData')}'`, `"${path('/', 'C:', 'Users', 'Carol', 'x')}"`, `"${path('/', '', 'home', 'dave')}"`]) assert.equal(scan(text), true, text);
  for (const text of ['\\Users\\[USER]\\AppData', '/home/<user>/x', '/Users/$USER/x', '%USERPROFILE%\\x', 'AU/Users/Everyone 写权限', '/home/runner/work/x', '/mnt/c/.../node.exe']) assert.equal(scan(text), false, text);
  assert.deepEqual(scanText('data/bridge.db', ''), ['privatePath']);
});
