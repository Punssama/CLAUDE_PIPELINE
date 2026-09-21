import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStacks, STACKS } from '../skills/toolkit/detect.mjs';

const made = [];
const tmp = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  made.push(d);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const names = (d) => detectStacks(d).map((s) => s.stack).sort();
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

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

test('services and platforms come from dependencies and config files', () => {
  const d = tmp({ 'package.json': JSON.stringify({ dependencies: { '@supabase/supabase-js': '2', stripe: '1', '@clerk/backend': '1' } }), 'wrangler.toml': '', 'infra/main.tf': '' });
  assert.deepEqual(names(d), ['clerk', 'cloudflare', 'stripe', 'supabase', 'terraform']);
});
test('python, PHP and other root manifests are read too', () => {
  assert.deepEqual(names(tmp({ 'requirements.txt': 'boto3\npsycopg2-binary\nstripe\n' })), ['aws', 'postgres', 'python', 'stripe']);
  assert.deepEqual(names(tmp({ 'composer.json': '{"require":{"laravel/framework":"^11"}}' })), ['laravel', 'php']);
  assert.deepEqual(names(tmp({ 'Package.swift': '', 'App.xcodeproj/project.pbxproj': '' })), ['swift']);
});
test('broad words only count in SPEC.md, and ordinary prose triggers nothing', () => {
  assert.deepEqual(names(tmp({ 'requirements.txt': 'browser-cookie3\n' })), ['python']);                 // a dependency name is not a web UI
  assert.deepEqual(names(tmp({ 'SPEC.md': 'A neon-lit racing game. Sanity check the inputs. The clerk desk is closed.' })), []);
  assert.deepEqual(names(tmp({ 'SPEC.md': 'A browser game with html and css.' })), ['web-ui']);
});

test('every stack a catalog entry lists is one the scanner can detect, and every detectable stack has a plugin to suggest', () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../skills/toolkit/catalog.json', import.meta.url), 'utf8'));
  const listed = new Set();
  for (const e of cat.plugins) for (const s of e.stacks || []) { assert.ok(STACKS.includes(s), `${e.id}: unknown stack ${s}`); listed.add(s); }
  for (const s of STACKS) assert.ok(listed.has(s), `stack ${s} is detected but no catalog plugin fits it`);
});
test('stack plugins are complete entries: installable ids, a license, a measured token cost', () => {
  const cat = JSON.parse(fs.readFileSync(new URL('../skills/toolkit/catalog.json', import.meta.url), 'utf8'));
  const stackPlugins = cat.plugins.filter((e) => e.kind === 'stack');
  assert.ok(stackPlugins.length >= 25);
  for (const e of stackPlugins) {
    assert.match(e.plugin, /^[\w-]+@[\w-]+$/, e.id); assert.match(e.marketplace, /^[\w.-]+\/[\w.-]+$/, e.id);
    assert.ok(e.license && e.does && Array.isArray(e.stacks) && e.stacks.length, e.id);
    assert.equal(e.measured, true, `${e.id}: token cost not measured`); assert.equal(typeof e.alwaysOnTokens, 'number', e.id);
    assert.deepEqual(e.presets, [], `${e.id}: a stack plugin never belongs to the recommended or full preset`);
  }
  assert.equal(new Set(cat.plugins.map((e) => e.id)).size, cat.plugins.length, 'ids are unique');
});
