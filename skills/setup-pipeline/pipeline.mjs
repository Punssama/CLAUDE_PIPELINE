#!/usr/bin/env node
// Plan (Opus) -> Build (Sonnet) -> [test gate -> Review (Sonnet, read-only)] x N -> Commit+push (Haiku, no edit).
// Usage: node pipeline.mjs .pipeline/config.json [--from plan|build|review|commit]   |   node pipeline.mjs --dashboard
// Exit: 0 done | 10 paused after plan | 1 error | 2 review still failing (nothing committed) | 3 plan misses milestone ACs
// Milestone mode (cfg.milestone = 'M2'): reads SPEC.md + ROADMAP.md at the repo root and gates the plan on the milestone's AC IDs.
// Every run is recorded in ~/.claude-pipeline/runs and shown live by the machine-wide dashboard (dashboard.mjs).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDashboard, RUNS } from './dashboard.mjs';

if (process.argv[2] === '--dashboard') { // just start/find the dashboard and print its link
  const u = await ensureDashboard();
  console.log(u ? `[pipeline] dashboard: ${u}` : '[pipeline] dashboard could not start');
  process.exit(u ? 0 : 1);
}
const [cfgPath, ...rest] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const fi = rest.indexOf('--from');
const from = fi >= 0 ? rest[fi + 1] : 'plan';
const ORDER = ['plan', 'build', 'review', 'commit'];
const D = '.pipeline';
const M = cfg.milestone;
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const WIN = process.platform === 'win32';

// ---- run record (status + event log) read by the dashboard -------------------------------
const root = git('rev-parse', '--show-toplevel').stdout.trim() || process.cwd();
const status = {
  id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
  project: path.basename(root), cwd: root, branch: cfg.branch, milestone: M || null,
  task: (cfg.task || '').slice(0, 300), from, pid: process.pid, state: 'running', exitCode: null, message: '',
  startedAt: new Date().toISOString(), updatedAt: null, currentStep: null, round: 0, totalCostUsd: 0,
  maxFixLoops: cfg.maxFixLoops ?? 2,
  steps: Object.fromEntries(ORDER.map((s) => [s, { state: 'pending', model: cfg.steps[s]?.model, budgetUsd: cfg.steps[s]?.budgetUsd ?? 3, costUsd: 0, runs: 0 }])),
  tests: [], reviews: [],
};
const STATUS = path.join(RUNS, `${status.id}.json`);
const EVENTS = path.join(RUNS, `${status.id}.events.jsonl`);
function save() {
  status.updatedAt = new Date().toISOString();
  try { fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(STATUS + '.tmp', JSON.stringify(status)); fs.renameSync(STATUS + '.tmp', STATUS); } catch {}
}
function event(e) { try { fs.appendFileSync(EVENTS, JSON.stringify({ t: Date.now(), ...e }) + '\n'); } catch {} }

const say = (m) => { console.log(`[pipeline] ${m}`); event({ kind: 'log', step: status.currentStep, text: m }); };
const die = (m, code = 1) => {
  status.state = code === 10 ? 'paused' : 'failed'; status.exitCode = code; status.message = m;
  if (status.currentStep && status.steps[status.currentStep].state === 'running') status.steps[status.currentStep].state = 'failed';
  save(); say(m); process.exit(code);
};

