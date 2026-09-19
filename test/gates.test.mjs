import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planGates, runGates, formatReport, blockingFailed, summarize, trim, builtinSecrets } from '../skills/setup-pipeline/gates.mjs';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
const write = (d, files) => { for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); } };
// A temp project; with { git: true } it is a repository with one commit containing `files`.
const tmp = (files = {}, o = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-')); dirs.push(d);
  write(d, files);
  if (o.git) { git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init', '--allow-empty'); }
  return d;
};
const plan = (cfg, d, acs) => planGates(cfg, d, { acs });
const byId = (p) => Object.fromEntries(p.gates.map((g) => [g.id, g]));
const runOne = async (cfg, d, acs) => { const p = plan(cfg, d, acs); return runGates(p.gates, p.ctx); };
// token-shaped strings are assembled at run time so this file itself never holds one
const GH = ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5'].join('_');
const AWS = 'AKI' + 'A' + 'Q2W3E4R5T6Y7U8I9';

test('gates config: preset name, id list, object form, legacy testCmd', () => {
  const d = tmp();
  const ids = (cfg, acs) => plan(cfg, d, acs).gates.map((g) => g.id);
  assert.deepEqual(ids({ gates: 'minimal' }), ['tests', 'secrets']);  // trace needs acceptance-criterion IDs
  assert.deepEqual(ids({ gates: 'minimal' }, ['AC-1']), ['tests', 'secrets', 'trace']);
  assert.deepEqual(ids({ gates: ['tests', { id: 'mine', cmd: 'echo hi' }] }), ['tests', 'mine']);
  const p = plan({ gates: { preset: 'minimal', add: ['size'], skip: ['secrets'], warn: ['tests'] } }, d);
  assert.deepEqual(p.gates.map((g) => [g.id, g.blocking]), [['tests', false], ['size', false]]);
  assert.equal(byId(plan({ gates: { preset: 'standard', block: ['size'] } }, d)).size.blocking, true);
  assert.deepEqual(ids({ testCmd: 'echo ok' }), ['tests']);          // configs written before gates existed
  assert.equal(plan({ testCmd: 'echo ok' }, d).gates[0].cmd, 'echo ok');
  assert.deepEqual(ids({}), []);
  assert.throws(() => plan({ gates: 'paranoid' }, d), /unknown gates preset/);
  assert.match(byId(plan({ gates: ['nope'] }, d)).nope.skip, /unknown gate/);
});

test('Node project: uses the project\'s own scripts', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc', typecheck: 'tsc --noEmit' } }) });
  const g = byId(plan({ gates: 'standard' }, d));
  assert.equal(g.tests.cmd, 'npm test --silent');
  assert.equal(g.lint.cmd, 'npm run lint --silent');
  assert.equal(g.types.cmd, 'npm run typecheck --silent');
  assert.equal(g.build.cmd, 'npm run build --silent');
});

test('the npm default "no test specified" stub is not a test command', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.match(byId(plan({ gates: 'minimal' }, d)).tests.skip, /no test command found/);
});

test('a plain Node folder with test/ files runs node --test', () => {
  const d = tmp({ 'test/a.test.js': 'x' });
  assert.equal(byId(plan({ gates: 'minimal' }, d)).tests.cmd, 'node --test');
});

