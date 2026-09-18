#!/usr/bin/env node
// Plan (Opus) -> Build (Sonnet) -> [test gate -> Review (Sonnet, read-only)] x N -> Commit+push (Haiku, no edit).
// Usage: node pipeline.mjs .pipeline/config.json [--from plan|build|review|commit]
// Exit: 0 done | 10 paused after plan | 1 error | 2 review still failing (nothing committed)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [cfgPath, ...rest] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const fi = rest.indexOf('--from');
const from = fi >= 0 ? rest[fi + 1] : 'plan';
const ORDER = ['plan', 'build', 'review', 'commit'];
const D = '.pipeline';
const say = (m) => console.log(`[pipeline] ${m}`);
const die = (m, code = 1) => { say(m); process.exit(code); };
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const WIN = process.platform === 'win32';
// Windows headless sessions may expose PowerShell instead of Bash: allow both rule forms there.
const sh = (x) => !WIN ? x : x.split(',').flatMap((t) => t.startsWith('Bash') ? [t, t.replace('Bash', 'PowerShell')] : [t]).join(',');
// Native installer gives claude(.exe); npm on Windows gives claude.cmd, which needs a shell.
function claude(args, input) {
  const o = { input, encoding: 'utf8', maxBuffer: 1 << 26 };
  let r = spawnSync('claude', args, o);
  if (r.error?.code === 'ENOENT' && WIN) r = spawnSync('claude.cmd', args.map((a) => `"${a}"`), { ...o, shell: true });
  if (r.error) die(`cannot run claude: ${r.error.message}. Is Claude Code installed and on PATH?`);
  return r;
}

