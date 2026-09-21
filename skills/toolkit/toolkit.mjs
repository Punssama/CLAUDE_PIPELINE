#!/usr/bin/env node
// Companion-plugin helper behind /toolkit. Only plugins listed in catalog.json can ever be installed.
//   node toolkit.mjs --status [--tokens]        JSON: environment, what is installed, unmet requirements, presets
//   node toolkit.mjs --detect [dir]             JSON: stacks found in the folder + catalog plugins that fit them, most useful first, with installed: true/false
//   node toolkit.mjs --suggest                  SessionStart hook: once per project and plugin, a notice of the plugins that fit this project and are not installed
//   node toolkit.mjs --projects                 JSON: the project folders this plugin knows, newest first
//   node toolkit.mjs --clean-plan <dir>         JSON: what to remove (only for that project) and what to keep (shared); nothing is changed
//   node toolkit.mjs --clean-apply <dir> ids    uninstall those ids, but only ones the clean plan lists
//   node toolkit.mjs --abandon <dir>            mark the project abandoned: it stops counting as a user and leaves the dashboard's Documents list
//   node toolkit.mjs --install id[,id...] [--project dir]   (with --project, service plugins are installed for that folder only)       marketplace add + install for each catalog id; JSON result per plugin
//   node toolkit.mjs --record <preset> [ids]    remember the choice (preset: recommended | full | custom | skip)
//   node toolkit.mjs --nudge                    SessionStart hook: a one-time "run /toolkit" hint for the user
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchingPlugins, suggestionNotice, installedIds, noteSeen } from './suggest.mjs';
import { cleanPlan, cleanApply, projectList, abandon } from './clean.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
const CHOICE = path.join(HOME, 'toolkit.json');   // written once the user has chosen (or skipped)
const NUDGED = path.join(HOME, 'toolkit.nudged'); // written after the one-time hint
const catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'catalog.json'), 'utf8'));
const WIN = process.platform === 'win32';
const out = (o) => console.log(JSON.stringify(o));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Some marketplaces declare their plugins with git@github.com: (SSH) URLs, which fail on a machine without a GitHub SSH key.
// Rewrite them to HTTPS for the child process only (git reads these env vars); nobody's git config is touched.
const HTTPS_ENV = { ...process.env, GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'ssh://git@github.com/' };
const CLAUDE = process.env.CLAUDE_PIPELINE_CLAUDE ? JSON.parse(process.env.CLAUDE_PIPELINE_CLAUDE) : ['claude']; // the tests swap in a fake
function claude(args, cwd) {
  const o = { encoding: 'utf8', timeout: 300000, env: HTTPS_ENV, cwd };
  let r = spawnSync(CLAUDE[0], [...CLAUDE.slice(1), ...args], o);
  if (r.error?.code === 'ENOENT' && WIN) r = spawnSync('claude.cmd', args.map((a) => `"${a}"`), { ...o, shell: true }); // npm install on Windows
  return r;
}
const installedPlugins = () => {
  const r = claude(['plugin', 'list', '--json']);
  try { return new Map(JSON.parse(r.stdout || '[]').map((p) => [p.id, p])); } catch { return new Map(); }
};
const nodeOk = (req) => {
  const m = /^>=(\d+)(?:\.(\d+))?/.exec(req || '');
  const [maj, min] = process.versions.node.split('.').map(Number);
  return !m || maj > +m[1] || (maj === +m[1] && min >= +(m[2] || 0));
};
const unmetOf = (e) => (e.requires?.node && !nodeOk(e.requires.node) ? [`needs Node ${e.requires.node} (this machine has ${process.versions.node})`] : []);
const looseInstalled = (e) => !!e.looseSkill && fs.existsSync(path.join(os.homedir(), '.claude', 'skills', e.looseSkill));

// "Always-on: ~1,425 tok" / "~3.2k tok" from `claude plugin details`.
function alwaysOn(id) {
  const m = /Always-on:\s+~?([\d.,]+)\s*(k?)\s*tok/i.exec(claude(['plugin', 'details', id]).stdout || '');
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)) : null;
}

function status(withTokens) {
  const have = installedPlugins();
  const plugins = catalog.plugins.map((e) => {
    const p = have.get(e.plugin), loose = !p && looseInstalled(e);
    const item = {
      id: e.id, plugin: e.plugin, title: e.title, kind: e.kind, license: e.license, does: e.does, forPipeline: e.forPipeline,
      headless: e.headless, presets: e.presets, conflicts: e.conflicts || [], notes: e.notes || [], setup: e.setup || [],
      alwaysOnTokens: e.alwaysOnTokens, measured: e.measured,
      installed: !!p || loose, installedAs: p ? 'plugin' : loose ? 'loose skills' : null, enabled: p ? p.enabled : null, version: p?.version ?? null,
      unmet: unmetOf(e),
    };
    if (withTokens && p && !e.detailsUndercounts) { const t = alwaysOn(e.plugin); if (t != null) Object.assign(item, { alwaysOnTokens: t, measured: true }); }
    return item;
  });
  const sum = (ids) => plugins.filter((p) => ids.includes(p.id)).reduce((a, p) => a + (p.alwaysOnTokens || 0), 0);
  const presets = Object.fromEntries(Object.keys(catalog.presets).map((k) => {
    const ids = plugins.filter((p) => p.presets.includes(k) && !p.unmet.length).map((p) => p.id);
    return [k, { about: catalog.presets[k], ids, alwaysOnTokens: sum(ids), skipped: plugins.filter((p) => p.presets.includes(k) && p.unmet.length).map((p) => `${p.id}: ${p.unmet[0]}`) }];
  }));
  return { env: { node: process.versions.node, platform: process.platform }, chosen: readJson(CHOICE), presets, plugins };
}

