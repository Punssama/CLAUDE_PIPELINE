// Stack scan behind the project suggestions of /toolkit, /discover and the session hint: which technologies does this folder use?
// Own rules, no network. Signals: file names, package.json dependency names, the root manifests (requirements.txt, go.mod, composer.json ...)
// and, for a brand-new project, the words in SPEC.md. A stack id here is what a catalog entry lists under `stacks`.
import fs from 'node:fs';
import path from 'node:path';

// text = a regex tried against the dependency names, then the manifests, then SPEC.md; spec = broader words tried on SPEC.md only;
// files = a regex over file paths (two folder levels).
// Keep the words specific: they also run over free text, so "neon" or "sanity" alone would fire on ordinary prose.
const RULES = {
  'web-ui':       { files: /(^|\/)index\.html$/, text: /\b(react|next\.?js|vue|nuxt|svelte|angular|astro|solid-js|preact|tailwind(css)?|vite)\b/, spec: /\b(html|css|web (app|page|ui)|frontend|browser)\b/ },
  typescript:     { files: /(^|\/)tsconfig(\..+)?\.json$/, text: /\btypescript\b/ },
  python:         { files: /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py|Pipfile)$/, text: /\bpython\b/ },
  go:             { files: /(^|\/)go\.mod$/, text: /\bgolang\b|\bgo (module|backend|service)\b/ },
  rust:           { files: /(^|\/)Cargo\.toml$/, text: /\brust\b/ },
  java:           { files: /(^|\/)(pom\.xml|build\.gradle)$/, text: /\bjava\b|spring boot/ },
  kotlin:         { files: /(^|\/)build\.gradle\.kts$|\.kt$/, text: /\bkotlin\b/ },
  csharp:         { files: /\.(csproj|sln)$/, text: /\bc#|\bcsharp\b|\.net\b/ },
  php:            { files: /(^|\/)composer\.json$/, text: /\bphp\b/ },
  laravel:        { text: /\blaravel\b/ },
  ruby:           { files: /(^|\/)Gemfile$/, text: /\bruby\b|\brails\b/ },
  swift:          { files: /(^|\/)Package\.swift$|\.xcodeproj(\/|$)/, text: /\bswift(ui)?\b/ },
  cpp:            { files: /(^|\/)CMakeLists\.txt$|\.(cpp|cc|hpp)$/, text: /c\+\+/ },
  lua:            { files: /\.lua$/, text: /\blua\b/ },
  e2e:            { files: /(^|\/)playwright\.config\./, text: /\bplaywright\b/ },
  vercel:         { files: /(^|\/)vercel\.json$/, text: /\bvercel\b/ },
  supabase:       { files: /(^|\/)supabase\/config\.toml$/, text: /\bsupabase\b/ },
  postgres:       { text: /\bpostgres(ql)?\b|\bpsycopg|\basyncpg\b|(^|\n)pg(\n|$)/ },
  neon:           { text: /neondatabase|neon (postgres|database|db)/ },
  stripe:         { text: /\bstripe\b/ },
  cloudflare:     { files: /(^|\/)wrangler\.(toml|json|jsonc)$/, text: /\bcloudflare\b|\bwrangler\b/ },
  clerk:          { text: /@clerk\/|\bclerk (auth|sdk)\b/ },
  'better-auth':  { text: /better[- ]auth/ },
  aws:            { files: /(^|\/)cdk\.json$/, text: /\baws\b|aws-sdk|aws-cdk|\bboto3\b|dynamodb/ },
  'aws-serverless': { files: /(^|\/)(serverless\.ya?ml|samconfig\.toml)$/, text: /aws lambda|serverless framework/ },
  'aws-amplify':  { files: /(^|\/)amplify\//, text: /aws-amplify|\bamplify gen ?2\b/ },
  azure:          { files: /(^|\/)azure\.yaml$/, text: /@azure\/|\bazure\b/ },
  terraform:      { files: /\.tf$/, text: /\bterraform\b/ },
  firebase:       { files: /(^|\/)firebase\.json$/, text: /\bfirebase\b/ },
  sanity:         { files: /(^|\/)sanity\.(config|cli)\./, text: /@sanity\/|next-sanity|sanity\.io|sanity studio/ },
};
export const STACKS = Object.keys(RULES);
const MANIFESTS =/^(requirements\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|composer\.json|Gemfile|pom\.xml|build\.gradle(\.kts)?)$/;

// Top two folder levels only, skipping dependency and build folders: cheap and enough for a manifest or index.html.
function listFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'].includes(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
      if (e.isDirectory()) { out.push(rel + '/'); if (depth < 1) walk(path.join(dir, e.name), depth + 1); } else out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

// -> [{ stack, why }] one entry per detected stack; `why` is the first signal that matched (shown to the user).
export function detectStacks(root) {
  const files = listFiles(root);
  const read = (f, max = 100_000) => { try { return fs.readFileSync(path.join(root, f), 'utf8').slice(0, max).toLowerCase(); } catch { return ''; } };
  let deps = [];
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); deps = Object.keys({ ...j.dependencies, ...j.devDependencies }); } catch { /* no package.json */ }
  const manifest = files.filter((f) => MANIFESTS.test(path.basename(f))).map((f) => read(f)).join('\n');
  const sources = [['dependency', deps.join('\n').toLowerCase()], ['a manifest', manifest], ['SPEC.md', read('SPEC.md', 200_000)]];
  const found = [];
  for (const [stack, r] of Object.entries(RULES)) {
    const file = r.files && files.find((f) => r.files.test(f));
    let why = file ? `file ${file.replace(/\/$/, '')}` : null;
    for (const [label, blob] of sources) {
      for (const re of [r.text, label === 'SPEC.md' && r.spec]) {
        const m = !why && re && blob.match(re);
        if (m) why = `${label} mentions "${m[0].trim()}"`;
      }
    }
    if (why) found.push({ stack, why });
  }
  return found;
}
