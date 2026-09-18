---
name: setup-pipeline
description: Set up and run an automated 4-step pipeline in the current git repo - Plan (Opus) -> Build (Sonnet) -> Review (read-only) -> Commit+push (Haiku, no edit rights). First interviews the user about the project (description, scale, token priority, risk), recommends a toolkit (ponytail, agentmemory, agent-skills, partly/fully superpowers), prepares the repo for it, writes .pipeline/config.json, then runs it. Use when the user says "setup-pipeline", "chạy pipeline", "plan build review commit tự động", or wants a multi-model automated dev workflow.
argument-hint: "[what to build]"
---

Runner: `${CLAUDE_SKILL_DIR}/pipeline.mjs` (Node). It launches one headless `claude -p` per step with a fixed model and a **tool allowlist that enforces the role** (planner writes only `.pipeline/plan.md`; reviewer writes only `.pipeline/review.md` and runs read-only git; committer has no Edit/Write). Files in `.pipeline/` are the only memory between steps.

Four goals drive every phase below: (1) you understand the user's project, (2) the user picks tools that fit it, (3) tokens are spent only where they buy quality, (4) setup matches the project's actual state. Talk to the user in their language. Keep each message short.

## Phase 0 - Preflight (stop and explain if any fails)
- `git rev-parse --show-toplevel` succeeds. If not: offer `git init` + an initial commit (ask first).
- `node -v` and `claude --version` work.
- `git status --porcelain` is empty. If not: ask to commit or stash (never do it silently).

## Phase 1 - Learn the project yourself first (no questions yet)
Questions cost the user's time; reading costs a few tool calls. Gather, in parallel:
- `README*`, `CLAUDE.md` / `AGENTS.md` (note line count), the package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, ...).
- `git ls-files | wc -l`, `git log --oneline -5` (new repo or established?).
- Test runner: `scripts.test`, `pytest` config, `go test`, `cargo test`, or none.
- Installed toolkits: `claude plugin list` plus your own available-skills list. Record the **exact** skill names (plugin skills are prefixed, e.g. `superpowers:writing-plans`; agent-skills may appear unprefixed if installed as loose skills, or as `agent-skills:<name>`).
- If agentmemory tools are available: `memory_smart_search` with the repo name and the task → prior decisions and lessons.

Summarize what you found in 3-5 lines (stack, size, tests, notable conventions, relevant memories). The user corrects it if wrong.

## Phase 2 - Intake
If `$ARGUMENTS` is empty, ask in plain chat for a 1-3 sentence description of what to build (free text; do not use a picker for this).

Then ONE `AskUserQuestion` call, 4 single-select questions. Put your best guess from Phase 1 first with "(Recommended)":
1. **Quy mô / Scale** - Nhỏ: 1-2 files, one small change / Vừa: one feature, several files / Lớn: several features or modules.
2. **Ưu tiên token / Token priority** - Tiết kiệm tối đa / Cân bằng / Chất lượng tối đa.
3. **Rủi ro / Risk** - Thấp (prototype, throwaway) / Trung bình (real project) / Cao (auth, payments, user data, production).
4. **Dự án kéo dài nhiều phiên? / Multi-session?** - Có, sẽ làm tiếp nhiều lần / Không, làm một lần.

## Phase 3 - Recommend a toolkit, let the user choose
Compute a recommendation from the table, then show it as a short table with a one-line reason per tool and mark each tool installed / not installed.

| Tool | Recommend when | Role in the pipeline |
|---|---|---|
| **ponytail** | Almost always. Level: `ultra` for small/prototype, `full` default, `lite` for large established codebases | Less code and less prose in every step = fewer output tokens. Goes in `guidance` + `ponytail:ponytail` on Build |
| **agentmemory** | Multi-session = yes, or established repo | You recall before (Phase 1) and save the outcome after (Phase 6). Headless steps do not need it: add `agentmemory@agentmemory` to `disablePlugins` to save their hook/injection tokens unless the user wants the runs captured |
| **agent-skills** (addyosmani) | Scale Vừa/Lớn, risk Trung bình/Cao, wants a checkpoint per phase and security/perf coverage | Framework option A |
| **superpowers - partly** | Wants superpowers' TDD and verification discipline without its full process | Cherry-pick 1-2 superpowers skills into Build |
| **superpowers - fully** | Scale Lớn, quality priority, a long autonomous run is wanted | Framework option B |

