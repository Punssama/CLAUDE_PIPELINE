// Dashboard server API: plan lint endpoints and the guards around them. Uses a private CLAUDE_PIPELINE_HOME and a real server process.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.join(fileURLToPath(new URL('..', import.meta.url)), 'skills', 'setup-pipeline', 'dashboard.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-home-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-proj-'));
const ID = '2026-01-01T00-00-00-000Z-1';
let server, base;

const GOOD = `# Plan: x\n\n## Goal\nA thing.\n\n## Non-goals\n- none\n\n## Assumptions\n- none\n\n## Tasks\n### T1: Do it (AC-1)\n- Files: \`a.py\` (new)\n- Do: write it\n- Verify: \`pytest\` -> passes\n\n## Test matrix\n| AC | Test | Asserts |\n|---|---|---|\n| AC-1 | tests/test_a.py::test_a | returns the value |\n\n## Risks and rollback\n- revert\n\n## Test command\n\`pytest -q\`\n`;
const record = () => JSON.parse(fs.readFileSync(path.join(home, 'runs', `${ID}.json`), 'utf8'));
const api = (p, o = {}) => fetch(base + p, { ...o, headers: { ...(o.headers || {}) } });

before(async () => {
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.pipeline'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.pipeline', 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(proj, '.pipeline', 'plan.orig.md'), '# Plan\n');
  fs.writeFileSync(path.join(home, 'runs', `${ID}.json`), JSON.stringify({
    id: ID, project: 'p', cwd: proj, branch: 'auto/x', state: 'paused', pid: 999999, snap: true, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    acs: ['AC-1'], tests: [], reviews: [], gates: [{ round: 1, results: [{ id: 'tests', status: 'pass', blocking: true, ms: 1200 }] }], planLint: { errors: 3, warnings: 0 },
    steps: { plan: { state: 'done', model: 'opus', runs: 1 }, build: { state: 'pending' }, review: { state: 'pending' }, commit: { state: 'pending' } } }));
  fs.writeFileSync(path.join(home, 'runs', `${ID}.test-output.txt`), '# Quality gates\nPASS  tests\n');
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: home };
  server = spawn(process.execPath, [SERVER, '--serve'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(home, 'dashboard.json')); i++) await new Promise((r) => setTimeout(r, 100));
  base = `http://127.0.0.1:${JSON.parse(fs.readFileSync(path.join(home, 'dashboard.json'), 'utf8')).port}`;
});
after(() => { server?.kill(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); });

test('the run list carries the gates and the plan check of each run', async () => {
  const runs = await (await api('/api/runs')).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].gates[0].results[0].id, 'tests');
  assert.deepEqual(runs[0].planLint, { errors: 3, warnings: 0 });
  assert.equal(runs[0].editable, true);
});

test('gate output is served from the run\'s own snapshot', async () => {
  const r = await api(`/api/runs/${ID}/file/test-output`);
  assert.equal(r.status, 200); assert.match(await r.text(), /PASS {2}tests/);
});

test('POST lint checks the text in the editor against the run\'s acceptance criteria, without saving it', async () => {
  const bad = await (await api(`/api/runs/${ID}/lint`, { method: 'POST', body: '# Plan\n\n## Goal\nx\n' })).json();
  assert.ok(bad.errors.length > 0);
  assert.ok(bad.errors.some((e) => /Tasks/.test(e.msg)));
  const good = await (await api(`/api/runs/${ID}/lint`, { method: 'POST', body: GOOD })).json();
  assert.deepEqual(good.errors, []);
  const noAc = await (await api(`/api/runs/${ID}/lint`, { method: 'POST', body: GOOD.replaceAll('AC-1', 'R1') })).json();
  assert.ok(noAc.errors.some((e) => /AC-1/.test(e.msg)));             // the run's AC-1 is no longer covered
  assert.equal(fs.readFileSync(path.join(proj, '.pipeline', 'plan.md'), 'utf8'), '# Plan\n'); // nothing was written
});

