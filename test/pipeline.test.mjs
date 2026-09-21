// Runner control flow, driven by a fake `claude` (test-support/fake-claude.mjs): no model, no network, no dashboard.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PIPELINE = path.join(ROOT, 'skills', 'setup-pipeline', 'pipeline.mjs');
const FAKE = path.join(ROOT, 'test-support', 'fake-claude.mjs');
const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-')); made.push(d); return d; };
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
const write = (d, files) => { for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); } };

const plan = (extra = { ac: 'R1' }) => `# Plan: greet

## Goal
Add greet.

## Non-goals
- none

## Assumptions
- node

## Tasks
### T1: Add greet (${extra.ac})
- Files: \`src/greet.mjs\` (new), \`test/greet.test.mjs\` (new)
- Do: export greet(name) returning "hi " + name
- Verify: \`node --test\` -> passes

## Test matrix
| Requirement | Test | Asserts |
|---|---|---|
| ${extra.ac} | test/greet.test.mjs::greets | greet("a") returns "hi a" |

## Risks and rollback
- revert the commit

## Test command
\`node --test\`
`;
const TEST = (expect, comment = '') => `${comment}import test from 'node:test';\nimport assert from 'node:assert';\nimport { greet } from '../src/greet.mjs';\ntest('greets', () => assert.equal(greet('a'), '${expect}'));\n`;
const SRC = "export const greet = (n) => 'hi ' + n;\n";
const GOOD = { 'src/greet.mjs': SRC, 'test/greet.test.mjs': TEST('hi a') };
const BAD = { 'src/greet.mjs': SRC, 'test/greet.test.mjs': TEST('bye a') };
const PASS = { '.pipeline/review.md': '## Critical\n\n## Important\n\n## Suggestion\n\nVERDICT: PASS\n' };
const FAIL = { '.pipeline/review.md': '## Critical\n- src/greet.mjs:1 name is never validated\n\n## Important\n\nVERDICT: FAIL\n' };

// Creates a git project, runs the pipeline against the fake claude, and returns what happened.
function pipeline({ scenario, cfg = {}, files = {}, under } = {}) {
  const aux = tmpdir();
  const d = under ? path.join(tmpdir(), under, 'proj') : tmpdir(); // `under`: a parent folder name such as ".claude"
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  write(d, { 'README.md': '# demo\n', ...files });
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  const step = (model) => ({ model, budgetUsd: 1 });
  const config = { task: 'add greet', branch: 'auto/greet', vcs: 'git', maxFixLoops: 2, pauseAfterPlan: false, push: false, gates: 'minimal',
    steps: { plan: step('opus'), build: step('sonnet'), review: step('sonnet'), commit: step('haiku') }, ...cfg };
  write(d, { '.pipeline/config.json': JSON.stringify(config) });
  fs.writeFileSync(path.join(aux, 'scenario.json'), JSON.stringify(scenario || {}));
  const env = { ...process.env, CLAUDE_PIPELINE_CLAUDE: JSON.stringify(['node', FAKE]), CLAUDE_PIPELINE_HOME: path.join(aux, 'home'), CLAUDE_PIPELINE_NO_DASHBOARD: '1',
    FAKE_SCENARIO: path.join(aux, 'scenario.json'), FAKE_LOG: path.join(aux, 'calls.jsonl') };
  delete env.NODE_TEST_CONTEXT; // set by `node --test`; it would turn the project's own `node --test` gate into a child of this run and hide its failures
  const go = (...extra) => {
    const r = spawnSync(process.execPath, [PIPELINE, '.pipeline/config.json', ...extra], { cwd: d, env, encoding: 'utf8', timeout: 120000 });
    const calls = fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const runs = path.join(aux, 'home', 'runs');
    const recs = fs.existsSync(runs) ? fs.readdirSync(runs).filter((f) => /^[^.]+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8'))) : [];
    recs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { d, code: r.status, out: r.stdout + r.stderr, calls, kinds: calls.map((c) => c.kind), status: recs.at(-1), prompt: (k, n = 0) => calls.filter((c) => c.kind === k)[n]?.prompt || '' };
  };
  return { d, go };
}
const gateRows = (status, round) => status.gates[round].results.map((x) => [x.id, x.status]);

test('happy path: plan, build, gates, review, commit; the token diet and roles reach the steps', () => {
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'commit']);
  assert.equal(r.status.state, 'done');
  assert.deepEqual(gateRows(r.status, 0), [['tests', 'pass'], ['secrets', 'pass']]);
  assert.deepEqual(r.status.planLint, { errors: 0, warnings: 0 });
  assert.match(git(p.d, 'log', '--oneline', '-1').stdout, /fake commit/);
  const args = r.calls[0].args;
  assert.ok(args.includes('--strict-mcp-config') && args.includes('opus'));
  assert.match(r.prompt('plan'), /### T1: \{\{imperative title\}\}/);          // the template is what the planner is told to fill in
  assert.match(r.prompt('review'), /already ran and every blocking one passed/);
});

