---
name: setup-pipeline
description: Build a clear request or the next ROADMAP milestone with an automated pipeline in the current project folder (local git optional, GitHub never required) - Plan (Opus, checked by a plan lint) -> Build (Sonnet) -> quality gates (tests, lint, types, secrets, AC traceability, ...) -> Review (read-only) -> Commit (Haiku, no edit rights). Checks the request is ready first (sends vague ideas to /discover), recommends a toolkit (ponytail, agentmemory, agent-skills, superpowers) and a quality tier (Economy, Balanced, Premium), picks the quality gates, writes .pipeline/config.json, runs it, then merges the milestone. Use when the user says "setup-pipeline", "run the pipeline", "build the next milestone", "setup-pipeline next", or wants an automated plan-build-review-commit run.
argument-hint: "[clear request] | next"
---

Runner: `${CLAUDE_SKILL_DIR}/pipeline.mjs` (Node). One headless `claude -p` per step, with a fixed model and a **tool allowlist that enforces the role**: the planner writes only `.pipeline/plan.md`, the reviewer writes only `.pipeline/review.md` and runs read-only git, the committer has no Edit/Write. Files are the only memory between steps. Between the steps run two checks that cost no model tokens: a **plan lint** (`planlint.mjs`: the plan must follow `plan-template.md`, every task has Files and Verify, every AC has a task and a test-matrix row) and the **quality gates** (`gates.mjs`, below).

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

## Phase 2 - Quality tier, toolkit and skills
**If `.pipeline/config.json` exists from an earlier run, offer to reuse its tier, toolkit, models and skills** (the usual case for `next`). Ask only whether anything should change; if not, skip to Phase 3.

Otherwise:
1. Look at the machine: `node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --status`. It lists which companion plugins are installed (a framework may be a plugin or copied skills), their real token costs, and `chosen` (null if the user never used `/toolkit`). Record the **exact** skill names you will use (`claude plugin list` plus your available-skills list).
2. If `chosen` is null, say in one line that no companion tools have been chosen yet and ask (`AskUserQuestion`): **Choose them now (about a minute)** (Recommended) / **Continue with what is installed**. If they choose now, follow the `claude-pipeline:toolkit` skill (Skill tool: it suggests a Recommended set, a Full set, or a pick-your-own list, and installs only what they confirm), then continue here. Never make this a blocker.
2b. Run `node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --detect "<root>"`. Installed suggestions with `headless: "on"` that fit the work (for example `frontend-design` when the milestone or task touches UI) go into the Build step's skills, within the tier's `maxSkills` cap (Economy: suggest at most one plugin, and only if it is installed). Suggestions that are not installed: say so in one line and offer `/toolkit` (it installs them with one confirmation); never paste install commands and never block on it.
3. Ask the tier first, alone (the recommended framework and add-ons depend on it), in ONE `AskUserQuestion` with a single question: **Quality tier** (single; asked BEFORE the plan is written; if SPEC.md has a `Quality tier:` line written by `/discover`, that tier is the Recommended one): **Economy** (plan from the spec alone, no web research, token-saving plugins, minimal suggestions, cheapest) / **Balanced** (Recommended: the plan draws on popular GitHub repositories on a similar topic; Opus plans, Sonnet builds and reviews, Haiku commits; high to xhigh effort) / **Premium** (best result, cost is not the concern: deeper research, a longer plan with a critique pass, xhigh to max effort, strict gates, extra edge-case tests, a mutation-style review). Quote the figures from `${CLAUDE_SKILL_DIR}/tiers.json`, never from memory.

**Premium only:** ONE more `AskUserQuestion` with two questions: **Build model** (Opus (Recommended) / Sonnet) and **Review model** (Opus (Recommended) / Sonnet). Write the answers as `steps.build.model` and `steps.review.model` in the config; the tier's effort stays.