test('saving the plan returns its lint and keeps the banner\'s count in step', async () => {
  let r = await api(`/api/runs/${ID}/file/plan`, { method: 'PUT', body: GOOD });
  const body = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(body.lint.errors, []);
  assert.equal(fs.readFileSync(path.join(proj, '.pipeline', 'plan.md'), 'utf8'), GOOD);
  assert.deepEqual(record().planLint, { errors: 0, warnings: 0 });
  r = await api(`/api/runs/${ID}/file/plan`, { method: 'PUT', body: '# Plan\n\n## Goal\nx\n' });
  assert.ok((await r.json()).lint.errors.length > 0);
  assert.ok(record().planLint.errors > 0);
  assert.equal(record().state, 'paused');                              // the record is otherwise untouched
});

test('lint and save refuse other origins and oversized bodies', async () => {
  const evil = await api(`/api/runs/${ID}/lint`, { method: 'POST', body: GOOD, headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  const big = await api(`/api/runs/${ID}/lint`, { method: 'POST', body: 'x'.repeat(600 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await api('/api/runs/nope/lint', { method: 'POST', body: GOOD })).status, 404);
});

// ---- project documents: SPEC.md and ROADMAP.md, readable before any run exists -----------------------
const registry = async () => { process.env.CLAUDE_PIPELINE_HOME = home; return import(pathToFileURL(SERVER).href); }; // HOME is read when the module loads
const tmpProject = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-spec-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return d;
};

test('a registered project lists its SPEC.md and ROADMAP.md before any run exists, and follows edits', async () => {
  const { registerProject, projectId } = await registry();
  const dir = tmpProject({ 'SPEC.md': '# Spec\n- **AC-1** works\n' });
  const id = registerProject(dir);
  assert.equal(id, projectId(dir + path.sep));                                      // how the path is spelled does not change the id
  const mine = (await (await api('/api/projects')).json()).find((x) => x.id === id);
  assert.deepEqual(mine.docs, { spec: true, roadmap: false });
  assert.match(await (await api(`/api/projects/${id}/file/spec`)).text(), /AC-1/);
  assert.equal((await api(`/api/projects/${id}/file/roadmap`)).status, 404);        // not written yet
  fs.writeFileSync(path.join(dir, 'ROADMAP.md'), '# Roadmap\n## [ ] M1 - first\n');
  assert.match(await (await api(`/api/projects/${id}/file/roadmap`)).text(), /M1/); // read live: no re-registration needed
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only SPEC.md and ROADMAP.md of known projects are served, and folders without them are not listed', async () => {
  const { registerProject } = await registry();
  const dir = tmpProject({ 'SPEC.md': '# Spec\n', 'secret.txt': 'nope' });
  const id = registerProject(dir);
  const bare = registerProject(tmpProject({ 'notes.txt': 'x' }));
  const list = await (await api('/api/projects')).json();
  assert.ok(list.some((x) => x.id === id));
  assert.ok(!list.some((x) => x.id === bare), 'a folder with neither document is not a project to show');
  assert.ok(!list.some((x) => x.cwd === proj), 'a run-only folder without SPEC.md or ROADMAP.md is not listed either');
  for (const bad of [`/api/projects/${id}/file/secret.txt`, `/api/projects/${id}/file/constructor`, `/api/projects/${id}/file/..%2Fsecret.txt`, '/api/projects/0123456789ab/file/spec', '/api/projects/..%2F..%2Fx/file/spec'])
    assert.equal((await api(bad)).status, 404, bad);
  assert.equal((await api(`/api/projects/${id}/file/spec`, { method: 'PUT', body: 'x' })).status, 404);  // read-only: nothing here writes project files
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dashboard left running by an older version is replaced, and a current one is reused', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-old-'));
  // a stand-in for the old version: it answers /api/ping without a build, from a process of its own (the runner kills it by pid)
  const old = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true,pid:process.pid})));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((res) => old.stdout.once('data', (d) => res(Number(String(d).trim()))));
  fs.writeFileSync(path.join(h, 'dashboard.json'), JSON.stringify({ port, pid: old.pid }));
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: h };
  const ensure = () => spawnSync(process.execPath, [path.join(path.dirname(SERVER), 'pipeline.mjs'), '--dashboard'], { env, encoding: 'utf8', timeout: 30000 });
  const current = () => JSON.parse(fs.readFileSync(path.join(h, 'dashboard.json'), 'utf8'));
  try {
    const first = ensure();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const info = current();
    assert.notEqual(info.pid, old.pid, 'the old server was replaced');
    assert.match((await (await fetch(`http://127.0.0.1:${info.port}/api/ping`)).json()).build, /^[0-9a-f]{10}$/);
    assert.equal(ensure().status, 0);
    assert.equal(current().pid, info.pid, 'a server of the current version is reused, not restarted');
    try { process.kill(info.pid); } catch { /* already gone */ }
  } finally { old.kill(); fs.rmSync(h, { recursive: true, force: true }); }
});

