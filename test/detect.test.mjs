import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStacks } from '../skills/toolkit/detect.mjs';

const tmp = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const names = (d) => detectStacks(d).map((s) => s.stack).sort();

test('package.json deps and tsconfig', () => {
  assert.deepEqual(names(tmp({ 'package.json': '{"dependencies":{"react":"1"},"devDependencies":{"typescript":"5"}}' })), ['typescript', 'web-ui']);
});
test('manifest files', () => {
  assert.deepEqual(names(tmp({ 'go.mod': 'module x', 'svc/Cargo.toml': '' })), ['go', 'rust']);
  assert.deepEqual(names(tmp({ 'pyproject.toml': '' })), ['python']);
});
test('a new project is detected from SPEC.md, and says why', () => {
  const r = detectStacks(tmp({ 'SPEC.md': '## Stack\n| Language | Python |' }));
  assert.deepEqual(r.map((s) => s.stack), ['python']);
  assert.match(r[0].why, /SPEC\.md/);
});
test('node_modules and empty folders add nothing', () => {
  assert.deepEqual(names(tmp({ 'node_modules/x/index.html': '' })), []);
  assert.deepEqual(names(tmp({})), []);
});
test('every stack a catalog entry lists is one the scanner can detect', () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../skills/toolkit/catalog.json', import.meta.url), 'utf8'));
  const known = new Set(['web-ui', 'typescript', 'python', 'go', 'rust']);
  for (const e of cat.plugins) for (const s of e.stacks || []) assert.ok(known.has(s), `${e.id}: unknown stack ${s}`);
});