Framework = at most ONE of agent-skills / fully-superpowers (two routers fight over commands and TDD philosophy). ponytail, agentmemory and partly-superpowers combine with either.

Then ONE `AskUserQuestion` call:
- Q1 (single-select) **Khung / Framework**: Nhẹ, không khung / agent-skills / superpowers đầy đủ / superpowers một phần. Recommended first.
- Q2 (multiSelect) **Công cụ đi kèm / Add-ons**: ponytail (with the chosen level in the label) / agentmemory.

If a chosen tool is not installed: show the install command and ask before running it. Headless steps start fresh, so a CLI install is picked up by the pipeline without restarting this session.

| Tool | Install |
|---|---|
| ponytail | `claude plugin marketplace add DietrichGebert/ponytail` then `claude plugin install ponytail@ponytail` |
| superpowers | `claude plugin marketplace add obra/superpowers-marketplace` then `claude plugin install superpowers@superpowers-marketplace` |
| agent-skills | `claude plugin marketplace add addyosmani/agent-skills` then `claude plugin install agent-skills@addy-agent-skills` |
| agentmemory | `claude plugin marketplace add rohitg00/agentmemory` then `claude plugin install agentmemory@agentmemory`, then start its server with `npx -y @agentmemory/agentmemory@latest` |

### Skills per step (use the exact names you recorded in Phase 1; skip any that is not installed)
Interactive skills (`brainstorming`, `grilling`, `interview-me`) must NEVER go into a pipeline step: nobody is there to answer. They belong in Phase 4, which runs here, with the user.

| Framework | Phase 4 (here, interactive) | Plan | Build | Review | Commit |
|---|---|---|---|---|---|
| Light | a few direct questions | - | `ponytail:ponytail` if chosen | - | - |
| agent-skills | `interview-me`, then `spec-driven-development` if Vừa/Lớn | `planning-and-task-breakdown` | `incremental-implementation`, `test-driven-development` | `code-review-and-quality` | `git-workflow-and-versioning` |
| superpowers full | `superpowers:brainstorming` | `superpowers:writing-plans` | `superpowers:test-driven-development`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion` | `superpowers:requesting-code-review` | - |
| superpowers partly | a few direct questions | - | add `superpowers:test-driven-development`, `superpowers:verification-before-completion` | - | - |

Adjust by answers:
- Risk Cao: add `security-and-hardening` to Review (and `doubt-driven-development` to Plan if agent-skills), force `pauseAfterPlan: true`.
- ponytail chosen: add `ponytail:ponytail-review` to Review when priority is not "Chất lượng tối đa".
- Cap skills per step by the token profile below; drop the least relevant first. Each loaded skill costs context in that step.

## Phase 4 - Pin the task down and prepare the repo
Clarify with the Phase 4 tool from the table until the task has: an outcome, a scope, explicit non-goals, and "done" criteria. Headless steps cannot ask, so a vague task means wasted runs.

Then make the setup match the project:
- **Scale Lớn**: split into 2-5 independent sub-tasks. Run the pipeline once per sub-task (each on its own `auto/...` branch). Ask which goes first; write only that one's config.
- **No `CLAUDE.md`, or one over ~150 lines**: every headless step loads it, so each extra line is paid 4+ times per run. Offer a short one (stack, commands, conventions, no-go zones; under ~40 lines), or to trim the existing one. Create it only on yes, and commit it before running (the tree must be clean).
- **No test runner**: Nhỏ → no test gate (`testCmd` omitted) and say so. Otherwise add "set up a minimal test runner" as the first item of the task, and use the runner's command as `testCmd`.
- **Established repo, area to change has no tests**: add "write characterization tests for the touched behavior before changing it" to the task.
- **New repo**: add "create the minimal project skeleton" to the task.

## Phase 5 - Write `.pipeline/config.json`
Pick the token profile from the Phase 2 answer:

| Profile | Plan | Build | Review | Commit | budgetUsd (plan/build/review/commit) | maxFixLoops | Max skills per step |
|---|---|---|---|---|---|---|---|
| Tiết kiệm | `claude-sonnet-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | 1 / 3 / 0.5 / 0.3 | 1 | 1 |
| Cân bằng | `claude-opus-5` | `claude-sonnet-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` | 3 / 6 / 2 / 0.5 | 2 | 2 |
| Chất lượng | `claude-opus-5` | `claude-sonnet-5` | `claude-opus-5` | `claude-haiku-4-5-20251001` | 5 / 10 / 4 / 0.5 | 3 | 3 |

