#!/usr/bin/env node
// Quality gates: CI-style checks that run after Build and before Review. The reviewer only sees code that already passes the
// mechanical checks, and the fixer gets the exact failing output instead of a prose review.
//   node gates.mjs --detect [preset|ids] [--cwd dir] [--acs AC-1,AC-2] [--json]   what would run here, and what is missing
//   node gates.mjs --run    [preset|ids] [--cwd dir] [--acs ...]                    run them now (exit 1 if a blocking gate fails)
//   node gates.mjs --tools  [js|py|go|rust]                                          recommended tools and install commands
// Third-party tools are detected, never installed: a missing tool means its gate is skipped with an install hint.
// Config (cfg.gates in .pipeline/config.json): "standard" | ["tests","lint"] | { preset, add, skip, warn, block, custom: [{ id, cmd }] }
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const OS = WIN ? 'win' : process.platform === 'darwin' ? 'mac' : 'other';

// Third-party tools the gates can use (stars/licenses are in the README). `all` applies to every OS unless win/mac/other is set.
export const TOOLS = {
  gitleaks: { repo: 'gitleaks/gitleaks', win: 'winget install Gitleaks.Gitleaks', mac: 'brew install gitleaks', other: 'https://github.com/gitleaks/gitleaks/releases' },
  trivy: { repo: 'aquasecurity/trivy', win: 'winget install AquaSecurity.Trivy', mac: 'brew install trivy', other: 'https://github.com/aquasecurity/trivy/releases' },
  'osv-scanner': { repo: 'google/osv-scanner', win: 'winget install Google.OSVScanner', mac: 'brew install osv-scanner', other: 'go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest' },
  'pip-audit': { repo: 'pypa/pip-audit', all: 'pip install pip-audit' },
  pytest: { repo: 'pytest-dev/pytest', all: 'pip install pytest' },
  ruff: { repo: 'astral-sh/ruff', all: 'pip install ruff' },
  mypy: { repo: 'python/mypy', all: 'pip install mypy' },
  pyright: { repo: 'microsoft/pyright', all: 'pip install pyright' },
  eslint: { repo: 'eslint/eslint', all: 'npm i -D eslint   (then: npm init @eslint/config@latest)' },
  biome: { repo: 'biomejs/biome', all: 'npm i -D @biomejs/biome' },
  typescript: { repo: 'microsoft/TypeScript', all: 'npm i -D typescript' },
  'golangci-lint': { repo: 'golangci/golangci-lint', win: 'winget install GolangCI.golangci-lint', mac: 'brew install golangci-lint', other: 'https://golangci-lint.run/welcome/install/' },
  'pre-commit': { repo: 'pre-commit/pre-commit', all: 'pip install pre-commit' },
};
export const hint = (t) => { const x = TOOLS[t]; return x ? x[OS] || x.all || '' : ''; };
const ECO_TOOLS = { any: ['gitleaks', 'osv-scanner'], js: ['eslint', 'typescript'], py: ['pytest', 'ruff', 'mypy', 'pip-audit'], go: ['golangci-lint'], rust: [] };

const GATES = {
  tests: { title: 'Tests', kind: 'test', blocking: true, timeoutSec: 600 },
  lint: { title: 'Lint', kind: 'lint', blocking: true, timeoutSec: 240 },
  types: { title: 'Types', kind: 'types', blocking: true, timeoutSec: 300 },
  build: { title: 'Build', kind: 'build', blocking: true, timeoutSec: 600 },
  secrets: { title: 'Secrets in the change', kind: 'security', blocking: true, timeoutSec: 120 },
  trace: { title: 'Every AC has a test', kind: 'spec', blocking: true, timeoutSec: 60 },
  size: { title: 'Change size', kind: 'size', blocking: false, timeoutSec: 60 },
  audit: { title: 'Dependency vulnerabilities', kind: 'security', blocking: false, timeoutSec: 300 },
  precommit: { title: 'pre-commit hooks', kind: 'lint', blocking: true, timeoutSec: 300 },
};
export const PRESETS = {
  minimal: ['tests', 'secrets', 'trace'],
  standard: ['tests', 'lint', 'types', 'build', 'secrets', 'trace', 'size'],
  strict: ['tests', 'lint', 'types', 'build', 'secrets', 'trace', 'size', 'audit', 'precommit'],
};

