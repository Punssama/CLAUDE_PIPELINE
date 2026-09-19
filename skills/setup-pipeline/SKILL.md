---
name: setup-pipeline
description: Build a clear request or the next ROADMAP milestone with an automated 4-step pipeline in the current project folder (local git optional, GitHub never required) - Plan (Opus) -> Build (Sonnet) -> test gate -> Review (read-only) -> Commit (Haiku, no edit rights). Checks the request is ready first (sends vague ideas to /discover), recommends a toolkit (ponytail, agentmemory, agent-skills, superpowers) and a token profile, writes .pipeline/config.json, runs it, then merges the milestone. Use when the user says "setup-pipeline", "run the pipeline", "build the next milestone", "setup-pipeline next", or wants an automated plan-build-review-commit run.
argument-hint: "[clear request] | next"
---

Runner: `${CLAUDE_SKILL_DIR}/pipeline.mjs` (Node). One headless `claude -p` per step, with a fixed model and a **tool allowlist that enforces the role**: the planner writes only `.pipeline/plan.md`, the reviewer writes only `.pipeline/review.md` and runs read-only git, the committer has no Edit/Write. Files are the only memory between steps.

Plugin files are English; talk to the user in the language they write in. Keep each message short.

**Works with any local folder.** Git is optional and always local: no GitHub account, remote or push is ever required (push is off unless the user asks). With git, each run gets its own branch; without git (`vcs: "none"`), changes go straight into the folder and the runner keeps a private undo history in `.pipeline/`. **Not wanting git or GitHub is never a reason to skip the pipeline or write the code yourself**: switch to `vcs: "none"` instead.

**Asking questions.** Use `AskUserQuestion` with small, plain inputs: 1-4 questions per call, 2-4 options per question (never add an "Other" option: the picker adds one), a `header` of at most 12 characters, short labels, and the details in `description`. Keep file paths, backslashes and double quotes out of labels and question text. Ask one question per call whenever the text is long. If a call fails validation, retry once with simpler text; if it fails again, ask the same thing in plain chat as a numbered list and let the user answer with a number.

## Phase 0 - Get the repo ready (never dead-end)
**Rule: a blocker is a question, not a stop.** For every problem below, say in one line what you found, offer the fixes with the recommended one first (`AskUserQuestion`), and carry out the chosen fix yourself. Stop only if the user declines every option. Run all git and runner commands inside the project root (`cd "<root>" && ...`).

Check, in this order:
1. **Tools** - `node -v`, `git --version`, `claude --version`. The only hard stop: say what to install (README's Install section) if one is missing.
2. **Which project?**
   - Inside a git repo: use its root.
   - In a folder without git (with or without code): offer
     - *Use a local git repo* (Recommended for developers who use git): `git init` + commit what is there as `chore: baseline`. Local only; nothing is uploaded.
     - *No git, work directly in this folder*: set `"vcs": "none"`. Changes land in the folder, a private history in `.pipeline/` gives one-command undo, and the Commit step is skipped (cheaper).
     - *Pick another folder*.
   - In a home, desktop or downloads folder, or an empty one: list the projects this machine has run the pipeline on (the `cwd` of each `~/.claude-pipeline/runs/*.json`, newest first, plus any path the user mentions) and ask which one. If it is a brand-new idea, hand off to `/discover`.
   - A repo with no commits: offer to commit what is there as the baseline, or `vcs: "none"`.
   - Steps 3-4 below only apply with git.
3. **Uncommitted changes** (`git status --porcelain`) - offer: commit them as `chore: wip before pipeline` (Recommended when they look intentional) / stash them (`git stash -u`, tell the user how to restore) / let the user handle it. Never discard anything.
4. **Left on a previous `auto/...` branch** - look at what that run did (`git log --oneline <main>..HEAD`, the verdict line of `.pipeline/review.md`, the newest `~/.claude-pipeline/runs` record for this repo if any) and offer:
   - *Merge it into `<main>` and continue* (Recommended when its last run committed and review passed): the Phase 5 merge, then continue from `<main>`.
   - *Continue that run* (it ended paused or failed): rerun with `--from build` or `--from review` on the same branch.
   - *Keep it for later and start from `<main>`*: `git switch <main>`; the branch stays untouched.
   - *Delete it*: only after showing its commits and getting an explicit yes (`git branch -D`).
5. **Main branch** - `main` or `master`, whichever exists. If neither, use the branch the repo was on before any `auto/...` work.

## Phase 1 - Pick the mode
| Situation | Mode |
|---|---|
| `SPEC.md` and `ROADMAP.md` exist at the repo root, and the argument is empty or `next` | **Milestone**: build the first milestone whose heading is `## [ ] M<n> ...`. No readiness questions: the spec is the answer |
| Every milestone is ticked | Say the roadmap is done; offer: describe the next change (request mode) / extend the roadmap with `/discover` |
| A request was given | **Request**: run the readiness gate below |
| `next` or no argument, but no ROADMAP | Do not stop. Read the repo and the last pipeline run, then offer at most 4 options: 2-3 sensible next changes plus "Plan several steps with /discover" as the last one (the picker adds "Other" for a free-text change by itself). A picked suggestion goes through the readiness gate as a request |

### Readiness gate (request mode only)
Read the repo first (README, CLAUDE.md, manifest, tests, `git log --oneline -5`). The request is ready when these four are known, from the request or the repo:
1. **Outcome** - what will work afterwards.
2. **Scope** - which part of the code or product it touches, and what it leaves alone.
3. **Stack** - obvious in an existing repo; must be stated for a new one.
4. **Done criteria** - how to check it works (a test, a command, a visible behavior).

- All four known: continue.
- 1-2 missing: ask at most 3 short questions, each with a recommended answer, then continue.
- 3-4 missing, or the request is a whole product idea: do not run the pipeline on a guess. Offer: run `/discover` now with this idea (Recommended; it keeps the idea as its starting point) / answer a few more questions here instead.

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
  "vcs": "git",
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
- `branch` must be new (never main/master); on a rerun of the same milestone add a suffix. Omit it with `"vcs": "none"`.
- `"vcs": "none"`: no branches and no commit step; the runner snapshots the folder before building (undo point) and after. Undo the last run with `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" .pipeline/config.json --undo`: it restores every file to the pre-run state, so edits made after the run are lost too; confirm with the user first.
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
- **`vcs: "none"`**: nothing to merge. Show the changed-files summary the runner printed and the undo command; in milestone mode tick the milestone in ROADMAP.md directly.
- If agentmemory tools are available: `memory_save` one entry (milestone or task, profile and toolkit, outcome, any gotcha with its reason). If the user corrected your setup choices, save a lesson (`memory_lesson_save`).
- Milestone mode: tell the user the next step: `/setup-pipeline next` builds the next unticked milestone with the same toolkit.

## Rules
- Never edit product code, commit or push yourself before the runner finishes; the pipeline owns those steps. Phase 0 fixes (baseline/wip commits, stash, branch switch, merging a previous run), Phase 5 merges, ROADMAP ticks and setup files (CLAUDE.md trims) are yours, with consent.
- Never force-push. Never run the pipeline on main/master. Report failures with their real output; never claim success without exit code 0.
- Resume points: `--from build`, `--from review`, `--from commit` (state lives in `.pipeline/`).
- On Windows the runner allows both `Bash` and `PowerShell` rules (headless sessions may expose either); on macOS/Linux only `Bash`.
- Run history lives in `~/.claude-pipeline/runs/` (override with `CLAUDE_PIPELINE_HOME`). If the user asks for the dashboard later, run `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" --dashboard` to start or find it, and give them the printed link.