function run(step, prompt, tools, allowed, disallowed = '') {
  const s = cfg.steps[step];
  const skills = s.skills?.length ? `\n\nUse these skills where they apply (invoke each with the Skill tool): ${s.skills.join(', ')}.` : '';
  const args = ['-p', '--model', s.model, '--tools', sh(tools), '--allowedTools', sh(allowed),
    '--max-budget-usd', String(s.budgetUsd ?? 3), '--no-session-persistence'];
  if (disallowed) args.push('--disallowedTools', sh(disallowed));
  say(`${step}: ${s.model} ...`);
  const t0 = Date.now();
  const r = claude(args, prompt + skills);
  fs.mkdirSync(`${D}/logs`, { recursive: true });
  fs.writeFileSync(`${D}/logs/${step}-${Date.now()}.log`, (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
  say(`${step}: exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (r.status !== 0) die(`${step} failed. See ${D}/logs/. ${(r.stderr || '').slice(-300)}`);
  return r.stdout;
}

function testGate() {
  if (!cfg.testCmd) return true;
  const r = spawnSync(cfg.testCmd, { shell: true, encoding: 'utf8' });
  fs.writeFileSync(`${D}/test-output.txt`, (r.stdout || '') + (r.stderr || ''));
  say(`tests: ${r.status === 0 ? 'PASS' : 'FAIL'} (${cfg.testCmd})`);
  return r.status === 0;
}

function build(fix) {
  const base = `Read ${D}/plan.md.`;
  const p = fix
    ? `${base} Then read ${D}/review.md and ${D}/test-output.txt. Fix ONLY the Critical review findings and failing tests. Do not expand scope. Do not commit or push.`
    : `${base} Implement every task in it, tests first. Run the test command from the plan. Do not commit or push. Do not ask questions; state assumptions in your final message.`;
  run('build', p, 'Read,Grep,Glob,Skill,Write,Edit,Bash', 'Read,Grep,Glob,Skill,Write,Edit,Bash',
    'Bash(git push:*),Bash(git commit:*),Bash(git reset:*),Bash(git checkout:*),Bash(git switch:*)');
}

function review() {
  git('add', '-N', '.'); // make new files visible to `git diff`
  run('review',
    `Review the uncommitted changes (git diff HEAD, git status) against ${D}/plan.md. You are READ-ONLY: never modify code; the only file you may write is ${D}/review.md.
Write ${D}/review.md with sections Critical / Important / Suggestion (each item: file:line, problem, fix suggestion). Critical = wrong behaviour, security hole, missing/failing tests, plan not met.
Ignore generated artifacts (caches, build output). Important/Suggestion items NEVER cause a FAIL.
The LAST line must be exactly "VERDICT: PASS" (zero Critical items) or "VERDICT: FAIL" (at least one Critical item).`,
    'Read,Grep,Glob,Skill,Write,Bash',
    `Read,Grep,Glob,Skill,Edit(${D}/review.md),Bash(git diff:*),Bash(git status:*),Bash(git log:*)`);
  const txt = fs.existsSync(`${D}/review.md`) ? fs.readFileSync(`${D}/review.md`, 'utf8') : '';
  // Pass if the model says PASS, or if its Critical section lists nothing (guards against a nitpicky FAIL).
  const lines = txt.split('\n');
  const s = lines.findIndex((l) => /^##\s*Critical/i.test(l));
  const e = lines.findIndex((l, i) => i > s && /^##\s/.test(l));
  const crit = s < 0 ? [] : lines.slice(s + 1, e < 0 ? undefined : e);
  const noCritical = s >= 0 && !crit.some((l) => /^\s*(?:[-*]|\d+\.)\s+(?!\W*none\b)\S/i.test(l));
  return /^VERDICT:\s*PASS\s*$/m.test(txt) || noCritical;
}

const idx = ORDER.indexOf(from);
if (idx < 0) die(`bad --from ${from}`);

if (from === 'plan') {
  const ex = fs.readFileSync('.git/info/exclude', 'utf8');
  if (!ex.includes(`${D}/`)) fs.appendFileSync('.git/info/exclude', `\n${D}/\n`);
  if (git('status', '--porcelain').stdout.trim()) die('working tree not clean; commit or stash first');
  const cur = git('branch', '--show-current').stdout.trim();
  fs.appendFileSync('.git/info/exclude', `\n${D}/\n`);
  const b = git('switch', '-c', cfg.branch);
  if (b.status !== 0) die(`cannot create branch ${cfg.branch}: ${b.stderr.trim()}`);
  say(`branch ${cfg.branch} (from ${cur})`);
  fs.mkdirSync(D, { recursive: true });
  run('plan',
    `Task: ${cfg.task}

Explore the repo, then write ${D}/plan.md — the ONLY file you may create. Sections: Goal, Non-goals, Assumptions, Tasks (each: files touched, acceptance criteria, how to verify), Test command${cfg.testCmd ? ` (use: ${cfg.testCmd})` : ''}.
You are non-interactive: do not ask questions, record assumptions instead. Keep it short and self-contained: a different model will implement it without seeing this conversation.`,
    'Read,Grep,Glob,Skill,Write', `Read,Grep,Glob,Skill,Edit(${D}/plan.md)`);
  if (!fs.existsSync(`${D}/plan.md`)) die('plan step did not produce plan.md');
  say(`plan written: ${path.resolve(D, 'plan.md')}`);
  if (cfg.pauseAfterPlan) die(`paused. Review plan.md, then: node pipeline.mjs ${cfgPath} --from build`, 10);
}

const cur = git('branch', '--show-current').stdout.trim();
if (['main', 'master'].includes(cur)) die(`refusing to run on ${cur}`);

if (idx <= 1) build(false);
let ok = idx === 3; // --from commit skips build/review
for (let i = 0; !ok && i <= (cfg.maxFixLoops ?? 2); i++) {
  const t = testGate();
  const r = review();
  say(`round ${i + 1}: tests ${t ? 'ok' : 'FAIL'}, review ${r ? 'PASS' : 'FAIL'}`);
  if (t && r) { ok = true; break; }
  if (i < (cfg.maxFixLoops ?? 2)) build(true);
}
if (!ok) die(`still failing after fix loops. Nothing committed. See ${D}/review.md and ${D}/test-output.txt`, 2);

const before = git('rev-parse', 'HEAD').stdout;
run('commit',
  `Your job: create a git commit for the current changes, right now, without asking me anything. Run git status and git diff, stage the relevant files (never ${D}/, never caches), then commit with a Conventional Commit message that matches the diff. You have no file-editing tools: only inspect, stage, commit.
${cfg.push ? "After committing, push with: git push -u origin HEAD (if there is no remote, say so and skip). Never force-push. Never push main/master." : "Do NOT push."}`,
  'Read,Bash',
  'Read,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git add:*),Bash(git commit:*),Bash(git branch:*),Bash(git remote:*)' + (cfg.push ? ',Bash(git push:*)' : ''),
  'Bash(git push --force:*),Bash(git push -f:*),Bash(git push --force-with-lease:*)');
if (git('rev-parse', 'HEAD').stdout === before) die('commit step made no commit. See ' + D + '/logs/');
say('done. ' + git('log', '--oneline', '-1').stdout.trim());