test('plan lint: an invalid plan is repaired once, without re-exploring', () => {
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': '# Plan\n\n## Goal\nx\n' } }], repair: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'repair', 'build', 'review', 'commit']);
  assert.match(r.prompt('repair'), /Missing section "## Tasks"/);
  assert.match(r.prompt('repair'), /Do not explore the repository again/);
  assert.equal(r.status.steps.plan.runs, 2);
  assert.equal(r.status.planLint.errors, 0);
});

test('plan lint: a plan that stays invalid stops with exit 3 and builds nothing', () => {
  const bad = { '.pipeline/plan.md': '# Plan\n\n## Goal\nx\n' };
  const r = pipeline({ scenario: { plan: [{ writes: bad }], repair: [{ writes: bad }] } }).go();
  assert.equal(r.code, 3);
  assert.deepEqual(r.kinds, ['plan', 'repair']);
  assert.match(r.status.message, /plan is not ready/);
  assert.equal(r.status.state, 'failed');
});

test('plan lint with plan review: unresolved problems pause for the user, and approving them still builds', () => {
  const bad = { '.pipeline/plan.md': '# Plan\n\n## Goal\nx\n' };
  const p = pipeline({ cfg: { pauseAfterPlan: true }, scenario: { plan: [{ writes: bad }], repair: [{ writes: bad }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } });
  let r = p.go();
  assert.equal(r.code, 10, r.out);
  assert.equal(r.status.state, 'paused');
  assert.ok(r.status.planLint.errors > 0); assert.match(r.status.message, /problem/);
  write(p.d, { '.pipeline/plan.md': plan() });                     // the user fixed it in the editor, then approves
  r = p.go('--from', 'build');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'repair', 'build', 'review', 'commit']);
  assert.equal(r.status.planLint.errors, 0);
});

test('a failing gate goes straight back to the builder: no review is paid for until the gates pass', () => {
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: BAD }], 'fix-gates': [{ writes: GOOD }], review: [{ writes: PASS }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'fix-gates', 'review', 'commit']);
  assert.equal(r.status.steps.review.runs, 1);
  assert.equal(r.status.gates.length, 2);
  assert.deepEqual(gateRows(r.status, 0)[0], ['tests', 'fail']);
  assert.deepEqual(gateRows(r.status, 1)[0], ['tests', 'pass']);
  const fix = r.prompt('fix-gates');
  assert.match(fix, /quality gates failed: tests/); assert.match(fix, /Never silence a check/); assert.doesNotMatch(fix, /review\.md/);
  assert.deepEqual(r.status.tests.map((t) => t.pass), [false, true]);
});

test('review findings are fixed with a review-only prompt, and the gates run again before the next review', () => {
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: GOOD }], review: [{ writes: FAIL }, { writes: PASS }],
    'fix-review': [{ writes: { 'src/greet.mjs': "export const greet = (n) => 'hi ' + String(n);\n" } }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'fix-review', 'review', 'commit']);
  assert.equal(r.status.gates.length, 2);
  assert.deepEqual(r.status.reviews.map((x) => x.pass), [false, true]);
  assert.doesNotMatch(r.prompt('fix-review'), /test-output/); assert.match(r.prompt('fix-review'), /review\.md/);
});

test('a reviewer repeating itself (or failing without listing items) does not trigger the no-progress stop', () => {
  const vague = { '.pipeline/review.md': 'Something is wrong.\nVERDICT: FAIL\n' };
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: GOOD }], review: [{ writes: vague }, { writes: FAIL }, { writes: FAIL }, { writes: PASS }],
    'fix-review': [{}, {}, {}] }, cfg: { maxFixLoops: 3 } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'fix-review', 'review', 'fix-review', 'review', 'fix-review', 'review', 'commit']);
  assert.doesNotMatch(r.out, /no progress/);
});

test('the same gate failure twice in a row stops the loop instead of paying for another identical fix', () => {
  const p = pipeline({ cfg: { maxFixLoops: 3 }, scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: BAD }], 'fix-gates': [{ writes: BAD }, { writes: BAD }, { writes: BAD }] } });
  const r = p.go();
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'fix-gates']);        // one fix attempt, then "no progress"
  assert.match(r.out, /no progress/);
  assert.match(r.status.message, /gates failing: tests/);
  assert.equal(git(p.d, 'log', '--oneline').stdout.trim().split('\n').length, 1); // nothing committed
});