// ---- project facts -------------------------------------------------------------------------------
function specCommands(txt) { // the "Commands" table of SPEC.md: | Test | `pytest -q` |
  const out = {}, i = txt.search(/^#{1,3}\s*Commands\b/im);
  if (i < 0) return out;
  for (const l of txt.slice(i).split('\n').slice(1)) {
    if (/^#{1,3}\s/.test(l)) break;
    const m = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/.exec(l);
    const k = m && { test: 'test', tests: 'test', lint: 'lint', types: 'types', typecheck: 'types', build: 'build' }[m[1].toLowerCase()];
    if (k && !/<[^>\n]*>|\.\.\./.test(m[2])) out[k] = m[2].trim();
  }
  return out;
}

export function context(cwd, cfg = {}, acs = []) {
  const file = (f) => path.join(cwd, f);
  const txt = (f) => { try { return fs.readFileSync(file(f), 'utf8'); } catch { return ''; } };
  const has = (...f) => f.some((x) => fs.existsSync(file(x)));
  let pkg = null; try { pkg = JSON.parse(txt('package.json')); } catch { /* not a Node project */ }
  // unattended: no watch mode, no colours. FORCE_COLOR=0 also overrides an inherited FORCE_COLOR=1, which would make every Node tool
  // print "NO_COLOR is ignored due to FORCE_COLOR" into the gate output. trim() strips any colour codes that remain.
  const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONIOENCODING: 'utf-8' };
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const local = ['node_modules/.bin', '.venv/Scripts', '.venv/bin', 'venv/Scripts', 'venv/bin'].map(file).filter((d) => fs.existsSync(d));
  env[pk] = [...local, env[pk] || ''].join(path.delimiter);
  const dirs = env[pk].split(path.delimiter).filter(Boolean);
  const exts = WIN ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  const which = (bin) => { for (const d of dirs) for (const e of exts) { try { const f = path.join(d, bin + e); if (fs.statSync(f).isFile()) return f; } catch { /* next */ } } return null; };
  const list = (d) => { try { return fs.readdirSync(file(d)); } catch { return []; } };
  const some = (re, ...ds) => ds.some((d) => list(d).some((n) => re.test(n)));
  let py;
  const python = () => (py ??= ['python', 'python3', ...(WIN ? ['py'] : [])].find((b) => which(b) && spawnSync(b, ['-c', '1'], { env }).status === 0) || '');
  const pyHas = (m) => !!python() && spawnSync(python(), ['-c', `import ${m}`], { env }).status === 0;
  const eco = {
    js: !!pkg,
    py: has('pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'tox.ini', 'Pipfile') || some(/\.py$/, '.', 'src', 'tests', 'test'),
    go: has('go.mod'),
    rust: has('Cargo.toml'),
  };
  return {
    cwd, env, cfg, acs, pkg, eco, has, txt, which, python, pyHas, spec: specCommands(txt('SPEC.md')),
    nodeTests: !pkg && some(/\.[cm]?js$/, 'test'), pyTests: some(/^test_.*\.py$|_test\.py$/, '.', 'tests', 'test'),
    manifest: has('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements.txt', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.mod', 'Cargo.lock', 'pom.xml'),
  };
}

// ---- recipes: what each gate runs in this project ------------------------------------------------
// A recipe returns variants: { cmd | fn, eco, tool, verified } to run, or { skip, tool } when it cannot run here.
// verified: true = this exact command was run on Windows against a fixture with a real finding and a clean case (exit codes and output checked);
// false = it follows the tool's documented CLI but has not been run by the author yet.
const skip = (reason, tool) => ({ skip: reason, tool });
const realTest = (s) => s && !/no test specified/.test(s);
const RECIPES = {
  tests(c) {
    if (c.cfg.testCmd) return [{ cmd: c.cfg.testCmd, eco: 'cfg', verified: true }];
    if (c.spec.test) return [{ cmd: c.spec.test, eco: 'spec', verified: true }];
    const v = [];
    if (c.pkg ? realTest(c.pkg.scripts?.test) : c.nodeTests) v.push({ cmd: c.pkg ? 'npm test --silent' : 'node --test', eco: 'js', verified: true });
    if (c.eco.py) {
      if (c.pyHas('pytest')) v.push({ cmd: `${c.python()} -m pytest -q`, eco: 'py', tool: 'pytest', verified: true });
      else if (c.python() && c.pyTests) v.push({ cmd: `${c.python()} -m unittest discover`, eco: 'py', verified: true });
      else if (c.python()) v.push(skip('pytest is not installed', 'pytest'));
      else v.push(skip('no working python found on PATH'));
    }
    if (c.eco.go && c.which('go')) v.push({ cmd: 'go test ./...', eco: 'go', verified: false });
    if (c.eco.rust && c.which('cargo')) v.push({ cmd: 'cargo test --quiet', eco: 'rust', verified: false });
    return v.length ? v : [skip('no test command found: add a Test row to the SPEC.md Commands table or set testCmd')];
  },
  lint(c) {
    if (c.spec.lint) return [{ cmd: c.spec.lint, eco: 'spec', verified: true }];
    const v = [];
    if (c.pkg) {
      const eslintCfg = c.has('eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml') || c.pkg.eslintConfig;
      if (c.pkg.scripts?.lint) v.push({ cmd: 'npm run lint --silent', eco: 'js', verified: true });
      else if (eslintCfg) v.push(c.which('eslint') ? { cmd: 'eslint .', eco: 'js', tool: 'eslint', verified: true } : skip('an eslint config exists but eslint is not installed', 'eslint'));
      else if (c.has('biome.json', 'biome.jsonc')) v.push(c.which('biome') ? { cmd: 'biome check .', eco: 'js', tool: 'biome', verified: false } : skip('biome.json exists but biome is not installed', 'biome'));
      else v.push(skip('no linter configured (add an eslint or biome config, or a "lint" script)', 'eslint'));
    }
    if (c.eco.py) {
      const cfgd = c.has('ruff.toml', '.ruff.toml') || /\[tool\.ruff/.test(c.txt('pyproject.toml'));
      // without a ruff config, only real errors (syntax, undefined names, unused imports): its default style rules are noisy on generated code
      v.push(c.which('ruff') ? { cmd: cfgd ? 'ruff check .' : 'ruff check --select E4,E7,E9,F .', eco: 'py', tool: 'ruff', verified: true } : skip('ruff is not installed', 'ruff'));
    }
    if (c.eco.go) {
      if (c.which('golangci-lint')) v.push({ cmd: 'golangci-lint run', eco: 'go', tool: 'golangci-lint', verified: false });
      else if (c.which('go')) v.push({ cmd: 'go vet ./...', eco: 'go', verified: false });
    }
    if (c.eco.rust && c.which('cargo')) {
      v.push(spawnSync('cargo', ['clippy', '--version'], { env: c.env }).status === 0 ? { cmd: 'cargo clippy --quiet -- -D warnings', eco: 'rust', verified: false } : skip('clippy is not installed (rustup component add clippy)'));
    }
    return v;
  },
  types(c) {
    if (c.spec.types) return [{ cmd: c.spec.types, eco: 'spec', verified: true }];
    const v = [];
    if (c.pkg) {
      const name = ['typecheck', 'type-check', 'check-types'].find((n) => c.pkg.scripts?.[n]);
      if (name) v.push({ cmd: `npm run ${name} --silent`, eco: 'js', verified: true });
      else if (c.has('tsconfig.json')) v.push(c.which('tsc') ? { cmd: 'tsc --noEmit', eco: 'js', tool: 'typescript', verified: true } : skip('tsconfig.json exists but typescript is not installed', 'typescript'));
    }
    if (c.eco.py) {
      if (c.has('mypy.ini', '.mypy.ini') || /^\[mypy\]/m.test(c.txt('setup.cfg')) || /\[tool\.mypy\]/.test(c.txt('pyproject.toml'))) {
        v.push(c.which('mypy') ? { cmd: 'mypy .', eco: 'py', tool: 'mypy', verified: true } : skip('mypy is configured but not installed', 'mypy'));
      } else if (c.has('pyrightconfig.json') || /\[tool\.pyright\]/.test(c.txt('pyproject.toml'))) {
        v.push(c.which('pyright') ? { cmd: 'pyright', eco: 'py', tool: 'pyright', verified: false } : skip('pyright is configured but not installed', 'pyright'));
      } else v.push(skip('no type checker configured (add [tool.mypy] to pyproject.toml or a mypy.ini to enable this gate)', 'mypy'));
    }
    if (c.eco.rust && c.which('cargo')) v.push({ cmd: 'cargo check --quiet', eco: 'rust', verified: false });
    return v;
  },
  build(c) {
    if (c.spec.build) return [{ cmd: c.spec.build, eco: 'spec', verified: true }];
    const v = [];
    if (c.pkg?.scripts?.build) v.push({ cmd: 'npm run build --silent', eco: 'js', verified: true });
    if (c.eco.go && c.which('go')) v.push({ cmd: 'go build ./...', eco: 'go', verified: false });
    return v;
  },
  secrets: (c) => [{ fn: secretsGate, eco: 'any', tool: c.which('gitleaks') ? 'gitleaks' : null, verified: true,
    note: c.which('gitleaks') ? 'gitleaks on the changed lines' : `built-in patterns on the changed lines (gitleaks has far more rules: ${hint('gitleaks')})` }],
  trace: (c) => (c.acs.length ? [{ fn: traceGate, eco: 'any', verified: true }] : []), // needs acceptance-criterion IDs (milestone mode)
  size: () => [{ fn: sizeGate, eco: 'any', verified: true }],
  audit(c) {
    if (!c.manifest) return [skip('no lockfile or dependency manifest found')];
    if (c.which('osv-scanner')) return [{ cmd: 'osv-scanner scan source -r .', eco: 'any', tool: 'osv-scanner', verified: true }];
    if (c.which('trivy')) return [{ cmd: 'trivy fs --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 --quiet --no-progress .', eco: 'any', tool: 'trivy', verified: true }];
    if (c.eco.py && c.has('requirements.txt') && c.which('pip-audit')) return [{ cmd: 'pip-audit -r requirements.txt --progress-spinner off', eco: 'py', tool: 'pip-audit', verified: true }];
    if (c.pkg && c.has('package-lock.json')) return [{ cmd: 'npm audit --audit-level=high', eco: 'js', verified: true }];
    return [skip('no dependency scanner found', 'osv-scanner')];
  },
  precommit(c) {
    if (!c.has('.pre-commit-config.yaml')) return [];
    const bin = ['pre-commit', 'prek'].find((b) => c.which(b));
    return [bin ? { fn: precommitGate(bin), eco: 'any', tool: bin, verified: true, note: `${bin} run on the changed files` } : skip('.pre-commit-config.yaml exists but pre-commit is not installed', 'pre-commit')];
  },
};

// ---- built-in gates (no dependencies) --------------------------------------------------------------
// Lines added by the change: tracked diff against HEAD plus untracked files, as { file, line, text }. null = not a git repo.
export function addedLines(cwd) {
  const d = spawnSync('git', ['-c', 'core.quotepath=off', 'diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--no-renames'], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (d.status !== 0) return null;
  const out = []; let file = null, ln = 0;
  for (const l of d.stdout.split('\n')) {
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6).replace(/\t.*$/, '') : null;
    else if (l.startsWith('@@')) ln = Number(/\+(\d+)/.exec(l)?.[1] || 0);
    else if (l.startsWith('+') && file) out.push({ file, line: ln++, text: l.slice(1).replace(/\r$/, '') });
  }
  const u = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const f of u.stdout.split('\0').filter(Boolean)) {
    let buf; try { if (fs.statSync(path.join(cwd, f)).size > 1 << 20) continue; buf = fs.readFileSync(path.join(cwd, f)); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    const ls = buf.toString('utf8').split('\n');
    if (ls[ls.length - 1] === '') ls.pop(); // the newline that ends the file is not another line
    ls.forEach((text, i) => out.push({ file: f, line: i + 1, text: text.replace(/\r$/, '') }));
  }
  return out;
}

const RULES = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  ['Anthropic/OpenAI API key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const ASSIGN = /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth)[\w-]*["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i;
const PLACEHOLDER = /^(?:x+|\*+|\.+|your[_-]|change[_-]?me|example|placeholder|dummy|sample|test|<|\$\{|\{\{|%|process\.env|os\.environ)/i;
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.(?!example|sample|template|dist)[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:p12|pfx|jks|keystore))$/i;
const entropy = (s) => { const f = {}; for (const ch of s) f[ch] = (f[ch] || 0) + 1; return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0); };
const allowed = (t) => /pipeline:allow-secret|gitleaks:allow|EXAMPLE/.test(t); // deliberate fakes and the AWS docs' sample keys

export function builtinSecrets(added) {
  const hits = [];
  for (const { file, line, text } of added) {
    if (allowed(text) || text.length > 4000) continue;
    const rule = RULES.find(([, re]) => re.test(text))?.[0]
      || ((m) => (m && !PLACEHOLDER.test(m[1]) && entropy(m[1]) >= 3.5 && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1]) ? 'Hard-coded credential' : null))(ASSIGN.exec(text));
    if (rule) hits.push({ file, line, rule });
  }
  for (const f of new Set(added.map((a) => a.file))) if (SENSITIVE_FILE.test(f)) hits.push({ file: f, line: 0, rule: 'Sensitive file name (credentials belong in the environment, not in the repo)' });
  return hits;
}

function secretsGate(c) {
  const added = addedLines(c.cwd);
  if (!added) return { skip: 'not a git repository, or it has no commit yet' };
  let hits;
  if (c.which('gitleaks')) {
    // Feed only the added lines, and map gitleaks' line numbers (stdin has no file names) back to file:line.
    const lines = [], origin = [];
    let prev = null;
    for (const a of added) { if (prev && (a.file !== prev.file || a.line !== prev.line + 1)) { lines.push(''); origin.push(null); } lines.push(a.text); origin.push(a); prev = a; }
    const r = spawnSync('gitleaks', ['stdin', '--redact', '--no-banner', '--exit-code', '1', '-l', 'error', '-f', 'json', '-r', '-'], { cwd: c.cwd, env: c.env, input: lines.join('\n'), encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 });
    if (r.status === 0) return { ok: true, out: '' };
    if (r.status !== 1) return { ok: false, out: `gitleaks failed (exit ${r.status}): ${(r.stderr || String(r.error || '')).slice(-400)}` };
    let found = []; try { found = JSON.parse(r.stdout) || []; } catch { /* keep the exit code as the verdict */ }
    hits = found.map((f) => ({ file: origin[f.StartLine - 1]?.file || '?', line: origin[f.StartLine - 1]?.line || 0, rule: f.Description?.replace(/^(?:Uncovered|Identified|Detected|Discovered) (?:an? )?/i, '').replace(/,.*$/, '').replace(/\.$/, '') || f.RuleID }));
    if (!hits.length) hits = [{ file: '?', line: 0, rule: 'gitleaks reported a finding' }];
  } else hits = builtinSecrets(added);
  if (!hits.length) return { ok: true, out: '' };
  const where = (h) => `${h.file}${h.line ? `:${h.line}` : ''}`;
  return { ok: false, note: `${hits.length} secret(s): ${hits.slice(0, 3).map(where).join(', ')}`,
    out: `Secrets found in the change (values are never printed):\n${hits.slice(0, 30).map((h) => `- ${where(h)}  ${h.rule}`).join('\n')}\n`
    + 'Fix: remove the value, read it from an environment variable or a git-ignored file, and rotate the credential if it was ever real. '
    + 'If the value is a deliberate fake, put "pipeline:allow-secret" in a comment on that line.' };
}

const TESTFILE = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)tests?\.[^/]+$|Tests?\.(?:java|kt|cs)$/i;
function traceGate(c) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: c.cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { skip: 'not a git repository' };
  let tests = 0, text = '';
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    let s; try { if (fs.statSync(path.join(c.cwd, f)).size > 1 << 20) continue; s = fs.readFileSync(path.join(c.cwd, f), 'utf8'); } catch { continue; }
    if (TESTFILE.test(f) || (f.endsWith('.rs') && /#\[(?:cfg\(test\)|test)\]/.test(s))) { tests++; text += s + '\n'; }
  }
  if (!tests) return { ok: false, note: 'no test files found', out: 'No test files found. Expected files such as tests/, test_*.py, *.test.js, *_test.go.' };
  // AC-2 also counts as AC_2 / ac_2: a function name cannot contain a hyphen, so test_ac_2_rejects_empty is a natural way to name it
  const missing = c.acs.filter((a) => !new RegExp(String.raw`(?<![A-Za-z0-9])${a.replace('-', '[-_]')}(?![0-9])`, 'i').test(text));
  return missing.length ? { ok: false, note: `no test names ${missing.join(', ')}`, out: `Acceptance criteria that no test names:\n${missing.map((a) => `- ${a}`).join('\n')}\n`
    + 'Every AC needs at least one test whose name, docstring or comment contains its ID, e.g. a comment "# AC-2", a test title "AC-2 rejects empty input" or a function test_ac_2_rejects_empty.' } : { ok: true, out: '' };
}

const GENERATED = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|dist\/|build\/|vendor\/)|\.min\.(?:js|css)$/;
function sizeGate(c) {
  const added = (addedLines(c.cwd) || []).filter((a) => !GENERATED.test(a.file));
  const files = new Set(added.map((a) => a.file)).size;
  const note = `${added.length} added lines in ${files} files`;
  return added.length > 800 || files > 25
    ? { ok: false, note, out: `Large change: ${note}. Reviews miss more in big diffs: consider splitting the milestone into smaller ones.` }
    : { ok: true, out: '', note };
}

const precommitGate = (bin) => (c) => {
  const a = addedLines(c.cwd);
  const files = a ? [...new Set(a.map((x) => x.file))] : [];
  const r = spawnSync(bin, ['run', '--show-diff-on-failure', ...(files.length && files.length <= 200 ? ['--files', ...files] : ['--all-files'])], { cwd: c.cwd, env: c.env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '') };
};

// ---- planning ----------------------------------------------------------------------------------------
function normalize(cfg) {
  const g = cfg.gates, o = { ids: [], add: [], skip: new Set(), warn: new Set(), block: new Set(), custom: [] };
  const preset = (n) => PRESETS[n] || (() => { throw new Error(`unknown gates preset "${n}" (use ${Object.keys(PRESETS).join(', ')})`); })();
  if (g == null) o.ids = cfg.testCmd ? ['tests'] : []; // config from before gates existed: its test command only
  else if (typeof g === 'string') o.ids = preset(g);
  else if (Array.isArray(g)) for (const x of g) (typeof x === 'string' ? o.ids : o.custom).push(x);
  else {
    o.ids = preset(g.preset ?? 'standard'); o.add = g.add || []; o.custom = g.custom || [];
    for (const k of ['skip', 'warn', 'block']) o[k] = new Set(g[k] || []);
  }
  return o;
}

// The gate ids a config asks for, before detection (used to tell the builder what will be checked).
export const gateIds = (cfg) => { const g = normalize(cfg); return [...new Set([...g.ids, ...g.add])].filter((i) => !g.skip.has(i)).concat(g.custom.map((x) => x.id)); };

// -> { gates: [{ id, title, kind, blocking, timeoutSec, cmd | fn | skip, tool, verified, note }], ctx }
export function planGates(cfg, cwd = process.cwd(), { acs = [] } = {}) {
  const g = normalize(cfg), ctx = context(cwd, cfg, acs), gates = [];
  for (const id of new Set([...g.ids, ...g.add])) {
    if (g.skip.has(id)) continue;
    const meta = GATES[id];
    if (!meta) { gates.push({ id, title: id, kind: 'custom', blocking: false, skip: `unknown gate "${id}" (built in: ${Object.keys(GATES).join(', ')})` }); continue; }
    const blocking = g.warn.has(id) ? false : g.block.has(id) ? true : meta.blocking;
    const variants = RECIPES[id](ctx);
    for (const v of variants) gates.push({ ...meta, ...v, id: variants.length > 1 && v.eco ? `${id}:${v.eco}` : id, blocking });
  }
  for (const x of g.custom) gates.push({ id: x.id, title: x.title || x.id, kind: 'custom', cmd: x.cmd, blocking: x.blocking !== false, timeoutSec: x.timeoutSec || 300, verified: null });
  return { gates, ctx };
}

// ---- running -----------------------------------------------------------------------------------------
function exec(cmd, ctx, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', timedOut = false, done = false;
    const child = spawn(cmd, { cwd: ctx.cwd, env: ctx.env, shell: true, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (d) => { if (out.length < 4e6) out += d; }; // memory bound; the report keeps only the head and tail anyway
    child.stdout.on('data', take); child.stderr.on('data', take);
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, timedOut }); } };
    const timer = setTimeout(() => {
      timedOut = true;
      if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', (e) => { out += String(e); finish(-1); });
    child.on('close', finish);
    child.on('exit', (code) => setTimeout(() => finish(code), 2000)); // a grandchild holding the pipes open must not hang the round
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function trim(out, max = 6000) {
  const s = out.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= max) return s;
  const head = Math.floor(max / 4);
  return `${s.slice(0, head)}\n... [${s.length - max} characters omitted] ...\n${s.slice(-(max - head))}`;
}
// One line that says what went wrong: among the last few lines, the one that talks about errors/failures (tools end with hints).
const bestLine = (s) => {
  const ls = s.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-8).reverse();
  return (ls.find((l) => /\b(?:errors?|failed|failures?|problems?|vulnerabilit\w*|found)\b/i.test(l)) || ls[0] || '').slice(0, 160);
};

// -> one result per gate: { id, title, kind, blocking, status: pass|fail|warn|skip|timeout|error, ms, cmd, tool, verified, note, out }
export async function runGates(gates, ctx, onEach = () => {}) {
  const results = [];
  for (const g of gates) {
    const base = { id: g.id, title: g.title, kind: g.kind, blocking: g.blocking, cmd: g.cmd, tool: g.tool || undefined, verified: g.verified };
    const t0 = Date.now();
    let r;
    if (g.skip) r = { ...base, status: 'skip', note: g.skip + (g.tool && hint(g.tool) ? ` (install: ${hint(g.tool)})` : ''), out: '' };
    else {
      let x;
      try { x = g.fn ? await g.fn(ctx) : await exec(g.cmd, ctx, (g.timeoutSec || 300) * 1000); } catch (e) { x = { code: -1, out: String(e?.stack || e) }; }
      const fnResult = 'ok' in x || 'skip' in x;
      const failed = fnResult ? x.skip === undefined && !x.ok : x.code !== 0;
      const status = x.skip !== undefined ? 'skip' : x.timedOut ? 'timeout' : !failed ? 'pass' : x.code === -1 && !fnResult ? 'error' : g.blocking ? 'fail' : 'warn';
      const rel = (s) => [ctx.cwd + path.sep, ctx.cwd.replaceAll('\\', '/') + '/'].reduce((t, p) => t.split(p).join(''), s); // repo-relative paths: fewer tokens
      r = { ...base, status, out: trim(rel(x.out || ''), status === 'warn' ? 2500 : 6000),
        note: x.skip ?? (x.timedOut ? `timed out after ${g.timeoutSec}s` : x.note ?? (status === 'pass' ? '' : bestLine(x.out || '') || `exit ${x.code}`)) };
    }
    r.ms = Date.now() - t0;
    results.push(r); onEach(r);
  }
  return results;
}

export const blockingFailed = (results) => results.filter((r) => r.blocking && (r.status === 'fail' || r.status === 'timeout'));
export const summarize = (results) => results.map((r) => `${r.id} ${r.status === 'warn' ? 'warn' : r.status}`).join(', ');

// The text the fixer reads (.pipeline/test-output.txt): a one-line-per-gate overview, then output only for gates that did not pass.
export function formatReport(results, round) {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP', timeout: 'FAIL', error: 'ERROR' };
  const line = (r) => `${tag[r.status]}  ${r.id}${r.blocking ? '' : ' (advisory)'}${r.cmd ? ` - ${r.cmd}` : ''}${r.status === 'skip' ? '' : ` - ${(r.ms / 1000).toFixed(1)}s`}${r.note && r.status !== 'pass' ? `\n      ${r.note}` : ''}`;
  const detail = results.filter((r) => ['fail', 'timeout', 'warn', 'error'].includes(r.status) && r.out)
    .map((r) => `\n## ${tag[r.status]} ${r.id}${r.blocking ? '' : ' (advisory)'}\n${r.out}\n`);
  return `# Quality gates${round ? ` (round ${round})` : ''}\n${results.map(line).join('\n')}\n${detail.join('')}`;
}

// ---- command line ------------------------------------------------------------------------------------
async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const cwd = path.resolve(opt('--cwd') || '.');
  const pos = a.find((x, i) => !x.startsWith('--') && a[i - 1] !== '--cwd' && a[i - 1] !== '--acs');
  if (cmd === '--tools') {
    const c = context(cwd);
    for (const e of pos ? [pos, 'any'] : Object.keys(ECO_TOOLS)) for (const t of ECO_TOOLS[e] || []) console.log(`${t.padEnd(14)} ${(t === 'pytest' ? c.pyHas('pytest') : c.which(t)) ? 'installed' : `missing    ${hint(t)}`}  (github.com/${TOOLS[t].repo})`);
    return;
  }
  if (cmd !== '--detect' && cmd !== '--run') { console.log('usage: node gates.mjs --detect|--run [minimal|standard|strict|id,id] [--cwd dir] [--acs AC-1,AC-2] [--json]  |  --tools [js|py|go|rust]'); process.exit(2); }
  const cfgFile = path.join(cwd, '.pipeline', 'config.json');
  const base = pos ? {} : fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const cfg = pos ? { ...base, gates: PRESETS[pos] ? pos : pos.split(',') } : { ...base, gates: base.gates ?? 'standard' };
  const { gates, ctx } = planGates(cfg, cwd, { acs: (opt('--acs') || '').split(',').filter(Boolean) });
  if (cmd === '--detect') {
    if (a.includes('--json')) return console.log(JSON.stringify(gates.map((g) => ({ ...g, cmd: g.cmd || (g.fn ? '(built in)' : undefined), installHint: g.skip && g.tool ? hint(g.tool) : undefined })), null, 1));
    for (const g of gates) console.log(`${g.id.padEnd(14)} ${(g.skip ? 'skip' : g.blocking ? 'blocking' : 'advisory').padEnd(9)} ${g.skip ? `${g.skip}${g.tool && hint(g.tool) ? `  -> ${hint(g.tool)}` : ''}` : `${g.cmd || 'built in'}${g.note ? ` (${g.note})` : ''}${g.verified === false ? '  [documented command, not yet verified]' : ''}`}`);
    return;
  }
  const results = await runGates(gates, ctx, (r) => console.log(`${r.status.toUpperCase().padEnd(7)} ${r.id}${r.note && r.status !== 'pass' ? ` - ${r.note}` : ''}`));
  if (a.includes('--json')) console.log(JSON.stringify(results.map(({ out, ...r }) => r), null, 1));
  else console.log('\n' + formatReport(results));
  process.exit(blockingFailed(results).length ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
