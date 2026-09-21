#!/usr/bin/env node
// One pipeline dashboard per machine, shared by every project and Claude session.
//   node dashboard.mjs --serve           start the server (spawned by ensureDashboard)
//   node dashboard.mjs --session-start   hook: register a Claude session (JSON on stdin)
//   node dashboard.mjs --docs-hook       hook (PostToolUse on Write/Edit): SPEC.md or ROADMAP.md was written -> show it in the dashboard, and give the user the link
//   node dashboard.mjs --session-end     hook: unregister it; stop the server when none are left
// State lives in ~/.claude-pipeline:
//   runs/<id>.json (status) + .events.jsonl + .plan.md/.review.md/.test-output.txt (per-run snapshots) + .plan.diff
//   projects/<id>.json (a project folder whose SPEC.md and ROADMAP.md the dashboard lists, before or without any run; see registerProject)
//   runs/<id>.decision.json (pending decision from the browser) -> .decision.consumed.json once a session picked it up
//   runs/<id>.waiting.json (a Claude session is waiting for that decision), sessions/, dashboard.json.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintPlan } from './planlint.mjs';

export const HOME = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
export const RUNS = path.join(HOME, 'runs');
const SESSIONS = path.join(HOME, 'sessions');
const PROJECTS = path.join(HOME, 'projects');
const DOCS = { spec: 'SPEC.md', roadmap: 'ROADMAP.md' }; // the only project files the dashboard ever serves
const INFO = path.join(HOME, 'dashboard.json');
const LOCK = path.join(HOME, 'dashboard.lock');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRST_PORT = 3120;
const ID = /^[\w-]+$/;          // run ids are timestamp-pid: no dots, so "<id>.<suffix>" files never collide with a record
const RECORD = /^[^.]+\.json$/;
const SUFFIXES = ['.json', '.events.jsonl', '.plan.md', '.review.md', '.test-output.txt', '.plan.diff', '.decision.json', '.decision.consumed.json', '.waiting.json'];
const FILES = { plan: ['plan.md', '.plan.md'], review: ['review.md', '.review.md'], 'test-output': ['test-output.txt', '.test-output.txt'] };
const MAX_PLAN = 512 * 1024;
// Identifies the code a server runs, so a dashboard left running by an older plugin version is replaced, not reused.
const BUILD = crypto.createHash('sha1').update(fs.readFileSync(path.join(HERE, 'dashboard.mjs'))).update(fs.readFileSync(path.join(HERE, 'dashboard.html'))).digest('hex').slice(0, 10);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A project is identified by its folder. Runs record it with forward slashes and git's spelling, other callers with the OS spelling,
// so the id hashes a normalised form (and ignores case on Windows).
export function projectId(cwd) {
  const p = path.resolve(cwd).replace(/\\/g, '/');
  return crypto.createHash('sha1').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 12);
}
// Remember a project folder so its SPEC.md and ROADMAP.md can be read in the dashboard before any run exists (for example
// right after /discover). Returns the project id, used in links as /#project=<id>.
export function registerProject(cwd) {
  const dir = path.resolve(cwd), id = projectId(dir);
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, `${id}.json`), JSON.stringify({ id, cwd: dir, name: path.basename(dir), at: new Date().toISOString() }));
  return id;
}

// Line diff between the plan the AI wrote (plan.orig.md) and the current plan.md; null when there is nothing to compare.
export function planDiff(dir) {
  const a = path.join(dir, '.pipeline', 'plan.orig.md'), b = path.join(dir, '.pipeline', 'plan.md');
  if (!fs.existsSync(a) || !fs.existsSync(b)) return null;
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U2', '--', a, b], { encoding: 'utf8' });
  if (r.error) return null;
  const i = r.stdout.indexOf('@@'); // skip the file headers (they hold absolute paths)
  return i < 0 ? '' : r.stdout.slice(i);
}