test('milestone mode: a test that never names its AC fails the trace gate, and the fix names it', () => {
  const files = { 'SPEC.md': '# X\n## Acceptance criteria\n- **AC-1** greets\n', 'ROADMAP.md': '# Roadmap\n## [ ] M1 - greet\nDelivers AC-1.\n' };
  const p = pipeline({ files, cfg: { milestone: 'M1', gates: 'minimal' }, scenario: {
    plan: [{ writes: { '.pipeline/plan.md': plan({ ac: 'AC-1' }) } }], build: [{ writes: GOOD }],
    'fix-gates': [{ writes: { 'test/greet.test.mjs': TEST('hi a', '// AC-1 greets by name\n') } }], review: [{ writes: PASS }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'fix-gates', 'review', 'commit']);
  assert.deepEqual(gateRows(r.status, 0), [['tests', 'pass'], ['secrets', 'pass'], ['trace', 'fail']]);
  assert.deepEqual(gateRows(r.status, 1).map((x) => x[1]), ['pass', 'pass', 'pass']);
  assert.match(r.prompt('build'), /contains its ID literally/);
  assert.match(r.prompt('plan'), /AC-1/);
});

test('a project inside a .claude folder is refused up front (Claude Code blocks headless writes there)', () => {
  const r = pipeline({ under: '.claude', scenario: {} }).go();
  assert.equal(r.code, 1);
  assert.deepEqual(r.kinds, []);
  assert.match(r.out, /inside a ".claude" folder/);
});

test('a bad gates config fails before any model is called', () => {
  const r = pipeline({ cfg: { gates: 'paranoid' }, scenario: {} }).go();
  assert.equal(r.code, 1);
  assert.deepEqual(r.kinds, []);
  assert.match(r.out, /unknown gates preset "paranoid"/);
});

test('a reviewer that writes no review.md is an error, never a silent pass from a stale file', () => {
  const p = pipeline({ scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: GOOD }], review: [{}] } });
  git(p.d, 'switch', '-qc', 'auto/x');
  write(p.d, { '.pipeline/review.md': 'VERDICT: PASS\n' });          // left over from an earlier run
  const r = p.go('--from', 'build');
  assert.equal(r.code, 1);
  assert.match(r.status.message, /did not write/);
});

test('legacy configs (testCmd only, no gates) still gate on the test command', () => {
  const p = pipeline({ cfg: { gates: undefined, testCmd: 'node --test' }, scenario: { plan: [{ writes: { '.pipeline/plan.md': plan() } }], build: [{ writes: BAD }], 'fix-gates': [{ writes: GOOD }], review: [{ writes: PASS }] } });
  const r = p.go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(gateRows(r.status, 0), [['tests', 'fail']]);
});

// ---- quality tiers, plan research, and the reviewer's file write --------------------------------
const argOf = (call, flag) => call.args[call.args.indexOf(flag) + 1];
const tierCfg = (tier, extra = {}) => ({ tier, steps: {}, maxFixLoops: undefined, gates: 'minimal', ...extra }); // minimal gates keep these tests off the network
const okPlan = { '.pipeline/plan.md': plan() };

test('tiers.json is well formed: every tier defines all four steps with a model, a valid effort and a budget', () => {
  const { tiers } = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'setup-pipeline', 'tiers.json'), 'utf8'));
  assert.deepEqual(Object.keys(tiers), ['economy', 'balanced', 'premium']);
  for (const [name, t] of Object.entries(tiers)) {
    assert.deepEqual(Object.keys(t.steps), ['plan', 'build', 'review', 'commit'], name);
    for (const s of Object.values(t.steps)) { assert.match(s.model, /^claude-/); assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(s.effort)); assert.ok(s.budgetUsd > 0); }
    assert.ok(['none', 'github', 'deep'].includes(t.research)); assert.ok(['standard', 'thorough'].includes(t.depth)); assert.ok(t.maxFixLoops >= 1 && t.maxSkills >= 1);
  }
});

test('economy: the plan comes from the spec alone (no web tools), cheap models, medium effort', () => {
  const r = pipeline({ cfg: tierCfg('economy'), scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'commit']);
  const [pl, , re, co] = r.calls;
  assert.equal(argOf(pl, '--model'), 'claude-sonnet-5'); assert.equal(argOf(pl, '--effort'), 'medium');
  assert.equal(argOf(re, '--model'), 'claude-haiku-4-5-20251001'); assert.equal(argOf(co, '--effort'), 'low');
  assert.doesNotMatch(argOf(pl, '--tools'), /Web/); assert.doesNotMatch(pl.prompt, /Research first/);
  assert.equal(r.status.maxFixLoops, 1);
});