function milestoneACs() {
  if (!fs.existsSync('SPEC.md') || !fs.existsSync('ROADMAP.md')) die('milestone mode needs SPEC.md and ROADMAP.md at the repo root');
  const lines = fs.readFileSync('ROADMAP.md', 'utf8').split(/\r?\n/);
  const head = new RegExp(String.raw`^##\s*\[.\]\s*` + M + String.raw`\b`);
  const s = lines.findIndex((l) => head.test(l));
  if (s < 0) die(`${M} not found in ROADMAP.md (expected a heading like "## [ ] ${M} - title")`);
  const e = lines.findIndex((l, i) => i > s && /^##\s/.test(l));
  return [...new Set(lines.slice(s, e < 0 ? undefined : e).join('\n').match(/AC-\d+/g) || [])];
}
const ACS = M ? milestoneACs() : [];
status.acs = ACS;

// Windows headless sessions may expose PowerShell instead of Bash: allow both rule forms there.
const sh = (x) => !WIN ? x : x.split(',').flatMap((t) => t.startsWith('Bash') ? [t, t.replace('Bash', 'PowerShell')] : [t]).join(',');

// One-line summary of a tool call for the activity feed.
function brief(name, input = {}) {
  const v = String(input.file_path || input.path || input.command || input.pattern || input.skill || input.description || '')
    .split(root + '/').join('').split(root.replaceAll('/', '\\') + '\\').join('') // repo-relative paths read better
    .replace(/\s+/g, ' ').slice(0, 140);
  return `${name}${v ? ' ' + v : ''}`;
}

// Runs claude headless with stream-json so every tool call reaches the dashboard as it happens.
// Native installer gives claude(.exe); npm on Windows gives claude.cmd, which needs a shell.
function claude(step, args, input) {
  return new Promise((resolve) => {
    const start = (cmd, a, opts) => {
      const child = spawn(cmd, a, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '', raw = '', err = '', result = null;
      child.stdout.on('data', (d) => {
        raw += d; buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'assistant') {
            for (const c of e.message?.content || []) {
              if (c.type === 'tool_use') event({ kind: 'tool', step, text: brief(c.name, c.input) });
              else if (c.type === 'text' && c.text.trim()) event({ kind: 'text', step, text: c.text.trim().slice(0, 400) });
            }
          } else if (e.type === 'result') result = e;
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (e.code === 'ENOENT' && WIN && cmd === 'claude') return start('claude.cmd', a.map((x) => `"${x}"`), { shell: true });
        die(`cannot run claude: ${e.message}. Is Claude Code installed and on PATH?`);
      });
      child.on('close', (code) => resolve({ status: code, stdout: raw, stderr: err, result }));
      child.stdin.end(input);
    };
    start('claude', args, {});
  });
}

async function run(step, prompt, tools, allowed, disallowed = '') {
  const s = cfg.steps[step], st = status.steps[step];
  const skills = (s.skills?.length ? `\n\nUse these skills where they apply (invoke each with the Skill tool): ${s.skills.join(', ')}.` : '')
    + (cfg.guidance ? `\n\nGuidance: ${cfg.guidance}` : '');
  const args = ['-p', '--model', s.model, '--tools', sh(tools), '--allowedTools', sh(allowed),
    '--max-budget-usd', String(s.budgetUsd ?? 3), '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];
  if (disallowed) args.push('--disallowedTools', sh(disallowed));
  if (cfg.disablePlugins?.length) { // plugins the user opted out of: no hooks, no skills, no tokens
    fs.writeFileSync(`${D}/settings.json`, JSON.stringify({ enabledPlugins: Object.fromEntries(cfg.disablePlugins.map((p) => [p, false])) }));
    args.push('--settings', `${D}/settings.json`);
  }
  status.currentStep = step; st.state = 'running'; st.runs++; st.startedAt = new Date().toISOString(); save();
  say(`${step}: ${s.model} ...`);
  const t0 = Date.now();
  const r = await claude(step, args, prompt + skills);
  const cost = r.result?.total_cost_usd || 0;
  st.costUsd += cost; status.totalCostUsd += cost; st.endedAt = new Date().toISOString(); st.seconds = (st.seconds || 0) + Math.round((Date.now() - t0) / 1000);
  fs.mkdirSync(`${D}/logs`, { recursive: true });
  fs.writeFileSync(`${D}/logs/${step}-${Date.now()}.log`, (r.result?.result || '') + '\n--- stream ---\n' + r.stdout + '\n--- stderr ---\n' + r.stderr);
  const failed = r.status !== 0 || r.result?.is_error;
  st.state = failed ? 'failed' : 'done'; save();
  say(`${step}: exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s, $${cost.toFixed(3)}`);
  if (failed) die(`${step} failed. See ${D}/logs/. ${(r.result?.result || r.stderr || '').slice(-300)}`);
  return r.result?.result || '';
}

function testGate() {
  if (!cfg.testCmd) return true;
  const r = spawnSync(cfg.testCmd, { shell: true, encoding: 'utf8' });
  fs.writeFileSync(`${D}/test-output.txt`, (r.stdout || '') + (r.stderr || ''));
  status.tests.push({ round: status.round, pass: r.status === 0 }); save();
  say(`tests: ${r.status === 0 ? 'PASS' : 'FAIL'} (${cfg.testCmd})`);
  return r.status === 0;
}

async function build(fix) {
  const base = `Read ${D}/plan.md.`;
  const p = fix
    ? `${base} Then read ${D}/review.md and ${D}/test-output.txt. Fix ONLY the Critical review findings and failing tests. Do not expand scope. Do not commit or push.`
    : `${base}${M ? ` SPEC.md is the product spec; build only milestone ${M}.` : ''} Implement every task in it, tests first. If the project has no .gitignore covering generated files (caches, build output, dependencies), add one. Run the test command from the plan. Do not commit or push. Do not ask questions; state assumptions in your final message.`;
  await run('build', p, 'Read,Grep,Glob,Skill,Write,Edit,Bash', 'Read,Grep,Glob,Skill,Write,Edit,Bash',
    'Bash(git push:*),Bash(git commit:*),Bash(git reset:*),Bash(git checkout:*),Bash(git switch:*)');
}

async function review() {
  git('add', '-N', '.'); // make new files visible to `git diff`
  await run('review',
    `Review the uncommitted changes (git diff HEAD, git status) against ${D}/plan.md. You are READ-ONLY: never modify code; the only file you may write is ${D}/review.md.
Write ${D}/review.md with sections Critical / Important / Suggestion (each item: file:line, problem, fix suggestion). Critical = wrong behaviour, security hole, missing/failing tests, plan not met.${M ? `
Also check against SPEC.md: every acceptance criterion of milestone ${M} (${ACS.join(', ')}) must be met; an unmet one is Critical. Work belonging to later milestones is not required.` : ''}
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
  const critical = crit.filter((l) => /^\s*(?:[-*]|\d+\.)\s+(?!\W*none\b)\S/i.test(l));
  const pass = /^VERDICT:\s*PASS\s*$/m.test(txt) || (s >= 0 && !critical.length);
  status.reviews.push({ round: status.round, pass, critical: critical.map((l) => l.trim().slice(0, 200)).slice(0, 10) }); save();
  return pass;
}

// ---- main ---------------------------------------------------------------------------------
const idx = ORDER.indexOf(from);
if (idx < 0) die(`bad --from ${from}`);
ORDER.slice(0, idx).forEach((s) => { status.steps[s].state = 'skipped'; });
save();
const url = await ensureDashboard();
if (url) say(`dashboard: ${url}/#run=${status.id}`);

if (from === 'plan') {
  const ex = fs.readFileSync('.git/info/exclude', 'utf8');
  if (!ex.includes(`${D}/`)) fs.appendFileSync('.git/info/exclude', `\n${D}/\n`);
  if (git('status', '--porcelain').stdout.trim()) die('working tree not clean; commit or stash first');
  const cur = git('branch', '--show-current').stdout.trim();
  const b = git('switch', '-c', cfg.branch);
  if (b.status !== 0) die(`cannot create branch ${cfg.branch}: ${b.stderr.trim()}`);
  say(`branch ${cfg.branch} (from ${cur})`);
  fs.mkdirSync(D, { recursive: true });
  const planPrompt = (extra = '') => `${cfg.project ? `Project context:\n${cfg.project}\n\n` : ''}${M ? `Read SPEC.md (the product spec) and ROADMAP.md. Plan ONLY milestone ${M}; later milestones are out of scope.
Acceptance criteria for ${M}: ${ACS.join(', ')}. In Tasks, write each of these AC IDs next to the task(s) that satisfy it.\n\n` : ''}Task: ${cfg.task || `Implement milestone ${M} of ROADMAP.md.`}

Explore the repo, then write ${D}/plan.md — the ONLY file you may create. Sections: Goal, Non-goals, Assumptions, Tasks (each: files touched, acceptance criteria, how to verify), Test command${cfg.testCmd ? ` (use: ${cfg.testCmd})` : ''}.
You are non-interactive: do not ask questions, record assumptions instead. Keep it short and self-contained: a different model will implement it without seeing this conversation.${extra}`;
  const planTools = ['Read,Grep,Glob,Skill,Write', `Read,Grep,Glob,Skill,Edit(${D}/plan.md)`];
  await run('plan', planPrompt(), ...planTools);
  if (!fs.existsSync(`${D}/plan.md`)) die('plan step did not produce plan.md');
  // Completeness gate: every AC of the milestone must be mapped to a task (one retry).
  const missing = () => ACS.filter((a) => !new RegExp(a + String.raw`(?!\d)`).test(fs.readFileSync(`${D}/plan.md`, 'utf8')));
  if (missing().length) {
    say(`plan misses ${missing().join(', ')}; asking planner to complete it`);
    await run('plan', planPrompt(`\n\n${D}/plan.md already exists but does not cover ${missing().join(', ')}. Update it so every listed AC ID is mapped to a task.`), ...planTools);
    if (missing().length) die(`plan still does not cover ${missing().join(', ')}. See ${D}/plan.md`, 3);
  }
  say(`plan written: ${path.resolve(D, 'plan.md')}${ACS.length ? ` (covers ${ACS.join(', ')})` : ''}`);
  if (cfg.pauseAfterPlan) die(`paused. Review plan.md, then: node pipeline.mjs ${cfgPath} --from build`, 10);
}

const cur = git('branch', '--show-current').stdout.trim();
if (['main', 'master'].includes(cur)) die(`refusing to run on ${cur}`);

if (idx <= 1) await build(false);
let ok = idx === 3; // --from commit skips build/review
for (let i = 0; !ok && i <= status.maxFixLoops; i++) {
  status.round = i + 1; save();
  const t = testGate();
  const r = await review();
  say(`round ${i + 1}: tests ${t ? 'ok' : 'FAIL'}, review ${r ? 'PASS' : 'FAIL'}`);
  if (t && r) { ok = true; break; }
  if (i < status.maxFixLoops) await build(true);
}
if (!ok) die(`still failing after fix loops. Nothing committed. See ${D}/review.md and ${D}/test-output.txt`, 2);

const before = git('rev-parse', 'HEAD').stdout;
await run('commit',
  `Your job: create a git commit for the current changes, right now, without asking me anything. Run git status and git diff, stage the relevant files (never ${D}/, never caches), then commit with a Conventional Commit message that matches the diff. You have no file-editing tools: only inspect, stage, commit.
${cfg.push ? "After committing, push with: git push -u origin HEAD (if there is no remote, say so and skip). Never force-push. Never push main/master." : "Do NOT push."}`,
  'Read,Bash',
  'Read,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git add:*),Bash(git commit:*),Bash(git branch:*),Bash(git remote:*)' + (cfg.push ? ',Bash(git push:*)' : ''),
  'Bash(git push --force:*),Bash(git push -f:*),Bash(git push --force-with-lease:*)');
if (git('rev-parse', 'HEAD').stdout === before) die('commit step made no commit. See ' + D + '/logs/');
// review marks new files intent-to-add; clear what the committer left out so the tree can switch branches
git('reset', '-q');
const left = git('status', '--porcelain').stdout.trim();
if (left) say('warning: files left uncommitted (add them to .gitignore or commit them):\n' + left);
const last = git('log', '--oneline', '-1').stdout.trim();
status.state = 'done'; status.exitCode = 0; status.message = last; status.currentStep = null; save();
say(`done. ${last} ($${status.totalCostUsd.toFixed(3)} total)`);