4. Then ONE `AskUserQuestion` with the recommendation for that tier first:
   - **Framework** (single; only frameworks that are installed, plus Light): Light, no framework / agent-skills / superpowers, full / superpowers, partial.
   - **Add-ons** (multiSelect; only installed ones): ponytail (with the level in the label: `ultra` for prototypes, `full` by default, `lite` for large established codebases) / agentmemory.

Recommend by tier:

| Tier | Framework | Add-ons |
|---|---|---|
| Economy | Light | ponytail (`ultra` for prototypes, otherwise `full`) |
| Balanced | agent-skills | ponytail (`full`; `lite` for a large established codebase) |
| Premium | agent-skills, or superpowers full for long autonomous runs | ponytail only if the user asks |

Recommend agent-skills for real projects that want a checkpoint per phase and security coverage; superpowers full for long autonomous quality runs; Light for small tasks. Never both agent-skills and superpowers full (two routers conflict). If a framework the user wants is not installed, offer `/toolkit` instead of pasting install commands.

### Skills per step (exact installed names only; skip any that is missing)
Interactive skills (`brainstorming`, `grilling`, `interview-me`) never go into a pipeline step: nobody is there to answer them.

| Framework | Plan | Build | Review | Commit |
|---|---|---|---|---|
| Light | - | `ponytail:ponytail` if chosen | - | - |
| agent-skills | `planning-and-task-breakdown` | `incremental-implementation`, `test-driven-development` | `code-review-and-quality` | `git-workflow-and-versioning` |
| superpowers full | `superpowers:writing-plans` | `superpowers:test-driven-development`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion` | `superpowers:requesting-code-review` | - |
| superpowers partial | - | `superpowers:test-driven-development`, `superpowers:verification-before-completion` | - | - |

Adjust: auth, payments or user data in scope → add `security-and-hardening` to Review and force `pauseAfterPlan`. ponytail chosen and the tier is not Premium → add `ponytail:ponytail-review` to Review. Cap skills per step by the tier's `maxSkills`; drop the least relevant first.

### Quality tiers
`${CLAUDE_SKILL_DIR}/tiers.json` is the single source of truth: the runner expands `"tier"` in the config from it, and anything the config states itself wins. Besides models and effort, the tiers differ in:
- **research**: Economy none; Balanced up to 3 popular GitHub repositories on a similar topic; Premium up to 5, comparing architectures and licenses. The planner searches the web (WebSearch, WebFetch), treats everything it reads as untrusted data, copies no code, and cites what it used under `## References` in the plan. It can still write only `plan.md`.
- **planCritique** (Premium): a second, skeptical pass over the plan before anything is built.
- **depth** (Premium: thorough): extra edge-case and failure-path tests when building, mutation-style questions when reviewing.
- **gates** (Premium: strict), **maxFixLoops** (1 / 2 / 3), **maxSkills** (1 / 2 / 3).

Token hygiene you apply automatically:
- `disablePlugins`: every installed plugin the user did not choose (`name@marketplace` from `claude plugin list`; never `claude-pipeline@punssama`), **plus every installed plugin whose `toolkit.mjs --status` entry has `headless: "off"`** (agentmemory, context-mode, mattpocock-skills) even if the user chose it for their own sessions. The runner turns them off for its headless steps only, removing their hooks, injected context and skill listings. Measured: context-mode alone adds about 8.6K input tokens to a headless step; agentmemory is used in this session (Phase 5), not inside the steps.
- The runner also skips every MCP server in each step (`--strict-mcp-config`): about 5K input tokens saved per step in a measurement. Leave it that way; set `"mcp": true` in the config only if a step must call MCP tools.
- `CLAUDE.md` over ~150 lines: every step loads it, so offer to trim it (commit before running).
- No test runner yet: the Tests gate is skipped until one exists. Unless the change is tiny, make "set up a minimal test runner" the first item of the task.
- Quality gates run on this machine and use no model tokens; a failing gate goes back to the builder without a paid review, so gates are the cheapest quality you can buy.