// Scan a folder and match its stacks to catalog plugins (`stacks` field). Suggest-only: nothing is installed here.
function detect(dir) {
  const { stacks, fits } = matchingPlugins(path.resolve(dir || '.'));
  const have = installedIds(path.resolve(dir || '.')); // active here: installed for every project, or for this one
  const suggestions = fits.map((e) => ({ id: e.id, title: e.title, does: e.does, license: e.license, headless: e.headless, notes: e.notes || [], unmet: unmetOf(e),
    tokens: e.alwaysOnTokens, tokensAreLowerBound: !!e.detailsUndercounts, because: e.because, installed: have.has(e.plugin) || looseInstalled(e), scope: e.installScope === 'project' ? 'this project only' : 'all projects' }));
  return { stacks, suggestions };
}

// project: the folder the plugins are for. Service and platform plugins (installScope "project") are then installed for that folder only
// (scope local: .claude/settings.local.json, which git ignores, so the working tree stays clean); everything else is installed for all projects.
function install(ids, project) {
  const results = [];
  for (const id of ids) {
    const e = catalog.plugins.find((x) => x.id === id);
    if (!e) { results.push({ id, ok: false, message: 'not in the catalog' }); continue; }
    if (unmetOf(e).length) { results.push({ id, ok: false, message: unmetOf(e)[0] }); continue; }
    const tail = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 240);
    const add = claude(['plugin', 'marketplace', 'add', e.marketplace]);
    if (add.status !== 0 && !/already/i.test(`${add.stdout}${add.stderr}`)) { results.push({ id, ok: false, step: 'marketplace add', message: tail(add) }); continue; }
    const local = project && e.installScope === 'project';
    const ins = claude(['plugin', 'install', e.plugin, ...(local ? ['--scope', 'local'] : [])], local ? path.resolve(project) : undefined);
    const ok = ins.status === 0 || /already installed/i.test(`${ins.stdout}${ins.stderr}`);
    results.push({ id, ok, step: 'install', scope: local ? 'this project only' : 'all projects', message: tail(ins), setup: ok ? e.setup || [] : [] });
  }
  const have = installedPlugins();
  for (const r of results) if (r.ok) r.verified = have.has(catalog.plugins.find((x) => x.id === r.id).plugin);
  return results;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === '--status') out(status(args.includes('--tokens')));
else if (cmd === '--detect') out(detect(args[0]));
else if (cmd === '--install') out(install((args[0] || '').split(',').map((s) => s.trim()).filter(Boolean), args.includes('--project') ? args[args.indexOf('--project') + 1] : undefined));
else if (cmd === '--projects') out(projectList());
else if (cmd === '--clean-plan') out(cleanPlan(args[0] || '.'));
else if (cmd === '--clean-apply') out(cleanApply(args[0], (args[1] || '').split(',').map((s) => s.trim()).filter(Boolean), claude));
else if (cmd === '--abandon') out(await abandon(args[0]));
else if (cmd === '--record') {
  fs.mkdirSync(HOME, { recursive: true });
  const preset = args[0] || 'custom';
  fs.writeFileSync(CHOICE, JSON.stringify({ setupAt: new Date().toISOString(), preset, chosen: (args[1] || '').split(',').filter(Boolean) }));
  out({ ok: true });
} else if (cmd === '--suggest') {
  // SessionStart hook. Must never fail or be noisy: silent in headless pipeline steps, in the home folder, outside a project and when nothing is new.
  try {
    if (process.env.CLAUDE_PIPELINE_HEADLESS) process.exit(0);
    const cwd = path.resolve(JSON.parse(fs.readFileSync(0, 'utf8') || '{}').cwd || process.cwd());
    if (cwd === os.homedir() || cwd === path.parse(cwd).root) process.exit(0);
    noteSeen(cwd);
    const text = suggestionNotice(cwd);
    if (text) out({ systemMessage: `claude-pipeline: ${text}` });
  } catch { /* stay silent */ }
} else if (cmd === '--nudge') {
  // Must never fail or be noisy: it runs at every session start. Silent for headless pipeline steps and once the user has chosen.
  try {
    if (process.env.CLAUDE_PIPELINE_HEADLESS || fs.existsSync(CHOICE) || fs.existsSync(NUDGED)) process.exit(0);
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(NUDGED, new Date().toISOString());
    out({ systemMessage: 'claude-pipeline is installed. Optional: type /toolkit to choose companion plugins (about a minute: recommended set, everything, or pick), or /discover to start a project.' });
  } catch { /* stay silent */ }
} else {
  console.error('usage: toolkit.mjs --status [--tokens] | --detect [dir] | --suggest | --install id[,id] [--project dir] | --projects | --clean-plan dir | --clean-apply dir id[,id] | --abandon dir | --record <preset> [ids] | --nudge');
  process.exit(1);
}