test('SPEC.md Commands table beats detection, placeholders and later tables are ignored, testCmd beats SPEC', () => {
  const spec = '# X\n## Commands\n| Purpose | Command |\n|---|---|\n| Install | `npm i` |\n| Test | `node --test tests/` |\n| Lint | `<...>` |\n\n## Assumptions\n| Build | `nope` |\n';
  const d = tmp({ 'SPEC.md': spec, 'package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }) });
  const g = byId(plan({ gates: 'standard' }, d));
  assert.equal(g.tests.cmd, 'node --test tests/');
  assert.match(g.lint.skip, /no linter configured/);               // the placeholder row is not a command
  assert.equal(g.build.cmd, 'npm run build --silent');             // the Build row sits under another heading
  assert.equal(byId(plan({ gates: 'minimal', testCmd: 'make check' }, d)).tests.cmd, 'make check');
});

test('Python project: lint uses ruff when present, otherwise a skip with the install command; no mypy config -> explained skip', () => {
  const d = tmp({ 'pyproject.toml': '[project]\nname = "x"\n', 'tests/test_a.py': 'def test_a(): pass\n' });
  const g = byId(plan({ gates: 'standard' }, d));
  if (g.lint.cmd) assert.equal(g.lint.cmd, 'ruff check --select E4,E7,E9,F .'); // no ruff config: only real errors
  else assert.match(g.lint.skip, /ruff/);
  assert.match(g.types.skip, /no type checker configured/);
  const cfg = byId(plan({ gates: 'standard' }, tmp({ 'ruff.toml': 'line-length = 100\n', 'a.py': 'x = 1\n' })));
  if (cfg.lint.cmd) assert.equal(cfg.lint.cmd, 'ruff check .');    // the project's own rules win
});

test('audit needs a manifest; pre-commit only when configured', () => {
  assert.match(byId(plan({ gates: ['audit'] }, tmp())).audit.skip, /no lockfile/);
  assert.equal(plan({ gates: ['precommit'] }, tmp()).gates.length, 0);
  assert.match(byId(plan({ gates: ['precommit'] }, tmp({ '.pre-commit-config.yaml': 'repos: []\n' }))).precommit.skip || 'ran', /not installed|ran/);
});

test('custom gates: pass, blocking fail, advisory fail, timeout, unattended env', async () => {
  const d = tmp();
  const r = Object.fromEntries((await runOne({ gates: { preset: 'minimal', skip: ['tests', 'secrets'], custom: [
    { id: 'ok', cmd: 'node -e "console.log(process.env.CI)"' },
    { id: 'bad', cmd: 'node -e "console.error(\'boom\'); process.exit(3)"' },
    { id: 'soft', cmd: 'node -e "process.exit(1)"', blocking: false },
    { id: 'slow', cmd: 'node -e "setTimeout(() => {}, 20000)"', timeoutSec: 1 },
  ] } }, d)).map((x) => [x.id, x]));
  assert.equal(r.ok.status, 'pass'); assert.equal(r.ok.out.trim(), '1');
  assert.equal(r.bad.status, 'fail'); assert.match(r.bad.note, /boom/);
  assert.equal(r.soft.status, 'warn');
  assert.equal(r.slow.status, 'timeout'); assert.match(r.slow.note, /timed out/);
  assert.deepEqual(blockingFailed(Object.values(r)).map((x) => x.id), ['bad', 'slow']);
  assert.match(summarize(Object.values(r)), /ok pass, bad fail, soft warn, slow timeout/);
});

test('commands run in the project folder', async () => {
  const d = tmp({ 'marker.txt': 'hi' });
  const [r] = await runOne({ gates: [{ id: 'here', cmd: 'node -e "console.log(require(\'fs\').existsSync(\'marker.txt\'))"' }] }, d);
  assert.equal(r.out.trim(), 'true');
});

test('trace: every AC ID must appear in a test file (AC-1 is not satisfied by AC-10)', async () => {
  const d = tmp({ 'tests/test_a.py': '# AC-1 adds numbers\ndef test_a(): pass\n', 'app.py': '# AC-2 lives here but this is not a test\n' }, { git: true });
  let [r] = await runOne({ gates: ['trace'] }, d, ['AC-1', 'AC-2']);
  assert.equal(r.status, 'fail'); assert.match(r.note, /AC-2/); assert.doesNotMatch(r.note, /AC-1/);
  write(d, { 'tests/test_b.py': '"""AC-2: rejects empty input"""\n' });
  [r] = await runOne({ gates: ['trace'] }, d, ['AC-1', 'AC-2']);
  assert.equal(r.status, 'pass');
  write(d, { 'tests/test_a.py': '# AC-10 only\n', 'tests/test_b.py': '# nothing\n' });
  [r] = await runOne({ gates: ['trace'] }, d, ['AC-1']);
  assert.equal(r.status, 'fail');
});

test('trace: a function name such as test_ac_2_rejects_empty names AC-2, but test_ac_20 does not', async () => {
  const d = tmp({ 'tests/test_a.py': 'def test_ac_1_adds(): pass\ndef test_ac_20_other(): pass\n' }, { git: true });
  const [r] = await runOne({ gates: ['trace'] }, d, ['AC-1', 'AC-2']);
  assert.equal(r.status, 'fail'); assert.match(r.note, /AC-2/); assert.doesNotMatch(r.note, /AC-1/);
});

test('trace: no test files at all is a failure', async () => {
  const d = tmp({ 'app.py': 'x = 1\n' }, { git: true });
  const [r] = await runOne({ gates: ['trace'] }, d, ['AC-1']);
  assert.equal(r.status, 'fail'); assert.match(r.note, /no test files/);
});

test('secrets: built-in patterns find tokens, keys and credentials but skip placeholders and marked lines', () => {
  const line = (text) => [{ file: 'f.py', line: 1, text }];
  // No `name = "value"` literal may exist in this file (secret scanners flag it, fake or not): every fixture is assembled at run time.
  const assign = (name, value) => `${name} = "${value}"`;
  const FAKE = ['q8Zk3v', 'N7pLw2', 'Rt5YxB9'].join('');
  const found = [assign('T', GH), `k = ${AWS}`, '-----BEGIN ' + 'RSA PRIVATE KEY-----', assign('pass' + 'word', FAKE)];
  const skipped = [assign('API_' + 'KEY', 'your-api-key-goes-here-' + '123'), 'token = process.env.API_TOKEN', `k = ${AWS} # pipeline:allow-secret`,
    `key = ${'AKIAIOSFODNN7' + 'EXAMPLE'}`, assign('pass' + 'word', 'a'.repeat(20)), 'const x = 1;'];
  for (const text of found) assert.equal(builtinSecrets(line(text)).length, 1, text);
  for (const text of skipped) assert.equal(builtinSecrets(line(text)).length, 0, text);
  assert.equal(builtinSecrets([{ file: '.env', line: 1, text: 'A=1' }]).length, 1);
  assert.equal(builtinSecrets([{ file: 'cfg/.env.local', line: 1, text: 'A=1' }]).length, 1);
  assert.equal(builtinSecrets([{ file: '.env.example', line: 1, text: 'A=1' }]).length, 0);
});

test('secrets: a leaked token in a new file fails with file:line, never prints the value, and leaves the index alone', async () => {
  const d = tmp({ 'app.py': 'x = 1\n' }, { git: true });
  write(d, { 'config.py': `import os\nGITHUB_TOKEN = "${GH}"\n`, '.gitignore': 'ignored.txt\n', 'ignored.txt': `${GH}\n` });
  const [r] = await runOne({ gates: ['secrets'] }, d);
  assert.equal(r.status, 'fail');
  assert.match(r.out, /config\.py:2/);
  assert.doesNotMatch(r.out + r.note, new RegExp(GH.slice(4, 30)));
  assert.doesNotMatch(r.out, /ignored\.txt/);
  assert.equal(git(d, 'diff', '--cached', '--name-only').stdout.trim(), ''); // no intent-to-add side effects
});

test('secrets: a clean change passes; a modified tracked file is scanned too', async () => {
  const d = tmp({ 'app.py': 'x = 1\n' }, { git: true });
  write(d, { 'new.py': 'print("hello")\n' });
  assert.equal((await runOne({ gates: ['secrets'] }, d))[0].status, 'pass');
  write(d, { 'app.py': `x = 1\nKEY = "${GH}"\n` });
  const [r] = await runOne({ gates: ['secrets'] }, d);
  assert.equal(r.status, 'fail'); assert.match(r.out, /app\.py:2/);
});

test('secrets outside a git repository is skipped, not failed', async () => {
  const [r] = await runOne({ gates: ['secrets'] }, tmp({ 'a.py': 'x = 1\n' }));
  assert.equal(r.status, 'skip');
});

test('size: a very large change is an advisory warning, a normal one passes with a count', async () => {
  const d = tmp({ 'app.py': 'x = 1\n' }, { git: true });
  write(d, { 'small.py': 'a = 1\nb = 2\n' });
  let [r] = await runOne({ gates: ['size'] }, d);
  assert.equal(r.status, 'pass'); assert.match(r.note, /2 added lines in 1 files/);
  write(d, { 'big.py': Array.from({ length: 900 }, (_, i) => `v${i} = ${i}`).join('\n') + '\n' });
  [r] = await runOne({ gates: ['size'] }, d);
  assert.equal(r.status, 'warn'); assert.equal(blockingFailed([r]).length, 0);
});

test('trim keeps the head and the tail of long output and strips colour codes', () => {
  assert.equal(trim('\x1b[31mred\x1b[0m\r\n\n\n\nok'), 'red\n\nok');
  const t = trim(`${'a'.repeat(500)}${'m'.repeat(20000)}${'z'.repeat(500)}`, 2000);
  assert.ok(t.startsWith('aaa') && t.endsWith('zzz') && /characters omitted/.test(t) && t.length < 2200);
});

test('the report lists every gate and shows output only for the ones that did not pass', () => {
  const rs = [
    { id: 'tests', status: 'pass', blocking: true, cmd: 'npm test', ms: 1200, out: 'ALL GOOD-DETAIL' },
    { id: 'lint', status: 'fail', blocking: true, cmd: 'ruff check .', ms: 300, note: 'Found 1 error.', out: 'F401 unused import' },
    { id: 'audit', status: 'warn', blocking: false, cmd: 'osv-scanner', ms: 4000, note: '3 vulns', out: 'table' },
    { id: 'types', status: 'skip', blocking: true, note: 'mypy is not installed (install: pip install mypy)', ms: 0, out: '' },
  ];
  const t = formatReport(rs, 2);
  assert.match(t, /round 2/); assert.match(t, /PASS {2}tests/); assert.match(t, /FAIL {2}lint/); assert.match(t, /WARN {2}audit \(advisory\)/); assert.match(t, /SKIP {2}types/);
  assert.match(t, /## FAIL lint\nF401 unused import/); assert.match(t, /## WARN audit/);
  assert.doesNotMatch(t, /ALL GOOD-DETAIL/);
});
