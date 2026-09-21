// Stack scan behind /toolkit's project suggestions: which technologies does this folder use? Own rules, no network.
// Signals: manifest files, package.json dependencies, and (for a brand-new project) the words in SPEC.md.
import fs from 'node:fs';
import path from 'node:path';

const RULES = {
  'web-ui':     { deps: /^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|astro|solid-js|preact|tailwindcss|vite)$/, files: /(^|\/)index\.html$/, words: /\b(react|next\.?js|vue|nuxt|svelte|angular|astro|tailwind|html|css|web (app|page|ui)|frontend|browser)\b/ },
  typescript:   { deps: /^typescript$/, files: /(^|\/)tsconfig(\..+)?\.json$/, words: /\btypescript\b/ },
  python:       { files: /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py|Pipfile)$/, words: /\bpython\b/ },
  go:           { files: /(^|\/)go\.mod$/, words: /\bgolang\b|\bgo (module|backend|service)\b/ },
  rust:         { files: /(^|\/)Cargo\.toml$/, words: /\brust\b/ },
};

// Top two folder levels only, skipping dependency and build folders: cheap and enough for a manifest or index.html.
function listFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'].includes(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
      if (e.isDirectory()) { if (depth < 1) walk(path.join(dir, e.name), depth + 1); } else out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

// -> [{ stack, why }] one entry per detected stack; `why` is the first signal that matched (shown to the user).
export function detectStacks(root) {
  const files = listFiles(root);
  let deps = [];
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); deps = Object.keys({ ...j.dependencies, ...j.devDependencies }); } catch { /* no package.json */ }
  let spec = '';
  try { spec = fs.readFileSync(path.join(root, 'SPEC.md'), 'utf8').toLowerCase(); } catch { /* no spec yet */ }
  const found = [];
  for (const [stack, r] of Object.entries(RULES)) {
    const dep = r.deps && deps.find((d) => r.deps.test(d));
    const file = r.files && files.find((f) => r.files.test(f));
    const word = spec && r.words && spec.match(r.words)?.[0];
    const why = dep ? `dependency ${dep}` : file ? `file ${file}` : word ? `SPEC.md mentions "${word}"` : null;
    if (why) found.push({ stack, why });
  }
  return found;
}