async function ping(port) { // the server's { ok, pid, build }, or null when nothing answers
  try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// Runner side: reuse the running dashboard or start one. Never throws; returns the URL or null.
export async function ensureDashboard() {
  try {
    fs.mkdirSync(RUNS, { recursive: true });
    const info = readJson(INFO);
    const up = info && (await ping(info.port));
    if (up?.build === BUILD) return `http://127.0.0.1:${info.port}`;
    if (up) { try { process.kill(up.pid); } catch { /* already gone */ } fs.rmSync(INFO, { force: true }); } // an older version is still running: replace it
    let mine = false;
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); mine = true; } catch {
      // ponytail: time-based stale lock (10s); a crashed starter only delays the next one
      if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) { fs.rmSync(LOCK, { force: true }); return ensureDashboard(); }
    }
    if (mine) {
      fs.rmSync(INFO, { force: true });
      // via a short-lived launcher, so killing the runner's process tree does not take the dashboard with it
      spawn(process.execPath, [path.join(HERE, 'dashboard.mjs'), '--launch'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const now = readJson(INFO);
      if (now && (await ping(now.port))) { if (mine) fs.rmSync(LOCK, { force: true }); return `http://127.0.0.1:${now.port}`; }
    }
    if (mine) fs.rmSync(LOCK, { force: true });
  } catch { /* the dashboard is optional: the pipeline runs without it */ }
  return null;
}

// Try FIRST_PORT, FIRST_PORT+1, ... ; fall back to an OS-assigned port.
function listenFree(server, port = FIRST_PORT) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.off('listening', onOk);
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') return reject(e);
      resolve(listenFree(server, port === 0 ? 0 : port - FIRST_PORT >= 100 ? 0 : port + 1));
    };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr).once('listening', onOk).listen(port, '127.0.0.1');
  });
}

function listRuns() {
  let files = [];
  try { files = fs.readdirSync(RUNS).filter((f) => RECORD.test(f)); } catch { return []; }
  const runs = files.map((f) => readJson(path.join(RUNS, f))).filter(Boolean).map((r) => {
    if (r.state === 'running' && !alive(r.pid)) r.state = 'stopped'; // runner killed mid-run
    return r;
  }).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')); // kept until the user deletes them
  const newest = new Map(); // project -> its newest run: only that one's plan is the plan on disk
  for (const r of runs) if (!newest.has(r.cwd)) newest.set(r.cwd, r.id);
  for (const r of runs) {
    if (r.state !== 'paused') continue;
    const w = readJson(path.join(RUNS, `${r.id}.waiting.json`));
    r.editable = newest.get(r.cwd) === r.id;
    r.waiting = !!(w && alive(w.pid));                                   // a Claude session is waiting for the decision
    r.decision = readJson(path.join(RUNS, `${r.id}.decision.json`));     // sent from the browser, not yet picked up
    r.lastDecision = readJson(path.join(RUNS, `${r.id}.decision.consumed.json`));
    if (r.cfg) r.resumeCmd = `node "${path.join(HERE, 'pipeline.mjs')}" "${r.cfg}" --from build`;
  }
  return runs;
}

// Registered projects plus every project that has runs; only those with a SPEC.md or ROADMAP.md on disk are listed.
function listProjects() {
  const byId = new Map();
  let files = []; try { files = fs.readdirSync(PROJECTS); } catch { /* none registered yet */ }
  for (const f of files) { const j = readJson(path.join(PROJECTS, f)); if (j?.cwd && j.id === projectId(j.cwd)) byId.set(j.id, j); }
  for (const r of listRuns()) if (!byId.has(projectId(r.cwd))) byId.set(projectId(r.cwd), { id: projectId(r.cwd), cwd: r.cwd, name: r.project });
  return [...byId.values()].map((p) => ({ id: p.id, name: p.name, cwd: p.cwd, at: p.at, docs: Object.fromEntries(Object.entries(DOCS).map(([k, f]) => [k, fs.existsSync(path.join(p.cwd, f))])) }))
    .filter((p) => Object.values(p.docs).some(Boolean));
}

