// The SessionStart hint (toolkit.mjs --suggest): which plugins fit the project you opened and are not installed. Private HOME and Claude config dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLKIT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'skills', 'toolkit', 'toolkit.mjs');
const made = [];
const tmp = (files = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-'));
  made.push(d);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// One machine: a pipeline home, a Claude config dir with these plugins installed, and a runner for the hook.
function machine(installed = []) {
  const home = tmp(), cfg = tmp({ 'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: Object.fromEntries(installed.map((p) => [p, [{ scope: 'user' }]])) }) });
  const hook = (cwd, env = {}) => {
    const r = spawnSync(process.execPath, [TOOLKIT, '--suggest'], { input: JSON.stringify({ cwd }), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CLAUDE_PIPELINE_HOME: home, CLAUDE_CONFIG_DIR: cfg, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).systemMessage : '';
  };
  return { hook, installed: (list) => fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: Object.fromEntries(list.map((p) => [p, [{}]])) })) };
}
const pkg = (deps) => ({ 'package.json': JSON.stringify({ dependencies: deps }) });

test('names the plugins that fit the project and are not installed, services first, with their token cost', () => {
  const m = machine(['frontend-design@claude-plugins-official']);
  const msg = m.hook(tmp(pkg({ react: '19', '@supabase/supabase-js': '2', stripe: '1' })));
  assert.match(msg, /^claude-pipeline: This project uses /);
  assert.match(msg, /supabase \(/); assert.match(msg, /stripe \(/); assert.match(msg, /tokens per session/); assert.match(msg, /\/toolkit/);
  assert.doesNotMatch(msg, /frontend-design/, 'an installed plugin is not suggested');
});

test('tells a project once: the same plugins are not repeated, a new dependency adds only what is new', () => {
  const m = machine();
  const d = tmp(pkg({ stripe: '1' }));
  assert.match(m.hook(d), /stripe/);
  assert.equal(m.hook(d), '', 'already told');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { stripe: '1', '@clerk/backend': '1' } }));
  const again = m.hook(d);
  assert.match(again, /clerk/); assert.doesNotMatch(again, /stripe \(/);
});

test('installing a suggested plugin removes it from the notice', () => {
  const m = machine(['stripe@stripe']);
  assert.equal(m.hook(tmp(pkg({ stripe: '1' }))), '');
});

test('shows at most four, the rest counted', () => {
  const m = machine();
  const msg = m.hook(tmp({ ...pkg({ '@supabase/supabase-js': '2', stripe: '1', '@clerk/backend': '1', firebase: '1', typescript: '5' }), 'wrangler.toml': '', 'main.tf': '', 'tsconfig.json': '{}' }));
  assert.equal((msg.match(/ tokens per session\)/g) || []).length, 4);
  assert.match(msg, /and \d+ more/);
});

test('stays silent in pipeline steps, in the home folder and where nothing fits', () => {
  const m = machine();
  const d = tmp(pkg({ stripe: '1' }));
  assert.equal(m.hook(d, { CLAUDE_PIPELINE_HEADLESS: '1' }), '');
  assert.equal(m.hook(os.homedir()), '');
  assert.equal(m.hook(tmp({ 'notes.txt': 'hello' })), '');
  assert.match(m.hook(d), /stripe/, 'and the silent runs told nothing');
});