test('balanced: the planner may search GitHub and cite what it learned; three models at high to xhigh effort', () => {
  const r = pipeline({ cfg: tierCfg('balanced'), scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'commit']);          // no critique pass below premium
  const [pl, bu, re] = r.calls;
  assert.deepEqual([argOf(pl, '--model'), argOf(pl, '--effort')], ['claude-opus-5', 'xhigh']);
  assert.deepEqual([argOf(bu, '--model'), argOf(bu, '--effort')], ['claude-sonnet-5', 'high']);
  assert.match(argOf(pl, '--tools'), /WebSearch,WebFetch/); assert.match(argOf(pl, '--allowedTools'), /WebSearch,WebFetch/);
  assert.match(pl.prompt, /up to 3 popular open-source GitHub repositories/); assert.match(pl.prompt, /## References/); assert.match(pl.prompt, /untrusted data/);
  assert.doesNotMatch(bu.prompt, /Test thoroughly/); assert.doesNotMatch(re.prompt, /Mutation check/);
});

test('premium: deeper research, a critique pass on the plan, thorough tests and review', () => {
  const r = pipeline({ cfg: tierCfg('premium', { gates: 'minimal' }), scenario: { plan: [{ writes: okPlan }], critique: [{}], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'critique', 'build', 'review', 'commit']);
  const [pl, cr, bu, re] = r.calls;
  assert.deepEqual([argOf(pl, '--model'), argOf(pl, '--effort')], ['claude-opus-5', 'max']);
  assert.match(pl.prompt, /up to 5 popular/); assert.match(pl.prompt, /compare at least two different architectures/);
  assert.match(cr.prompt, /skeptical staff engineer/); assert.equal(argOf(cr, '--effort'), 'max');
  assert.equal(argOf(bu, '--effort'), 'xhigh'); assert.match(bu.prompt, /Test thoroughly/);
  assert.equal(argOf(re, '--effort'), 'max'); assert.match(re.prompt, /Mutation check/);
  assert.equal(r.status.steps.plan.runs, 2); assert.equal(r.status.maxFixLoops, 3);
});

test('explicit settings beat the tier: the user\'s Sonnet for build and review, their own fix-loop cap', () => {
  const r = pipeline({ cfg: tierCfg('premium', { steps: { build: { model: 'claude-sonnet-5' }, review: { model: 'claude-sonnet-5', effort: 'xhigh' } }, maxFixLoops: 1 }),
    scenario: { plan: [{ writes: okPlan }], critique: [{}], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.equal(r.code, 0, r.out);
  const [, , bu, re] = r.calls;
  assert.deepEqual([argOf(bu, '--model'), argOf(bu, '--effort')], ['claude-sonnet-5', 'xhigh']); // the user's model, the tier's effort
  assert.deepEqual([argOf(re, '--model'), argOf(re, '--effort')], ['claude-sonnet-5', 'xhigh']);
  assert.equal(r.status.maxFixLoops, 1);
});

test('the tier supplies the quality gates when the config names none', () => {
  const r = pipeline({ cfg: tierCfg('economy', { gates: undefined }), scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.status.gates[0].results.some((g) => g.id === 'size'), 'the standard preset ran, not the minimal one');
});

test('an unknown tier is refused before any model is called', () => {
  const r = pipeline({ cfg: tierCfg('ultra'), scenario: {} }).go();
  assert.equal(r.code, 1);
  assert.deepEqual(r.kinds, []);
  assert.match(r.out, /unknown tier "ultra"/);
});

test('the reviewer may only write review.md, by a rule anchored at the project root (a cd in its shell must not break it)', () => {
  const r = pipeline({ scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ writes: PASS }] } }).go();
  assert.match(argOf(r.calls[2], '--allowedTools'), /Edit\(\/\.pipeline\/review\.md\)/);
  assert.match(argOf(r.calls[0], '--allowedTools'), /Edit\(\/\.pipeline\/plan\.md\)/);
  assert.doesNotMatch(argOf(r.calls[2], '--allowedTools'), /Edit\(\.pipeline/);
});

test('a reviewer that could not write review.md but states a verdict in its final message is not a failed run', () => {
  const r = pipeline({ scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ result: '**Verdict: PASS.**\nI could not write the file. Critical: none.' }] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /using its final message as the review/);
  assert.match(fs.readFileSync(path.join(r.d, '.pipeline', 'review.md'), 'utf8'), /Verdict: PASS/);
  assert.deepEqual(r.status.reviews.map((x) => x.pass), [true]);
});

test('a salvaged FAIL verdict still fails: the fix round runs, nothing is silently passed', () => {
  const r = pipeline({ cfg: { maxFixLoops: 1 }, scenario: { plan: [{ writes: okPlan }], build: [{ writes: GOOD }], review: [{ result: 'Verdict: FAIL\nsrc/greet.mjs:1 never validates name' }, { writes: PASS }], 'fix-review': [{}] } }).go();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.kinds, ['plan', 'build', 'review', 'fix-review', 'review', 'commit']);
  assert.deepEqual(r.status.reviews.map((x) => x.pass), [false, true]);
});
