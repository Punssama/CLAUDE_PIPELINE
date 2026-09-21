// /clean: what goes when a project is abandoned, and what stays because it is shared. Private HOME and Claude config dirs, a fake `claude` CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOOLKIT = path.join(ROOT, 'skills', 'toolkit', 'toolkit.mjs');
const FAKE = path.join(ROOT, 'test-support', 'fake-plugin-cli.mjs');
const made = [];
const tmp = (files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
  made.push(d);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const home = tmp(), cfg = tmp(), log = path.join(tmp(), 'cli.jsonl');
process.env.CLAUDE_PIPELINE_HOME = home;                                    // the dashboard module reads it when it loads
const { projectId } = await import(pathToFileURL(path.join(ROOT, 'skills', 'setup-pipeline', 'dashboard.mjs')).href);
const env = { ...process.env, CLAUDE_PIPELINE_HOME: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PIPELINE_CLAUDE: JSON.stringify(['node', FAKE]), FAKE_CLI_LOG: log };
const toolkit = (...args) => { const r = spawnSync(process.execPath, [TOOLKIT, ...args], { env, encoding: 'utf8', timeout: 60000, input: '{}' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() ? JSON.parse(r.stdout) : null; };
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ids = (list) => list.map((p) => p.id).sort();

// Two projects: A (React, Stripe, Supabase) and B (Stripe only). What is installed, and for whom:
const A = tmp({ 'package.json': JSON.stringify({ dependencies: { react: '19', stripe: '1', '@supabase/supabase-js': '2' } }) });
const B = tmp({ 'package.json': JSON.stringify({ dependencies: { stripe: '1' } }) });
const install = (id, scope, projectPath) => [id, [{ scope, ...(projectPath ? { projectPath } : {}) }]];
fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: Object.fromEntries([
  install('stripe@stripe', 'user'),                                          // a service plugin installed for all projects; A and B both use Stripe
  install('supabase@supabase-agent-skills', 'user'),                         // installed for all projects, but only A uses Supabase
  install('cloudflare@cloudflare', 'local', A),                              // installed for A alone
  install('firebase@firebase', 'local', B),                                  // installed for B alone
  install('frontend-design@claude-plugins-official', 'user'),                // language-wide / general: shared by nature (A has React)
  install('ponytail@ponytail', 'user'),                                      // a general plugin: never part of a clean
]) }));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'seen.json'), JSON.stringify({ [A]: '2026-09-01T00:00:00Z', [B]: '2026-09-02T00:00:00Z' }));

test('the plan removes what only this project uses and keeps what is shared', () => {
  const plan = toolkit('--clean-plan', A);
  assert.deepEqual(ids(plan.remove), ['cloudflare@cloudflare', 'supabase@supabase-agent-skills']);
  const cf = plan.remove.find((p) => p.id === 'cloudflare@cloudflare'), sb = plan.remove.find((p) => p.id === 'supabase@supabase-agent-skills');
  assert.equal(cf.scope, 'local'); assert.ok(!cf.global);
  assert.equal(sb.scope, 'user'); assert.equal(sb.global, true, 'a user-wide install is flagged: other projects unknown to us may use it');
  assert.deepEqual(ids(plan.keep), ['frontend-design@claude-plugins-official', 'stripe@stripe']);
  assert.deepEqual(plan.keep.find((p) => p.id === 'stripe@stripe').usedBy.map(path.normalize), [path.normalize(B)]);
  const all = JSON.stringify(plan);
  assert.ok(!all.includes('ponytail'), 'a general plugin is not even mentioned');
  assert.ok(!all.includes('firebase'), 'another project\'s own plugin is not this one\'s business');
});

