#!/usr/bin/env node
// Plan lint: cheap structural checks that catch a vague plan before the builder spends money on it.
//   node planlint.mjs <plan.md> [--acs AC-1,AC-2] [--json]      exit 1 when the plan has errors
// The structure it expects is plan-template.md (Goal, Tasks with Files/Verify, Test matrix, Test command).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const mention = (text, id) => new RegExp(String.raw`(?<!\w)${id}(?!\d)`).test(text); // AC-1 must not match AC-10
const field = (txt, names) => new RegExp(String.raw`^\s*(?:[-*+]\s+)?\**(?:${names})\**\s*:\**\s*(.*)$`, 'im').exec(txt);
const SECTIONS = [ // [key, label, heading pattern]
  ['goal', 'Goal', /^goal/i],
  ['tasks', 'Tasks', /^tasks?\b/i],
  ['matrix', 'Test matrix', /^tests?\s*(?:matrix|plan|cases)|^tests$/i],
  ['command', 'Test command', /^(?:test|run)\s*command/i],
];
const OPTIONAL = [['Non-goals', /^non-?goals?/i], ['Assumptions', /^assumptions?/i], ['Risks and rollback', /^risks?/i]];
const TASK = /^#{3,4}\s*(?:task\s*)?T?(\d+)\b\s*[:.)-]?\s*(.*)$/i;

// Returns { errors, warnings, stats }; every issue is { code, line (1-based, 0 = whole plan), msg }.
export function lintPlan(text, { acs = [] } = {}) {
  const errors = [], warnings = [];
  const err = (code, line, msg) => errors.push({ code, line, msg });
  const warn = (code, line, msg) => warnings.push({ code, line, msg });
  if (!String(text || '').trim()) { err('empty', 0, 'The plan is empty.'); return { errors, warnings, stats: { lines: 0, tasks: 0 } }; }

  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  let fenced = false; // headings inside code fences are not structure
  const heads = [];
  raw.forEach((l, i) => {
    if (/^\s*(?:```|~~~)/.test(l)) { fenced = !fenced; return; }
    const m = !fenced && /^(#{1,6})\s+(.*?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1].length, name: m[2], line: l });
  });
  const span = (h) => { const next = heads.find((x) => x.i > h.i && x.level <= h.level); return [h.i + 1, next ? next.i : raw.length]; };
  const body = (h) => raw.slice(...span(h)).join('\n');

  const sec = {};
  for (const [k, label, re] of SECTIONS) {
    const h = heads.find((x) => x.level <= 2 && re.test(x.name));
    if (!h) err('section', 0, `Missing section "## ${label}".`);
    else if (!body(h).trim()) err('section', h.i + 1, `Section "${label}" is empty.`);
    else sec[k] = { h, text: body(h) };
  }

  const tasks = sec.tasks ? heads.filter((h) => h.level >= 3 && h.i > sec.tasks.h.i && h.i < span(sec.tasks.h)[1] && TASK.test(h.line)) : [];
  if (sec.tasks && !tasks.length) err('tasks', sec.tasks.h.i + 1, 'No tasks found: write one "### T1: title (AC-1)" heading per task.');
  for (const t of tasks) {
    const txt = body(t), id = `T${TASK.exec(t.line)[1]}`;
    const files = field(txt, 'files?');
    if (!files) err('task-files', t.i + 1, `${id} has no "Files:" line.`);
    else if ((files[1].match(/`[^`]+`/g) || []).length > 6) warn('task-size', t.i + 1, `${id} touches more than 6 files; smaller tasks are easier to build and to review.`);
    if (!field(txt, 'verif(?:y|ication)|how to verify')) err('task-verify', t.i + 1, `${id} has no "Verify:" line (the command or check that proves it works).`);
    if (acs.length && !/AC-\d+/.test(t.line + '\n' + txt)) err('task-ac', t.i + 1, `${id} does not name the acceptance criterion it satisfies.`);
  }
  if (tasks.length > 12) warn('too-many-tasks', 0, `${tasks.length} tasks in one plan: consider splitting the milestone.`);

  if (sec.matrix) {
    const rows = sec.matrix.text.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+$/.test(l)); // table rows without the separator
    if (!acs.length && rows.length < 2 && !/^\s*[-*]\s+\S/m.test(sec.matrix.text)) err('matrix-empty', sec.matrix.h.i + 1, 'The Test matrix has no rows: list which test proves each requirement.');
  }
  const [mFrom] = sec.matrix ? span(sec.matrix.h) : [0];
  for (const ac of acs) {
    if (sec.tasks && !mention(sec.tasks.text, ac)) err('ac-task', 0, `${ac} is not mapped to any task.`);
    if (!sec.matrix) continue;
    const rows = raw.slice(mFrom, span(sec.matrix.h)[1]).map((l, i) => [l, mFrom + i + 1]).filter(([l]) => mention(l, ac));
    if (!rows.length) err('ac-test', 0, `${ac} has no row in the Test matrix.`);
    else if (!rows.some(([l]) => l.replace(/AC-\d+/g, '').replace(/[|\s:-]/g, '').length >= 8)) err('ac-test', rows[0][1], `${ac}'s Test matrix row names no test or assertion.`);
  }

  const hits = (re) => raw.flatMap((l, i) => (re.test(l) ? [[i + 1, l.trim().slice(0, 60)]] : []));
  const bad = hits(/\{\{[^}\n]*\}\}/);
  for (const [n, s] of bad.slice(0, 5)) err('template', n, `Unfilled template placeholder: ${s}`);
  if (bad.length > 5) err('template', 0, `${bad.length - 5} more unfilled placeholders.`);
  const vague = hits(/^(?!.*\{\{).*(?:\b(?:TBD|TODO|FIXME)\b|\b(?:to be (?:decided|determined)|and so on|etc\.?)(?!\w))/);
  for (const [n, s] of vague.slice(0, 5)) warn('vague', n, `Vague or unfinished wording: ${s}`);
  if (vague.length > 5) warn('vague', 0, `${vague.length - 5} more vague spots.`);
  if (raw.length > 250) warn('long', 0, `The plan is ${raw.length} lines and every build round re-reads it: trim it to what the builder needs.`);
  const missingOpt = OPTIONAL.filter(([, re]) => !heads.some((h) => h.level <= 2 && re.test(h.name))).map(([n]) => n);
  if (missingOpt.length) warn('optional', 0, `No ${missingOpt.join(' / ')} section: stating them prevents scope creep and hidden guesses.`);
  if (acs.length) for (const id of new Set(text.match(/AC-\d+/g) || [])) if (!acs.includes(id)) warn('ac-unknown', 0, `${id} is not part of this milestone.`);

  return { errors, warnings, stats: { lines: raw.length, tasks: tasks.length } };
}

export const formatIssues = (list) => list.map((x) => `${x.line ? `line ${x.line}: ` : ''}${x.msg}`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...a] = process.argv.slice(2);
  if (!file) { console.log('usage: node planlint.mjs <plan.md> [--acs AC-1,AC-2] [--json]'); process.exit(2); }
  const ai = a.indexOf('--acs');
  const r = lintPlan(fs.readFileSync(file, 'utf8'), { acs: ai >= 0 ? a[ai + 1].split(',').filter(Boolean) : [] });
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else {
    for (const m of formatIssues(r.errors)) console.log(`error   ${m}`);
    for (const m of formatIssues(r.warnings)) console.log(`warning ${m}`);
    console.log(`${r.errors.length} error(s), ${r.warnings.length} warning(s), ${r.stats.tasks} task(s), ${r.stats.lines} line(s)`);
  }
  process.exit(r.errors.length ? 1 : 0);
}