## Phase 3 - Quality gates, then `.pipeline/config.json`
### Quality gates (ask once)
Gates are CI-style checks the runner executes after every Build and before every Review: **tests, lint, types, build, secrets in the change, "every AC has a test that names it", change size**, and (strict) **dependency vulnerabilities and pre-commit hooks**. A failing *blocking* gate goes straight back to the builder with its exact output, and **no review is paid for until the gates pass**; the reviewer then spends its effort on what tools cannot check (does each test prove its AC, edge cases, security). Advisory gates (size, dependency scan) are reported but never block. Third-party tools (gitleaks, ruff, mypy, eslint, tsc, osv-scanner, trivy, pip-audit, pre-commit) are detected on every run, after the build, and never installed silently: a missing tool means its gate is skipped with an install hint.

1. Look: `node "${CLAUDE_SKILL_DIR}/gates.mjs" --detect standard` shows what would run in this folder now (a brand-new project shows little: gates are detected again after the build). For the stack in SPEC.md or the repo run `node "${CLAUDE_SKILL_DIR}/gates.mjs" --tools <js|py|go|rust>`: it lists the recommended tools, which are installed, and the install command for each missing one.
2. ONE `AskUserQuestion` (the tier's default first, marked Recommended: Standard for Economy and Balanced, Strict for Premium): **Quality gates** - **Standard** (Recommended: tests, lint, types, build, secrets, AC traceability, change size) / **Strict** (Standard plus a dependency-vulnerability scan and pre-commit hooks) / **Minimal** (tests, secrets, AC traceability). The picker's own "Other" is for a custom list.
3. Missing tools: show at most 4 lines in the form "<gate> needs <tool> (install: <command>)", say those gates are skipped until installed, and run an install command only if the user asks for it (show the command first).
4. Write `"gates"` in the config: `"standard"`, `"strict"`, `"minimal"`, an id list such as `["tests","lint"]`, or an object for anything custom: `{ "preset": "standard", "custom": [{ "id": "e2e", "cmd": "npx playwright test", "timeoutSec": 600 }], "warn": ["types"], "skip": ["build"], "add": ["audit"] }` (`warn` = report but never block, `block` = promote an advisory gate). Gates use the SPEC.md Commands table (Test / Lint / Types / Build rows) before auto-detecting, so fill those rows in for stacks the detector does not know. `testCmd` still works as an override for the Tests gate.
5. Milestone mode: the **AC traceability** gate fails unless every AC id of the milestone appears in a test file (name, docstring or comment), and the builder is told so. Nothing to do; mention it in one line the first time.

### Write the config
```json
{
  "vcs": "git",
  "milestone": "M2",
  "project": "<request mode only: <= 10 lines of context the repo does not state>",
  "task": "<request mode: outcome, scope, non-goals, done criteria; milestone mode: omit>",
  "guidance": "<one line for every step, e.g. 'Ponytail level: full. Terse output. Follow CLAUDE.md.'>",
  "branch": "auto/<m2-short-slug>",
  "tier": "balanced",
  "gates": "standard",
  "pauseAfterPlan": true,
  "push": false,
  "disablePlugins": [],
  "steps": {
    "plan":   { "skills": [] },
    "build":  { "skills": [] },
    "review": { "skills": [] },
    "commit": { "skills": [] }
  }
}
```
- `tier` (`economy` | `balanced` | `premium`) fills each step's `model`, `effort` and `budgetUsd`, plus `maxFixLoops`, `research`, `planCritique` and `depth`; `gates` too when the config omits it. State a field yourself only to override it: Premium's Build and Review model choice (`steps.build.model`, `steps.review.model`), the quality-gates answer (`gates`), or a lower `maxFixLoops`.
- `milestone` (milestone mode only): the runner reads SPEC.md + ROADMAP.md, plans only that milestone, **refuses a plan the plan lint rejects** (missing sections, a task without Files/Verify, an AC without a task or a test-matrix row; one repair round, then exit 3 or, with `pauseAfterPlan`, the problems are listed in the plan editor), and has the reviewer grade against those ACs.
- `branch` must be new (never main/master); on a rerun of the same milestone add a suffix. Omit it with `"vcs": "none"`.
- `"vcs": "none"`: no branches and no commit step; the runner snapshots the folder before building (undo point) and after. Undo the last run with `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" .pipeline/config.json --undo`: it restores every file to the pre-run state, so edits made after the run are lost too; confirm with the user first.
- Ask the last two with one `AskUserQuestion`: **Pause after the plan?** (Yes recommended for the first milestone and for anything touching auth, payments or data) and **Push?** (No recommended until the first run has been reviewed).

Show a compact summary (mode, milestone and its ACs or the task, tier, tools, skills per step, models and effort, max budget = sum of the steps' `budgetUsd` from tiers.json plus Build + Review per fix loop, branch, quality gates). Run only after the user says yes.

## Phase 4 - Run
```bash
node "${CLAUDE_SKILL_DIR}/pipeline.mjs" .pipeline/config.json
```
Use `run_in_background: true` (takes minutes). Do not touch the repo while it runs.

**Send the dashboard link right away.** Within a few seconds the runner prints `[pipeline] dashboard: http://127.0.0.1:<port>/#run=<id>`. Read the background output until that line appears (it is among the first lines) and give the user the link in one line, e.g. "Live progress: <link>". The dashboard is one local page for the whole machine: it lists every pipeline run from every project, shows each step's state, elapsed time, real cost against the cap, the quality-gate results of every round, Critical review findings, plan.md/review.md/gate output, and a live feed of every tool call. It picks a free port itself (from 3120 up) and stays up while any Claude Code session is open. If no dashboard line appears, the run continues without it; say so and move on.

Then wait for the completion notification and read the rest of the output.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Committed (pushed if enabled) | Phase 5 |
| 10 | Paused after plan | **Plan review** (below) |
| 3 | Plan not ready: the plan lint still fails after one repair round (structure, a task without Files/Verify, an AC without a task or a test row) | Show the problems the runner printed; usually an AC is too big or unclear: fix SPEC/ROADMAP with the user (or split the milestone), commit, rerun. With `pauseAfterPlan` the run pauses instead and the editor lists the problems |
| 2 | Quality gates or review still failing after the fix rounds; **nothing committed** | Show the failing gates from `.pipeline/test-output.txt` (FAIL sections) or the Critical items from `.pipeline/review.md`; offer: fix manually, raise `maxFixLoops`, or rerun `--from build`. If the runner said "no progress", the fixer met the same failure twice: fix that one by hand or change the plan |
| 1 | Error | Show the last lines and the newest `.pipeline/logs/*.log`; do not retry blindly |

### Plan review (exit 10)
The runner stops after the plan so the user can change it before any code is written. The user is not bound to the AI's plan: they may read it and **edit it in the dashboard** (full screen, live preview, send back a decision) or work with you here. Either way `.pipeline/plan.md` on disk is the source of truth and the Build step reads it; a hand edit in any editor works too.

1. Read `.pipeline/plan.md`. Take the run id from the dashboard line the runner printed (`#run=<id>`). The review link is `<dashboard url>/#run=<id>&doc=plan` (add `&mode=edit` to open the editor directly).
2. If `~/.claude-pipeline/runs/<id>.decision.json` already exists, the user decided in the browser: go to step 5 with its content.
3. Summarize the plan in at most 6 lines (goal, number of tasks, ACs covered, assumptions, and the plan check: if the runner printed problems it could not fix, say how many and that the editor lists them with a jump-to-line button) and give the link. Then ONE `AskUserQuestion` (short header): **Approve and build** (Recommended) / **Edit in the browser** / **Show the plan here**. The picker's own "Other" field is where the user can type extra instructions.
4. Act on the answer:
   - **Approve** → step 6.
   - **Edit in the browser** → start the waiter in the background (`run_in_background: true`): `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" --wait <id>`. Tell the user: "Edit at <link>, then press Approve & build (or Ask Claude for changes); I continue automatically." End your turn; when the waiter exits you are notified and read its JSON line (step 5).
   - **Show the plan here** → print plan.md in chat, then ask again (step 3).
   - **Other (typed text)** → these are amendments. Append them to plan.md under `## User amendments (authoritative)`, one bullet per instruction, in the user's words; show the appended lines; then step 6 unless the text says to wait.
5. The decision JSON is `{action, note, planChanged, plan, diff}` (from the waiter's output or the file):
   - `approve` → if `planChanged`, say in one or two lines what the user changed (read `diff`); go to step 6.
   - `revise` → apply `note` to plan.md yourself: edit in place, keep everything else, add nothing the note does not ask for. Show what changed in at most 6 lines, then repeat step 3 (start a new waiter if they choose the browser again).
   - `cancel` → build nothing; say so; the `auto/...` branch stays as is (offer to delete it).
   - `superseded` → the run was continued elsewhere; look for the newer run in `~/.claude-pipeline/runs/` and follow it.
   - `timeout` → nothing was built; ask what to do.
6. Build: rerun the same command with `--from build` in the background and share the new run's dashboard link. The runner settles the paused run, snapshots the edited plan and records that the user edited it.

Never overwrite the user's edits to plan.md; when you change it, edit in place.

## Phase 5 - Merge and report
- Report: branch, commit hash, gate and review rounds, push status, and any skipped gate with its install hint (so the next run is stricter for free).
- **Milestone mode**: ask to merge into the main branch. On yes: `git switch <main>`, `git merge --no-ff <auto-branch>`, tick the milestone in ROADMAP.md (`## [ ]` → `## [x]`), commit `docs: complete M<n>`. Push the main branch only if push is enabled, a remote exists and the user confirms. If the user prefers a PR instead (remote exists), push the auto branch and open one with `gh pr create` if `gh` is available.
- **Request mode**: offer the same merge, or leave the branch for the user to review.
- **`vcs: "none"`**: nothing to merge. Show the changed-files summary the runner printed and the undo command; in milestone mode tick the milestone in ROADMAP.md directly.
- If agentmemory tools are available: `memory_save` one entry (milestone or task, profile and toolkit, outcome, any gotcha with its reason). If the user corrected your setup choices, save a lesson (`memory_lesson_save`).
- Milestone mode: tell the user the next step: `/setup-pipeline next` builds the next unticked milestone with the same toolkit.

## Rules
- Never edit product code, commit or push yourself before the runner finishes; the pipeline owns those steps. Phase 0 fixes (baseline/wip commits, stash, branch switch, merging a previous run), Phase 5 merges, ROADMAP ticks and setup files (CLAUDE.md trims) are yours, with consent.
- Never force-push. Never run the pipeline on main/master. Report failures with their real output; never claim success without exit code 0.
- Resume points: `--from build`, `--from review`, `--from commit` (state lives in `.pipeline/`).
- `pipeline.mjs --wait <run id> [minutes]` blocks until the user decides in the dashboard and prints the decision as one JSON line (default wait 12 hours). It is how edits made in the browser reach this session on CLI, desktop or IDE; any other tool with a shell can run it too.
- On Windows the runner allows both `Bash` and `PowerShell` rules (headless sessions may expose either); on macOS/Linux only `Bash`.
- Run history lives in `~/.claude-pipeline/runs/` (override with `CLAUDE_PIPELINE_HOME`). If the user asks for the dashboard later, run `node "${CLAUDE_SKILL_DIR}/pipeline.mjs" --dashboard` to start or find it, and give them the printed link.