```json
{
  "project": "<= 10 lines: what the project is, stack, conventions, constraints, relevant memories from Phase 1>",
  "task": "<the pinned-down task from Phase 4: outcome, scope, non-goals, done criteria>",
  "guidance": "<one line applied to every step, e.g. 'Ponytail level: full. Terse output. Follow CLAUDE.md.'>",
  "branch": "auto/<short-slug>",
  "testCmd": "<cmd, or omit for no gate>",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "disablePlugins": ["<installed plugins NOT chosen, e.g. superpowers@superpowers-marketplace>"],
  "steps": {
    "plan":   { "model": "claude-opus-5",             "budgetUsd": 3,   "skills": [] },
    "build":  { "model": "claude-sonnet-5",           "budgetUsd": 6,   "skills": [] },
    "review": { "model": "claude-sonnet-5",           "budgetUsd": 2,   "skills": [] },
    "commit": { "model": "claude-haiku-4-5-20251001", "budgetUsd": 0.5, "skills": [] }
  }
}
```
- `project` goes only into the Plan prompt (plan.md carries it forward); `guidance` goes into every step. Keep both short: they are paid on every run.
- `disablePlugins`: list every installed plugin (`name@marketplace` from `claude plugin list`) the user did not choose. The runner turns them off for its headless steps only, which removes their hooks, injected context and skill listings. Never list `claude-pipeline@punssama` itself.
- Ask the last two with one `AskUserQuestion` (2 questions): **Pause after plan?** (Yes recommended for first runs and for Risk Cao) and **Push the branch?** (No recommended until the first run is reviewed).

Before running, show a compact summary: tools chosen, skills per step, models, the max total budget (sum of budgetUsd; each fix loop adds Build + Review), branch, test gate. Run only after the user says yes.

## Phase 6 - Run and report
```bash
node "${CLAUDE_SKILL_DIR}/pipeline.mjs" .pipeline/config.json
```
Use `run_in_background: true` (takes minutes) and read the output when notified. Do not touch the repo while it runs.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Committed (and pushed if enabled) | Report branch, commit hash, push status, test/review rounds |
| 10 | Paused after plan | Show `.pipeline/plan.md` briefly; on approval re-run with `--from build`; on changes, edit plan.md with the user first |
| 2 | Review/tests still failing; **nothing committed** | Show the Critical items from `.pipeline/review.md` and the failing test output; offer: fix manually, raise `maxFixLoops`, or re-run `--from build` |
| 1 | Error | Show the last lines and the newest `.pipeline/logs/*.log`; do not retry blindly |

If agentmemory was chosen: after exit 0 or 2, `memory_save` one entry: the task, the toolkit/profile used, the outcome, and any gotcha (with the reason). If the user corrected your setup choices, save that as a lesson (`memory_lesson_save`).

For a split Lớn task, after exit 0 offer to start the next sub-task (back to Phase 5 with the same toolkit).

## Rules
- Never edit code, commit, or push yourself during Phase 6; the pipeline owns those steps. (Phase 4 setup files like `CLAUDE.md` are fine, with consent.)
- Never force-push and never target main/master. Report failures with their real output; never claim success unless exit code 0.
- Resume points: `--from build`, `--from review`, `--from commit` (state lives in `.pipeline/`).
- On Windows the runner allows both `Bash` and `PowerShell` rules (headless sessions may expose either); on macOS/Linux only `Bash`.