test('the docs hook shows SPEC.md and ROADMAP.md in the dashboard and gives the link once both exist, once per session', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hook-'));
  const dir = tmpProject({ 'SPEC.md': '# Spec\n', 'README.md': '# Readme\n' });
  const hook = (file, { sid = 's1', env = {} } = {}) => spawnSync(process.execPath, [SERVER, '--docs-hook'],
    { env: { ...process.env, CLAUDE_PIPELINE_HOME: h, ...env }, input: JSON.stringify({ session_id: sid, tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', timeout: 30000 });
  const registered = () => { try { return fs.readdirSync(path.join(h, 'projects')).length; } catch { return 0; } };
  try {
    let r = hook(path.join(dir, 'SPEC.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'only one of the two documents exists: no link yet');
    assert.equal(registered(), 1, 'but the folder is registered, so an open dashboard already lists SPEC.md');

    hook(path.join(dir, 'README.md'), { sid: 's9' });
    assert.equal(registered(), 1, 'other files are ignored');

    fs.writeFileSync(path.join(dir, 'ROADMAP.md'), '# Roadmap\n');
    r = hook(path.join(dir, 'ROADMAP.md'));
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /http:\/\/127\.0\.0\.1:\d+\/#project=[0-9a-f]{12}/);
    assert.match(out.hookSpecificOutput.additionalContext, /#project=/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');

    assert.equal(hook(path.join(dir, 'SPEC.md')).stdout.trim(), '', 'the same session is not told twice');
    assert.match(hook(path.join(dir, 'SPEC.md'), { sid: 's2' }).stdout, /#project=/); // a new session is

    const info = JSON.parse(fs.readFileSync(path.join(h, 'dashboard.json'), 'utf8'));
    const list = await (await fetch(`http://127.0.0.1:${info.port}/api/projects`)).json();
    assert.deepEqual(list.map((p) => p.docs), [{ spec: true, roadmap: true }]);
    assert.ok(list[0].at, 'a registered project carries when it was last written, so an open page can jump to it');

    const other = tmpProject({ 'SPEC.md': '# x\n', 'ROADMAP.md': '# y\n' });
    assert.equal(hook(path.join(other, 'SPEC.md'), { env: { CLAUDE_PIPELINE_HEADLESS: '1' } }).stdout.trim(), '', 'pipeline steps never announce');
    assert.equal(registered(), 1);
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(h, 'dashboard.json'), 'utf8')).pid); } catch { /* not started */ }
    fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the docs hook also names the plugins that fit the stack the SPEC describes and are not installed', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hook2-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cfg-'));   // an empty Claude config: nothing installed
  const dir = tmpProject({ 'SPEC.md': '## Stack\n| Payments | Stripe |\n| Backend | Supabase |\n', 'ROADMAP.md': '# Roadmap\n## [ ] M1 - x\n' });
  const env = { ...process.env, CLAUDE_PIPELINE_HOME: h, CLAUDE_CONFIG_DIR: cfg };
  const hook = (sid) => spawnSync(process.execPath, [SERVER, '--docs-hook'], { env, input: JSON.stringify({ session_id: sid, tool_input: { file_path: path.join(dir, 'ROADMAP.md') } }), encoding: 'utf8', timeout: 30000 });
  try {
    const out = JSON.parse(hook('a').stdout);
    assert.match(out.systemMessage, /#project=/);
    assert.match(out.systemMessage, /Plugins that fit and are not installed: .*stripe/s);
    assert.match(out.systemMessage, /supabase/);
    assert.match(out.hookSpecificOutput.additionalContext, /Then tell them/);
    const second = JSON.parse(hook('b').stdout);                       // a new session: the link again, but the plugins were already named
    assert.match(second.systemMessage, /#project=/);
    assert.doesNotMatch(second.systemMessage, /Plugins that fit/);
  } finally {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(h, 'dashboard.json'), 'utf8')).pid); } catch { /* not started */ }
    for (const d of [h, cfg, dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});
