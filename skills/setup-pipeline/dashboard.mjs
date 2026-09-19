#!/usr/bin/env node
// One pipeline dashboard per machine, shared by every project and Claude session.
//   node dashboard.mjs --serve           start the server (spawned by ensureDashboard)
//   node dashboard.mjs --session-start   hook: register a Claude session (JSON on stdin)
//   node dashboard.mjs --session-end     hook: unregister it; stop the server when none are left
// State lives in ~/.claude-pipeline: runs/<id>.json (status), runs/<id>.events.jsonl, sessions/, dashboard.json.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOME = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
export const RUNS = path.join(HOME, 'runs');
const SESSIONS = path.join(HOME, 'sessions');
const INFO = path.join(HOME, 'dashboard.json');
const LOCK = path.join(HOME, 'dashboard.lock');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRST_PORT = 3120;
const ID = /^[\w.-]+$/;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

// Runner side: reuse the running dashboard or start one. Never throws; returns the URL or null.
export async function ensureDashboard() {
  try {
    fs.mkdirSync(RUNS, { recursive: true });
    const info = readJson(INFO);
    if (info && (await ping(info.port))) return `http://127.0.0.1:${info.port}`;
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
  try { files = fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJson(path.join(RUNS, f))).filter(Boolean).map((r) => {
    if (r.state === 'running' && !alive(r.pid)) r.state = 'stopped'; // runner killed mid-run
    return r;
  }).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')); // kept until the user deletes them
}

// Delete finished runs (never a running one). Returns the ids actually deleted.
function deleteRuns(ids) {
  const byId = new Map(listRuns().map((r) => [r.id, r]));
  return ids.filter((id) => ID.test(id) && byId.has(id) && byId.get(id).state !== 'running').map((id) => {
    for (const ext of ['.json', '.events.jsonl']) fs.rmSync(path.join(RUNS, id + ext), { force: true });
    return id;
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serve() {
  fs.mkdirSync(RUNS, { recursive: true });
  const page = fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8');
  const marked = fs.readFileSync(path.join(HERE, 'vendor', 'marked.min.js'), 'utf8'); // renders plan.md / review.md
  const server = http.createServer((req, res) => {
    // Loopback names only: blocks DNS-rebinding pages from reading run data or deleting runs.
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/') return send(res, 200, page, 'text/html');
    if (url.pathname === '/api/ping') return send(res, 200, { ok: true, pid: process.pid });
    if (url.pathname === '/vendor/marked.min.js') return send(res, 200, marked, 'text/javascript');
    if (req.method === 'DELETE') {
      // Only this page may delete: DELETE is never a "simple" cross-site request, and the Origin must be ours.
      const host = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== host) return send(res, 403, { error: 'forbidden' });
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
    if (url.pathname === '/api/runs') return send(res, 200, listRuns());
    if (p[0] === 'api' && p[1] === 'runs' && ID.test(p[2] || '')) {
      const run = listRuns().find((r) => r.id === p[2]);
      if (!run) return send(res, 404, { error: 'no such run' });
      if (p[3] === 'events') {
        const after = Number(url.searchParams.get('after')) || 0;
        let lines = [];
        try { lines = fs.readFileSync(path.join(RUNS, `${run.id}.events.jsonl`), 'utf8').split('\n').filter(Boolean); } catch {}
        return send(res, 200, { next: lines.length, events: lines.slice(after).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
      }
      if (p[3] === 'file' && ['plan', 'review', 'test-output'].includes(p[4])) {
        const f = path.join(run.cwd, '.pipeline', `${p[4]}.${p[4] === 'test-output' ? 'txt' : 'md'}`);
        try { return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain'); } catch { return send(res, 404, 'not written yet', 'text/plain'); }
      }
    }
    send(res, 404, { error: 'not found' });
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

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === '--serve') await serve();
  else if (cmd === '--launch') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
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
