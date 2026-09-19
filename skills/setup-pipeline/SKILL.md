---
name: setup-pipeline
description: Build a clear request or the next ROADMAP milestone with an automated 4-step pipeline in the current git repo - Plan (Opus) -> Build (Sonnet) -> test gate -> Review (read-only) -> Commit (Haiku, no edit rights). Checks the request is ready first (sends vague ideas to /discover), recommends a toolkit (ponytail, agentmemory, agent-skills, superpowers) and a token profile, writes .pipeline/config.json, runs it, then merges the milestone. Use when the user says "setup-pipeline", "run the pipeline", "build the next milestone", "setup-pipeline next", or wants an automated plan-build-review-commit run.
argument-hint: "[clear request] | next"
---

Runner: `${CLAUDE_SKILL_DIR}/pipeline.mjs` (Node). One headless `claude -p` per step, with a fixed model and a **tool allowlist that enforces the role**: the planner writes only `.pipeline/plan.md`, the reviewer writes only `.pipeline/review.md` and runs read-only git, the committer has no Edit/Write. Files are the only memory between steps.

Plugin files are English; talk to the user in the language they write in. Keep each message short.

## Phase 0 - Preflight (stop and explain if any fails)
- Inside a git repo with at least one commit. If not: stop and suggest `/discover` (it creates and initializes the project).
- `node -v` and `claude --version` work.
- `git status --porcelain` is empty. If not: ask to commit or stash; never do it silently.
- Note the main branch (`main` or `master`). If the current branch is a previous `auto/...` branch, handle it first (Phase 5 merge step) before starting new work.

## Phase 1 - Pick the mode
| Situation | Mode |
|---|---|
| `SPEC.md` and `ROADMAP.md` exist at the repo root, and the argument is empty or `next` | **Milestone**: build the first milestone whose heading is `## [ ] M<n> ...`. No readiness questions: the spec is the answer. If every milestone is ticked, say the roadmap is done and offer `/discover` to extend it |
| A request was given | **Request**: run the readiness gate below |
| Neither | Ask for the request in one line |

### Readiness gate (request mode only)
Read the repo first (README, CLAUDE.md, manifest, tests, `git log --oneline -5`). The request is ready when these four are known, from the request or the repo:
1. **Outcome** - what will work afterwards.
2. **Scope** - which part of the code or product it touches, and what it leaves alone.
3. **Stack** - obvious in an existing repo; must be stated for a new one.
4. **Done criteria** - how to check it works (a test, a command, a visible behavior).

- All four known: continue.
- 1-2 missing: ask at most 3 short questions, each with a recommended answer, then continue.
- 3-4 missing, or the request is a whole product idea: stop. Say it needs a spec first and suggest `/discover <idea>`. Do not run the pipeline on a guess.

Write the answers into the `task` field as: outcome, scope, non-goals, done criteria.

## Phase 2 - Toolkit and token profile
**If `.pipeline/config.json` exists from an earlier run, offer to reuse its toolkit, models and skills** (the usual case for `next`). Ask only whether anything should change; if not, skip to Phase 3.

Otherwise collect installed toolkits (`claude plugin list` plus your available-skills list; record **exact** skill names), then ONE `AskUserQuestion` with the recommendation first:
- **Token profile**: Economy / Balanced (Recommended) / Quality.
- **Framework** (single): Light, no framework / agent-skills / superpowers, full / superpowers, partial.
- **Add-ons** (multiSelect): ponytail (with the level in the label: `ultra` for prototypes, `full` by default, `lite` for large established codebases) / agentmemory.

Recommend agent-skills for real projects that want a checkpoint per phase and security coverage; superpowers full for long autonomous quality runs; Light for small tasks. Never both agent-skills and superpowers full (two routers conflict). Mark tools not installed and give the install command; install only after the user agrees (a CLI install is picked up by the headless steps without restarting this session):

