// Dashboard server API: plan lint endpoints and the guards around them. Uses a private CLAUDE_PIPELINE_HOME and a real server process.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
