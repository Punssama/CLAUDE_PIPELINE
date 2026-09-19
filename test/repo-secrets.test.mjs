// The plugin ships a secrets scanner, so its own repository must pass it: no password-shaped, token-shaped or key-shaped literal
// may be committed, not even a fake one in a test (public scanners flag those too, and cannot tell fake from real).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtinSecrets } from '../skills/setup-pipeline/gates.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('no tracked file holds anything the built-in secrets scanner flags', (t) => {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0) return t.skip('not a git checkout (for example the installed plugin copy)');
  const lines = [];
  for (const f of ls.stdout.split('\0').filter(Boolean)) {
    let buf; try { buf = fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
    if (buf.length > 1 << 20 || buf.includes(0)) continue; // binary or huge (the dashboard screenshot, the vendored marked.js)
    buf.toString('utf8').split('\n').forEach((text, i) => lines.push({ file: f, line: i + 1, text: text.replace(/\r$/, '') }));
  }
  const hits = builtinSecrets(lines);
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line} ${h.rule}`), []);
});
