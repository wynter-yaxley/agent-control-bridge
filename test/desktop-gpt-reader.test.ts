import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.ts';
import { createDesktopGptReader } from '../src/desktop-gpt-reader.ts';

// A stand-in interpreter replays the CDP worker's exit contracts without any endpoint.
test('CDP reader: zero matched selectors is PROVENANCE, structured endpoint failure is UNSUPPORTED', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'acb-cdp-reader-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = defaults(root); config.desktop.enabled = true;
  const fake = (name: string, body: string) => { const path = join(root, name); writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return path; };
  config.desktop.python = fake('unmatched', `echo '{"source":"visible-dom","status":"unverified","reason":"selector_not_matched","messages":[]}'; exit 4`);
  await assert.rejects(createDesktopGptReader(config, join(root, 'config.json'))('fixture-id'), { code: 'PROVENANCE' });
  config.desktop.python = fake('closed', `echo '{"code":"CDP_UNAVAILABLE","error":"Configured current-instance CDP endpoint is unavailable"}' >&2; exit 6`);
  await assert.rejects(createDesktopGptReader(config, join(root, 'config.json'))('fixture-id'), { code: 'UNSUPPORTED' });
});
