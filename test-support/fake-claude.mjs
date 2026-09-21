// Stand-in for the `claude` executable, driven by a scenario file, so the runner's control flow can be tested without a model.
//   FAKE_SCENARIO: JSON { <kind>: [ { writes: { path: content }, remove: [path], commit: false } ] }  (the n-th call of a kind uses the n-th entry)
//   an entry may also set result: the final message the step "says" (default "fake <kind> done")
//   FAKE_LOG: every call is appended there as { kind, args, prompt }
// kinds: plan | repair | critique | build | fix-gates | fix-review | review | commit
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const kind = /already exists but fails these automated checks/.test(prompt) ? 'repair'
  : /is a first draft/.test(prompt) ? 'critique'
  : /create a git commit/.test(prompt) ? 'commit'
  : /Review the uncommitted changes/.test(prompt) ? 'review'
  : /quality gates failed/.test(prompt) ? 'fix-gates'
  : /Fix ONLY the Critical review findings/.test(prompt) ? 'fix-review'
  : /^Read \.pipeline\/plan\.md/.test(prompt) ? 'build'
  : 'plan';
const log = process.env.FAKE_LOG;
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ kind, args, prompt }) + '\n');
const act = (JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'))[kind] || [])[before.filter((c) => c.kind === kind).length] || {};
for (const [f, body] of Object.entries(act.writes || {})) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
for (const f of act.remove || []) fs.rmSync(f, { force: true });
if (kind === 'commit' && act.commit !== false) {
  spawnSync('git', ['add', '-A']);
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fake commit']);
}
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `fake ${kind}` }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: act.result ?? `fake ${kind} done`, total_cost_usd: 0.01 }));
