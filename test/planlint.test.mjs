import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintPlan, formatIssues } from '../skills/setup-pipeline/planlint.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const codes = (r) => r.errors.map((e) => e.code);

const task = (n, ac, extra = '') => `### T${n}: Do thing ${n} (${ac})
- Files: \`src/a${n}.py\` (new), \`tests/test_a${n}.py\` (new)
- Do: implement the thing so that callers get a result.${extra}
- Verify: \`pytest tests/test_a${n}.py\` -> passes
`;
const plan = ({ acs = ['AC-1', 'AC-2'], tasks, matrix, command = '`pytest -q`' } = {}) => `# Plan: demo

## Goal
Add the thing.

## Non-goals
- nothing else

## Assumptions
- python 3

## Tasks
${tasks ?? acs.map((a, i) => task(i + 1, a)).join('\n')}
## Test matrix
| AC | Test | Asserts |
|---|---|---|
${matrix ?? acs.map((a, i) => `| ${a} | tests/test_a${i + 1}.py::test_thing | returns the documented result |`).join('\n')}

## Risks and rollback
- revert the commit

## Test command
${command}
`;

test('a complete milestone plan has no errors', () => {
  const r = lintPlan(plan(), { acs: ['AC-1', 'AC-2'] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.tasks, 2);
});

test('the shipped template is rejected until its placeholders are filled', () => {
  const tpl = fs.readFileSync(`${HERE}../skills/setup-pipeline/plan-template.md`, 'utf8');
  const r = lintPlan(tpl);
  assert.ok(codes(r).includes('template'));
});

test('an empty plan is one clear error', () => {
  assert.deepEqual(codes(lintPlan('  \n')), ['empty']);
});

test('missing sections are reported by name', () => {
  const r = lintPlan('# Plan\n\n## Goal\nx\n');
  const msgs = formatIssues(r.errors).join('\n');
  assert.match(msgs, /Tasks/); assert.match(msgs, /Test matrix/); assert.match(msgs, /Test command/);
});

test('every AC must be mapped to a task and to a Test matrix row', () => {
  const r = lintPlan(plan({ acs: ['AC-1'], tasks: task(1, 'AC-1'), matrix: '| AC-1 | tests/test_a1.py::test_x | works fine |' }), { acs: ['AC-1', 'AC-2'] });
  assert.deepEqual(codes(r).sort(), ['ac-task', 'ac-test']);
  assert.match(formatIssues(r.errors).join('\n'), /AC-2/);
});

test('AC-1 is not satisfied by a mention of AC-10', () => {
  const r = lintPlan(plan({ tasks: task(1, 'AC-10') + '\n' + task(2, 'AC-2'), matrix: '| AC-10 | t::a | something real |\n| AC-2 | t::b | something real |' }), { acs: ['AC-1', 'AC-2'] });
  assert.ok(codes(r).includes('ac-task') && codes(r).includes('ac-test'));
});

test('a matrix row that names no test is an error', () => {
  const r = lintPlan(plan({ matrix: '| AC-1 |  |  |\n| AC-2 | t::b | something real |' }), { acs: ['AC-1', 'AC-2'] });
  assert.deepEqual(codes(r), ['ac-test']);
  assert.ok(r.errors[0].line > 0);
});

test('tasks need Files, Verify and (in milestone mode) an AC', () => {
  const bare = '### T1: Do it\n- Do: something\n';
  const r = lintPlan(plan({ tasks: bare, matrix: '| AC-1 | t | something real |\n| AC-2 | t | something real |' }), { acs: ['AC-1', 'AC-2'] });
  assert.ok(['task-files', 'task-verify', 'task-ac'].every((c) => codes(r).includes(c)));
  const noAcs = lintPlan(plan({ acs: [], tasks: bare, matrix: '| R1 | t::x | something real |' }));
  assert.deepEqual(codes(noAcs).sort(), ['task-files', 'task-verify']); // request mode: no AC requirement
});

test('bold and bullet field styles are accepted', () => {
  const t = '### T1: Do it (AC-1)\n- **Files:** `a.py`\n- **Verify:** `pytest`\n';
  assert.deepEqual(codes(lintPlan(plan({ acs: ['AC-1'], tasks: t }), { acs: ['AC-1'] })), []);
});

test('headings inside code fences are not structure', () => {
  const t = task(1, 'AC-1') + '\n```md\n### T2: fake (AC-9)\n```\n';
  const r = lintPlan(plan({ acs: ['AC-1'], tasks: t }), { acs: ['AC-1'] });
  assert.equal(r.stats.tasks, 1);
  assert.deepEqual(r.errors, []);
});

test('a fenced Test command still counts as content', () => {
  assert.deepEqual(lintPlan(plan({ acs: ['AC-1'], command: '```\npytest -q\n```' }), { acs: ['AC-1'] }).errors, []);
});

test('request mode needs at least one matrix row', () => {
  const r = lintPlan(plan({ acs: [], tasks: task(1, 'R1'), matrix: '' }));
  assert.deepEqual(codes(r), ['matrix-empty']);
  assert.deepEqual(lintPlan(plan({ acs: [], tasks: task(1, 'R1'), matrix: '| R1 | t::x | something real |' })).errors, []);
});

test('warnings: vague wording, too many tasks/files, long plan, foreign AC', () => {
  const many = Array.from({ length: 13 }, (_, i) => task(i + 1, 'AC-1')).join('\n');
  const fat = task(1, 'AC-1').replace('`src/a1.py` (new)', '`a` `b` `c` `d` `e` `f` `g`');
  const w = (t, o) => lintPlan(t, o).warnings.map((x) => x.code);
  assert.ok(w(plan({ acs: ['AC-1'], tasks: many }), { acs: ['AC-1'] }).includes('too-many-tasks'));
  assert.ok(w(plan({ acs: ['AC-1'], tasks: fat }), { acs: ['AC-1'] }).includes('task-size'));
  assert.ok(w(plan({ acs: ['AC-1'], tasks: task(1, 'AC-1', ' TBD how errors look.') }), { acs: ['AC-1'] }).includes('vague'));
  assert.ok(w(plan({ acs: ['AC-1'], tasks: task(1, 'AC-1', ' Handle files, folders, etc.') }), { acs: ['AC-1'] }).includes('vague'));
  assert.ok(w(plan({ acs: ['AC-1'] }) + '\n'.repeat(260), { acs: ['AC-1'] }).includes('long'));
  assert.ok(w(plan({ acs: ['AC-1'], tasks: task(1, 'AC-1') + '\nAlso AC-7.\n' }), { acs: ['AC-1'] }).includes('ac-unknown'));
});

test('"todo" in prose (a todo app) is not flagged, only the TODO marker', () => {
  const w = lintPlan(plan({ acs: ['AC-1'], tasks: task(1, 'AC-1', ' A todo list app.') }), { acs: ['AC-1'] }).warnings.map((x) => x.code);
  assert.ok(!w.includes('vague'));
});