test('apply uninstalls exactly what the plan lists, in the right scope and folder, and refuses anything else', () => {
  const res = toolkit('--clean-apply', A, 'cloudflare@cloudflare,supabase@supabase-agent-skills,stripe@stripe,ponytail@ponytail,firebase@firebase');
  assert.deepEqual(res.filter((r) => r.ok).map((r) => r.id).sort(), ['cloudflare@cloudflare', 'supabase@supabase-agent-skills']);
  assert.equal(res.filter((r) => !r.ok).length, 3);
  assert.match(res.find((r) => r.id === 'stripe@stripe').message, /only plugins used by this project alone/);
  const ran = calls().filter((c) => c.args[1] === 'uninstall');
  assert.equal(ran.length, 2, 'the refused ones never reach the CLI');
  const local = ran.find((c) => c.args.includes('cloudflare@cloudflare')), user = ran.find((c) => c.args.includes('supabase@supabase-agent-skills'));
  assert.deepEqual(local.args, ['plugin', 'uninstall', 'cloudflare@cloudflare', '--scope', 'local']);
  assert.equal(path.normalize(local.cwd).toLowerCase(), path.normalize(A).toLowerCase(), 'a project install is removed from that project\'s folder');
  assert.deepEqual(user.args, ['plugin', 'uninstall', 'supabase@supabase-agent-skills', '--scope', 'user']);
});

test('abandoning a project drops it from the known projects, the dashboard list and the count of plugin users', () => {
  const registry = path.join(home, 'projects', `${projectId(A)}.json`);
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ id: projectId(A), cwd: A, name: 'a', at: 'x' }));
  assert.ok(toolkit('--projects').some((p) => path.normalize(p.dir) === path.normalize(A)));
  assert.equal(toolkit('--abandon', A).ok, true);
  assert.ok(!fs.existsSync(registry), 'the dashboard no longer lists its documents');
  assert.ok(!toolkit('--projects').some((p) => path.normalize(p.dir) === path.normalize(A)));
  assert.ok(fs.existsSync(path.join(A, 'package.json')), 'project files are never touched');
  // With A gone, B is the only project using Stripe: cleaning B now removes it too.
  assert.ok(ids(toolkit('--clean-plan', B).remove).includes('stripe@stripe'));
});

test('a session that starts in an abandoned project brings it back to life', () => {
  const r = spawnSync(process.execPath, [TOOLKIT, '--suggest'], { env, encoding: 'utf8', input: JSON.stringify({ cwd: A }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(toolkit('--projects').some((p) => path.normalize(p.dir) === path.normalize(A)));
  assert.ok(!ids(toolkit('--clean-plan', B).remove).includes('stripe@stripe'), 'A counts as a Stripe user again');
});

test('installing for a project puts service plugins in that project only, and the rest for everyone', () => {
  fs.rmSync(log, { force: true });
  toolkit('--install', 'stripe,frontend-design,pyright-lsp', '--project', B);
  const installs = calls().filter((c) => c.args[1] === 'install');
  const stripe = installs.find((c) => c.args.includes('stripe@stripe')), fd = installs.find((c) => c.args.includes('frontend-design@claude-plugins-official'));
  assert.deepEqual(stripe.args, ['plugin', 'install', 'stripe@stripe', '--scope', 'local']);
  assert.equal(path.normalize(stripe.cwd).toLowerCase(), path.normalize(B).toLowerCase());
  assert.deepEqual(fd.args, ['plugin', 'install', 'frontend-design@claude-plugins-official'], 'general and language tools are installed for all projects');
  fs.rmSync(log, { force: true });
  toolkit('--install', 'stripe');                                             // no project given: the old behaviour
  assert.deepEqual(calls().find((c) => c.args[1] === 'install').args, ['plugin', 'install', 'stripe@stripe']);
});

test('detect says whether a plugin is active in this folder: for everyone, or installed for this very project', () => {
  const inA = toolkit('--detect', A).suggestions, inB = toolkit('--detect', B).suggestions;
  assert.equal(inA.find((s) => s.id === 'cloudflare'), undefined);          // A does not use Cloudflare, so it is not even suggested
  assert.equal(inA.find((s) => s.id === 'stripe').installed, true);
  assert.equal(inB.find((s) => s.id === 'stripe').scope, 'this project only');
});
