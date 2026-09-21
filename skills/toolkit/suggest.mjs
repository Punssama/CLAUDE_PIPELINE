// What fits a folder's stack, what is installed for it, and which projects this plugin has seen. Shared by /toolkit (--detect, --clean-plan), the
// SessionStart hint (--suggest) and the SPEC/ROADMAP hook of the dashboard. Fast on purpose: no `claude` process, everything is read from
// installed_plugins.json (which records, per install, its scope and for a project install the folder it belongs to).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStacks } from './detect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_HOME = process.env.CLAUDE_PIPELINE_HOME || path.join(os.homedir(), '.claude-pipeline');
const SEEN = path.join(PIPELINE_HOME, 'seen.json');               // project folder -> when a session last started in it
const ABANDONED = path.join(PIPELINE_HOME, 'abandoned.json');     // folders the user gave up on (see clean.mjs)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
export const catalog = readJson(path.join(HERE, 'catalog.json'));

// One spelling per folder (git says D:/x, Windows says D:\x), case-insensitive on Windows.
export const norm = (p) => { const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };

// Catalog plugins that fit the stacks found in `dir`, most useful first: services and platforms before language servers, then the cheaper ones.
export function matchingPlugins(dir) {
  const stacks = detectStacks(dir);
  const fits = catalog.plugins.filter((e) => e.stacks?.some((s) => stacks.some((d) => d.stack === s)))
    .map((e) => ({ ...e, because: stacks.filter((d) => e.stacks.includes(d.stack)) }));
  fits.sort((a, b) => (/-lsp$/.test(a.id) - /-lsp$/.test(b.id)) || (a.alwaysOnTokens - b.alwaysOnTokens));
  return { stacks, fits };
}

// Every install Claude Code recorded: { id, scope: user | project | local, projectPath }. A project install belongs to one folder only.
export function installedEntries() {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json');
  return Object.entries(readJson(file)?.plugins || {}).flatMap(([id, list]) => (list || []).map((x) => ({ id, scope: x.scope || 'user', projectPath: x.projectPath })));
}
// Installed and active in `dir`: for every project, or installed for exactly this one.
export const installedIds = (dir) => new Set(installedEntries().filter((x) => x.scope === 'user' || (x.projectPath && dir && norm(x.projectPath) === norm(dir))).map((x) => x.id));

// A session started in this folder: the project is alive, and no longer abandoned if it was.
export function noteSeen(dir) {
  const key = path.resolve(dir), seen = readJson(SEEN) || {};
  seen[key] = new Date().toISOString();
  // ponytail: keeps the 200 newest projects; an older one is simply not known until a session starts in it again
  writeJson(SEEN, Object.fromEntries(Object.entries(seen).slice(-200)));
  const gone = readJson(ABANDONED);
  if (gone?.some((p) => norm(p) === norm(key))) writeJson(ABANDONED, gone.filter((p) => norm(p) !== norm(key)));
}
export const abandoned = () => new Set((readJson(ABANDONED) || []).map(norm));

// Project folders this plugin knows and that still exist: sessions that started in them, dashboard registrations and runs, hint history, and
// the folders of project-scoped installs. Abandoned ones are left out.
export function knownProjects() {
  const listCwds = (sub) => { try { return fs.readdirSync(path.join(PIPELINE_HOME, sub)).filter((f) => /^[^.]+\.json$/.test(f)).map((f) => readJson(path.join(PIPELINE_HOME, sub, f))?.cwd); } catch { return []; } };
  const dirs = [...Object.keys(readJson(SEEN) || {}), ...Object.keys(readJson(path.join(PIPELINE_HOME, 'suggested.json')) || {}), ...listCwds('projects'), ...listCwds('runs'), ...installedEntries().map((x) => x.projectPath)];
  const gone = abandoned(), byKey = new Map();
  for (const d of dirs) if (d && !gone.has(norm(d)) && fs.existsSync(d)) byKey.set(norm(d), path.resolve(d));
  return [...byKey.values()];
}
export const lastSeen = (dir) => (readJson(SEEN) || {})[path.resolve(dir)] || null;
export const markAbandoned = (dir) => writeJson(ABANDONED, [...new Set([...(readJson(ABANDONED) || []), path.resolve(dir)])]);
export function forgetProject(dir) { // drop the hint history and the sighting of a folder
  for (const f of [SEEN, path.join(PIPELINE_HOME, 'suggested.json')]) {
    const o = readJson(f); if (!o) continue;
    writeJson(f, Object.fromEntries(Object.entries(o).filter(([k]) => norm(k) !== norm(dir))));
  }
}

// The notice a hook shows for what is new in this folder, or null: nothing fits, everything is installed, or it was announced before.
// It remembers what it showed (~/.claude-pipeline/suggested.json), so a project hears about each plugin once.
export function suggestionNotice(dir) {
  const { stacks, fits } = matchingPlugins(dir);
  const have = installedIds(dir);
  const file = path.join(PIPELINE_HOME, 'suggested.json'), state = readJson(file) || {}, key = path.resolve(dir), told = new Set(state[key] || []);
  const show = fits.filter((e) => !have.has(e.plugin) && !told.has(e.id));
  const more = show.length - 4;
  show.length = Math.min(show.length, 4);
  if (!show.length) return null;
  // ponytail: keeps the last 100 projects; an older project simply hears its suggestions again
  writeJson(file, Object.fromEntries(Object.entries({ ...state, [key]: [...told, ...show.map((e) => e.id)] }).slice(-100)));
  const what = stacks.slice(0, 6).map((s) => s.stack).join(', ');
  const list = show.map((e) => `${e.id} (${e.does.replace(/\.$/, '')}; about ${e.alwaysOnTokens} tokens per session)`).join('; ');
  return `This project uses ${what}. Plugins that fit and are not installed: ${list}${more > 0 ? `; and ${more} more` : ''}. Type /toolkit to review and install them (one confirmation; nothing is installed without it).`;
}
