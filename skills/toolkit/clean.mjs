// Clean up after a project you gave up on: plugins that were only for it go, everything shared stays. Behind /clean.
// "Only for it" is never guessed loosely:
//   - a plugin installed for this one project (scope local or project) belongs to it by definition;
//   - a user-wide service or platform plugin (catalog installScope "project": Stripe, Supabase ...) counts only when this project needs it and
//     no other project this plugin has seen does; language servers, frontend-design and general plugins (ponytail ...) are shared by nature.
import path from 'node:path';
import { detectStacks } from './detect.mjs';
import { catalog, norm, installedEntries, knownProjects, markAbandoned, forgetProject, lastSeen } from './suggest.mjs';

export function cleanPlan(dir) {
  const root = path.resolve(dir), me = norm(root);
  const byPlugin = new Map(catalog.plugins.map((e) => [e.plugin, e]));
  const mine = new Set(detectStacks(root).map((s) => s.stack));
  const others = knownProjects().filter((p) => norm(p) !== me).map((p) => ({ dir: p, stacks: new Set(detectStacks(p).map((s) => s.stack)) }));
  const plan = { project: root, remove: [], keep: [], otherProjects: others.map((o) => o.dir) };
  for (const en of installedEntries()) {
    const e = byPlugin.get(en.id), title = e?.title || en.id.split('@')[0];
    if (en.scope !== 'user') { // installed for one folder
      if (en.projectPath && norm(en.projectPath) === me) plan.remove.push({ id: en.id, title, scope: en.scope, why: `installed for this project only (${en.scope} scope)` });
      continue;
    }
    if (!e || e.kind !== 'stack' || !e.stacks.some((s) => mine.has(s))) continue;   // general plugins and unrelated ones are never touched
    const users = others.filter((o) => e.stacks.some((s) => o.stacks.has(s))).map((o) => o.dir);
    if (e.installScope !== 'project') plan.keep.push({ id: en.id, title, why: 'a language or general tool, shared by nature' });
    else if (users.length) plan.keep.push({ id: en.id, title, why: 'also used by other projects', usedBy: users });
    else plan.remove.push({ id: en.id, title, scope: 'user', why: 'installed for all projects, but no other project I know uses it', global: true });
  }
  return plan;
}

// Removes only what the plan lists for this project. `run(args, cwd)` runs the claude CLI.
export function cleanApply(dir, ids, run) {
  const allowed = new Map(cleanPlan(dir).remove.map((p) => [p.id, p]));
  return ids.map((id) => {
    const p = allowed.get(id);
    if (!p) return { id, ok: false, message: 'not in the clean plan of this project: only plugins used by this project alone can be removed' };
    const r = run(['plugin', 'uninstall', id, '--scope', p.scope], path.resolve(dir));
    const said = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean).at(-1) || '';
    return { id, scope: p.scope, ok: r.status === 0, message: said.slice(0, 200) };
  });
}

export function projectList() {
  return knownProjects().map((dir) => ({ dir, lastSeen: lastSeen(dir) })).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// Bookkeeping only: the project no longer counts as a user of anything, and leaves the dashboard's Documents list. Never touches its files.
export async function abandon(dir) {
  markAbandoned(dir);
  forgetProject(dir);
  const { projectId, unregisterProject } = await import('../setup-pipeline/dashboard.mjs');
  unregisterProject(dir);
  return { ok: true, project: path.resolve(dir), id: projectId(dir) };
}