| Tool | Install |
|---|---|
| ponytail | `claude plugin marketplace add DietrichGebert/ponytail` then `claude plugin install ponytail@ponytail` |
| superpowers | `claude plugin marketplace add obra/superpowers-marketplace` then `claude plugin install superpowers@superpowers-marketplace` |
| agent-skills | `claude plugin marketplace add addyosmani/agent-skills` then `claude plugin install agent-skills@addy-agent-skills` |
| agentmemory | `claude plugin marketplace add rohitg00/agentmemory` then `claude plugin install agentmemory@agentmemory`, then start its server: `npx -y @agentmemory/agentmemory@latest` |

### Skills per step (exact installed names only; skip any that is missing)
Interactive skills (`brainstorming`, `grilling`, `interview-me`) never go into a pipeline step: nobody is there to answer them.

| Framework | Plan | Build | Review | Commit |
|---|---|---|---|---|
| Light | - | `ponytail:ponytail` if chosen | - | - |
| agent-skills | `planning-and-task-breakdown` | `incremental-implementation`, `test-driven-development` | `code-review-and-quality` | `git-workflow-and-versioning` |
| superpowers full | `superpowers:writing-plans` | `superpowers:test-driven-development`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion` | `superpowers:requesting-code-review` | - |
| superpowers partial | - | `superpowers:test-driven-development`, `superpowers:verification-before-completion` | - | - |

Adjust: auth, payments or user data in scope → add `security-and-hardening` to Review and force `pauseAfterPlan`. ponytail chosen and profile is not Quality → add `ponytail:ponytail-review` to Review. Cap skills per step by the profile; drop the least relevant first.

### Token profiles
| Profile | Plan | Build | Review | Commit | budgetUsd (plan/build/review/commit) | maxFixLoops | Max skills per step |
|---|---|---|---|---|---|---|---|
| Economy | `claude-sonnet-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | 1 / 3 / 0.5 / 0.3 | 1 | 1 |
| Balanced | `claude-opus-5` | `claude-sonnet-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` | 3 / 6 / 2 / 0.5 | 2 | 2 |
| Quality | `claude-opus-5` | `claude-sonnet-5` | `claude-opus-5` | `claude-haiku-4-5-20251001` | 5 / 10 / 4 / 0.5 | 3 | 3 |

Token hygiene you apply automatically:
- `disablePlugins`: every installed plugin the user did not choose (`name@marketplace` from `claude plugin list`; never `claude-pipeline@punssama`). The runner turns them off for its headless steps only, removing their hooks, injected context and skill listings. agentmemory usually goes here too: you use it in this session (Phase 5); the headless steps do not need it.
- `CLAUDE.md` over ~150 lines: every step loads it, so offer to trim it (commit before running).
- No test runner and the change is small: omit `testCmd` and say there is no gate. Otherwise make "set up a minimal test runner" the first item of the task.

## Phase 3 - Write `.pipeline/config.json`
```json
{
  "milestone": "M2",
  "project": "<request mode only: <= 10 lines of context the repo does not state>",
  "task": "<request mode: outcome, scope, non-goals, done criteria; milestone mode: omit>",
  "guidance": "<one line for every step, e.g. 'Ponytail level: full. Terse output. Follow CLAUDE.md.'>",
  "branch": "auto/<m2-short-slug>",
  "testCmd": "<command, or omit for no gate>",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "disablePlugins": [],
  "steps": {
    "plan":   { "model": "claude-opus-5",             "budgetUsd": 3,   "skills": [] },
    "build":  { "model": "claude-sonnet-5",           "budgetUsd": 6,   "skills": [] },
    "review": { "model": "claude-sonnet-5",           "budgetUsd": 2,   "skills": [] },
    "commit": { "model": "claude-haiku-4-5-20251001", "budgetUsd": 0.5, "skills": [] }
  }
}
```
- `milestone` (milestone mode only): the runner reads SPEC.md + ROADMAP.md, plans only that milestone, **refuses a plan that does not map every AC of the milestone to a task** (one retry, then exit 3), and has the reviewer grade against those ACs. Take `testCmd` from SPEC.md's Commands table.
- `branch` must be new (never main/master); on a rerun of the same milestone add a suffix.
- Ask the last two with one `AskUserQuestion`: **Pause after the plan?** (Yes recommended for the first milestone and for anything touching auth, payments or data) and **Push?** (No recommended until the first run has been reviewed).