// Delete finished runs (never a running one). Returns the ids actually deleted.
function deleteRuns(ids) {
  const byId = new Map(listRuns().map((r) => [r.id, r]));
  return ids.filter((id) => ID.test(id) && byId.has(id) && byId.get(id).state !== 'running').map((id) => {
    for (const ext of SUFFIXES) fs.rmSync(path.join(RUNS, id + ext), { force: true });
    return id;
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Request body as text. Oversized bodies are drained (not stored) and rejected, so the 413 can still be sent.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => (n > limit ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Anything that changes state must come from this page itself, never from another site or a rebinding hostname.
const sameOrigin = (req) => {
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
};

async function serve() {
  fs.mkdirSync(RUNS, { recursive: true });
  const page = fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8');
  const marked = fs.readFileSync(path.join(HERE, 'vendor', 'marked.min.js'), 'utf8'); // renders plan.md / review.md

  async function handle(req, res) {
    // Loopback names only: blocks DNS-rebinding pages from reading run data or changing anything.
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !sameOrigin(req)) return send(res, 403, { error: 'forbidden' });

    if (url.pathname === '/') return send(res, 200, page, 'text/html');
    if (url.pathname === '/api/ping') return send(res, 200, { ok: true, pid: process.pid, build: BUILD });
    if (url.pathname === '/vendor/marked.min.js') return send(res, 200, marked, 'text/javascript');

    if (req.method === 'DELETE') {
      if (p[0] === 'api' && p[1] === 'runs' && ID.test(p[2] || '') && !p[3]) {
        const done = deleteRuns([p[2]]);
        return send(res, done.length ? 200 : 409, done.length ? { deleted: done } : { error: 'not found or still running' });
      }
      if (url.pathname === '/api/runs') { // ?cwd=<project path>: every finished run of that project
        const cwd = url.searchParams.get('cwd');
        if (!cwd) return send(res, 400, { error: 'cwd required' });
        return send(res, 200, { deleted: deleteRuns(listRuns().filter((r) => r.cwd === cwd).map((r) => r.id)) });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (url.pathname === '/api/runs' && !write) return send(res, 200, listRuns());
    if (url.pathname === '/api/projects' && !write) return send(res, 200, listProjects());
    if (p[0] === 'api' && p[1] === 'projects' && p[3] === 'file' && Object.hasOwn(DOCS, p[4] || '') && !write) { // a known project, and only its SPEC.md or ROADMAP.md
      const proj = ID.test(p[2] || '') ? listProjects().find((x) => x.id === p[2]) : null;
      const text = proj ? readText(path.join(proj.cwd, DOCS[p[4]]))?.slice(0, MAX_PLAN) : null;
      return text == null ? send(res, 404, 'not written yet', 'text/plain') : send(res, 200, text, 'text/plain');
    }
    if (p[0] !== 'api' || p[1] !== 'runs' || !ID.test(p[2] || '')) return send(res, 404, { error: 'not found' });
    const run = listRuns().find((r) => r.id === p[2]);
    if (!run) return send(res, 404, { error: 'no such run' });
    const planFile = path.join(run.cwd, '.pipeline', 'plan.md');

    if (!write && p[3] === 'events') {
      const after = Number(url.searchParams.get('after')) || 0;
      let lines = [];
      try { lines = fs.readFileSync(path.join(RUNS, `${run.id}.events.jsonl`), 'utf8').split('\n').filter(Boolean); } catch {}
      return send(res, 200, { next: lines.length, events: lines.slice(after).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
    }

    if (p[3] === 'file' && FILES[p[4]]) {
      const [live, ext] = FILES[p[4]];
      if (!write) {
        // Runs with snapshots show their own files (a later run overwrites .pipeline/); only a paused plan is read live, because it can be edited.
        const useLive = !run.snap || (p[4] === 'plan' && run.state === 'paused');
        const text = readText(useLive ? path.join(run.cwd, '.pipeline', live) : path.join(RUNS, run.id + ext));
        return text == null ? send(res, 404, 'not written yet', 'text/plain') : send(res, 200, text, 'text/plain');
      }
      if (req.method === 'PUT' && p[4] === 'plan') {
        if (run.state !== 'paused' || !run.editable) return send(res, 409, { error: 'only the newest plan that is waiting for review can be edited' });
        const text = await readBody(req, MAX_PLAN);
        if (!text.trim()) return send(res, 400, { error: 'the plan cannot be empty' });
        fs.writeFileSync(planFile + '.tmp', text);
        fs.renameSync(planFile + '.tmp', planFile);
        const lint = lintPlan(text, { acs: run.acs });
        const rec = readJson(path.join(RUNS, `${run.id}.json`)); // keep the banner's "N problems" in step with what was just saved
        if (rec) { rec.planLint = { errors: lint.errors.length, warnings: lint.warnings.length }; fs.writeFileSync(path.join(RUNS, `${run.id}.json.tmp`), JSON.stringify(rec)); fs.renameSync(path.join(RUNS, `${run.id}.json.tmp`), path.join(RUNS, `${run.id}.json`)); }
        return send(res, 200, { ok: true, bytes: Buffer.byteLength(text), lint });
      }
    }

    if (req.method === 'POST' && p[3] === 'lint') { // plan lint of the text in the editor (not saved)
      return send(res, 200, lintPlan(await readBody(req, MAX_PLAN), { acs: run.acs }));
    }

    if (!write && p[3] === 'plandiff') {
      const diff = run.state === 'paused' ? planDiff(run.cwd) : readText(path.join(RUNS, `${run.id}.plan.diff`));
      return send(res, 200, { diff });
    }

    if (req.method === 'POST' && p[3] === 'decision') {
      if (run.state !== 'paused' || !run.editable) return send(res, 409, { error: 'this plan is no longer waiting for a decision' });
      let d; try { d = JSON.parse(await readBody(req, 16 * 1024)); } catch { return send(res, 400, { error: 'bad json' }); }
      const note = String(d.note ?? '').trim().slice(0, 4000);
      if (!['approve', 'revise', 'cancel'].includes(d.action)) return send(res, 400, { error: 'action must be approve, revise or cancel' });
      if (d.action === 'revise' && !note) return send(res, 400, { error: 'describe the changes you want' });
      const orig = readText(path.join(run.cwd, '.pipeline', 'plan.orig.md')), now = readText(planFile);
      const decision = { action: d.action, note, at: new Date().toISOString(), by: 'dashboard', planChanged: orig != null && now != null && orig !== now };
      fs.writeFileSync(path.join(RUNS, `${run.id}.decision.json`), JSON.stringify(decision));
      return send(res, 200, { ok: true, decision, waiting: !!listRuns().find((r) => r.id === run.id)?.waiting });
    }

    send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      send(res, e.message === 'too large' ? 413 : 500, { error: e.message === 'too large' ? 'too large' : 'server error' });
    });
  });
  const port = await listenFree(server);
  fs.writeFileSync(INFO, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));
  // Also stop by itself once no Claude session is registered and nothing is running (covers crashed sessions' hooks).
  setInterval(() => {
    const sessions = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).length : 0;
    if (!sessions && !listRuns().some((r) => r.state === 'running')) process.exit(0);
  }, 60000).unref();
}

function stopServer() {
  const info = readJson(INFO);
  if (info?.pid && alive(info.pid)) { try { process.kill(info.pid); } catch {} }
  fs.rmSync(INFO, { force: true });
}

// PostToolUse hook: whenever SPEC.md or ROADMAP.md is written (by /discover, /setup-pipeline, /toolkit or by hand), register its folder so an
// open dashboard shows it live, and once both files exist tell the user the link: once per project, dashboard and session. This is a hook, not
// a line in a skill, so it does not depend on the model remembering to do it.
async function docsHook() {
  const e = readStdin(), f = e.tool_input?.file_path;
  if (process.env.CLAUDE_PIPELINE_HEADLESS || !f || !/^(SPEC|ROADMAP)\.md$/.test(path.basename(f))) return;
  const dir = path.dirname(path.resolve(f)), id = registerProject(dir);
  const url = await ensureDashboard();
  if (!url || !Object.values(DOCS).every((d) => fs.existsSync(path.join(dir, d)))) return;
  const file = path.join(HOME, 'announced.json'), key = `${id}:${e.session_id || ''}`, seen = readJson(file) || {};
  if (seen[key] === url) return;
  // ponytail: keeps the last 50 announcements; older ones simply get announced again
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...Object.entries(seen), [key, url]].slice(-50))));
  const link = `${url}/#project=${id}`;
  console.log(JSON.stringify({ systemMessage: `SPEC.md and ROADMAP.md are ready. Read them rendered (they update live): ${link}`,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `The pipeline dashboard now shows SPEC.md and ROADMAP.md and updates live: ${link}. Give the user this link in one line.` } }));
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === '--serve') await serve();
  else if (cmd === '--launch') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  else if (cmd === '--docs-hook') { try { await docsHook(); } catch { /* a hook must never fail */ } }
  else if (cmd === '--session-start' || cmd === '--session-end') {
    // Hooks must never fail or print: Claude Code would surface it.
    try {
      const id = String(readStdin().session_id || '').replace(/[^\w-]/g, '');
      if (id) {
        fs.mkdirSync(SESSIONS, { recursive: true });
        const f = path.join(SESSIONS, id);
        if (cmd === '--session-start') {
          fs.writeFileSync(f, new Date().toISOString());
          // ponytail: sessions that crashed without SessionEnd expire after 7 days
          for (const s of fs.readdirSync(SESSIONS)) {
            if (Date.now() - fs.statSync(path.join(SESSIONS, s)).mtimeMs > 7 * 864e5) fs.rmSync(path.join(SESSIONS, s), { force: true });
          }
        } else {
          fs.rmSync(f, { force: true });
          if (!fs.readdirSync(SESSIONS).length) stopServer();
        }
      }
    } catch {}
  }
}