Show a compact summary (mode, milestone and its ACs or the task, tools, skills per step, models, max budget = sum of budgetUsd plus Build + Review per fix loop, branch, test gate). Run only after the user says yes.

## Phase 4 - Run
```bash
node "${CLAUDE_SKILL_DIR}/pipeline.mjs" .pipeline/config.json
```
Use `run_in_background: true` (takes minutes). Do not touch the repo while it runs.

**Send the dashboard link right away.** Within a few seconds the runner prints `[pipeline] dashboard: http://127.0.0.1:<port>/#run=<id>`. Read the background output until that line appears (it is among the first lines) and give the user the link in one line, e.g. "Live progress: <link>". The dashboard is one local page for the whole machine: it lists every pipeline run from every project, shows each step's state, elapsed time, real cost against the cap, test/review rounds, Critical review findings, plan.md/review.md, and a live feed of every tool call. It picks a free port itself (from 3120 up) and stays up while any Claude Code session is open. If no dashboard line appears, the run continues without it; say so and move on.

Then wait for the completion notification and read the rest of the output.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Committed (pushed if enabled) | Phase 5 |
| 10 | Paused after plan | Show `.pipeline/plan.md` briefly; on approval rerun with `--from build`; on changes, edit plan.md with the user first |
| 3 | Plan does not cover the milestone's ACs | Show the missing IDs; usually the AC is too big or unclear: fix SPEC/ROADMAP with the user (or split the milestone), commit, rerun |
| 2 | Review/tests still failing; **nothing committed** | Show the Critical items from `.pipeline/review.md` and the failing test output; offer: fix manually, raise `maxFixLoops`, or rerun `--from build` |
| 1 | Error | Show the last lines and the newest `.pipeline/logs/*.log`; do not retry blindly |

## Phase 5 - Merge and report
- Report: branch, commit hash, test/review rounds, push status.
- **Milestone mode**: ask to merge into the main branch. On yes: `git switch <main>`, `git merge --no-ff <auto-branch>`, tick the milestone in ROADMAP.md (`## [ ]` → `## [x]`), commit `docs: complete M<n>`. Push the main branch only if push is enabled, a remote exists and the user confirms. If the user prefers a PR instead (remote exists), push the auto branch and open one with `gh pr create` if `gh` is available.
- **Request mode**: offer the same merge, or leave the branch for the user to review.
- If agentmemory tools are available: `memory_save` one entry (milestone or task, profile and toolkit, outcome, any gotcha with its reason). If the user corrected your setup choices, save a lesson (`memory_lesson_save`).
- Milestone mode: tell the user the next step: `/setup-pipeline next` builds the next unticked milestone with the same toolkit.

## Rules
- Never edit product code, commit or push yourself before the runner finishes; the pipeline owns those steps. Phase 5 merges, ROADMAP ticks and setup files (CLAUDE.md trims) are yours, with consent.
- Never force-push. Never run the pipeline on main/master. Report failures with their real output; never claim success without exit code 0.
- Resume points: `--from build`, `--from review`, `--from commit` (state lives in `.pipeline/`).
- On Windows the runner allows both `Bash` and `PowerShell` rules (headless sessions may expose either); on macOS/Linux only `Bash`.
- Run history lives in `~/.claude-pipeline/runs/` (override with `CLAUDE_PIPELINE_HOME`). If the user asks for the dashboard later, run `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" --dashboard` to start or find it, and give them the printed link.
