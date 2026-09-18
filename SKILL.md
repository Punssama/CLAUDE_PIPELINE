---
name: setup-pipeline
description: Set up and run an automated 4-step pipeline in the current git repo - Plan (Opus 5) -> Build (Sonnet 5) -> Review (Sonnet 5, read-only) -> Commit+push (Haiku, no edit rights). Asks the user which skills each step should use, writes .pipeline/config.json, then runs it. Use when the user says "setup-pipeline", "chạy pipeline", "plan build review commit tự động", or wants a multi-model automated dev workflow.
argument-hint: "[what to build]"
---

Runner: `~/.claude/skills/setup-pipeline/pipeline.mjs` (Node). It launches one headless `claude -p` per step with a fixed model and a **tool allowlist that enforces the role** (planner can only write `.pipeline/plan.md`; reviewer can only write `.pipeline/review.md` and run read-only git; committer has no Edit/Write). Files in `.pipeline/` are the only memory between steps.

## 1. Preflight (stop and tell the user if any fails)
- `git rev-parse --show-toplevel` succeeds (else offer `git init`); work from that root.
- `git status --porcelain` is empty (the runner refuses a dirty tree).
- `node -v` and `claude --version` work.
- Current branch is fine to branch from; the runner creates `auto/<slug>` and refuses to run on main/master.

## 2. Task
Take the task from `$ARGUMENTS`. If it is vague (no clear outcome / scope), refine it with the user NOW (this session is interactive, the pipeline is not): use `interview-me` or a few direct questions. The pipeline cannot ask questions, so the task text must be specific.

## 3. Ask which skills each step uses
One `AskUserQuestion` call, 4 questions, `multiSelect: true`. Mark the first option "(Recommended)". "Other" lets the user type any installed skill name. Plugin skills use their full name (`superpowers:writing-plans`, `ponytail:ponytail`).

| Step (model) | Options |
|---|---|
| Plan (Opus 5) | `planning-and-task-breakdown` (Rec) / `superpowers:writing-plans` / `spec-driven-development` / `ponytail:ponytail` |
| Build (Sonnet 5) | `test-driven-development` (Rec) / `incremental-implementation` / `ponytail:ponytail` / `security-and-hardening` |
| Review (Sonnet 5) | `code-review-and-quality` (Rec) / `security-and-hardening` / `ponytail:ponytail-review` / `performance-optimization` |
| Commit (Haiku) | `git-workflow-and-versioning` (Rec) / none |

Warn once: steps run **headless**, so do not pick interactive skills (`brainstorming`, `grilling`, `interview-me`) for Plan/Build/Review; they would wait for answers that never come.

Then a second `AskUserQuestion` (3 questions, single-select):
1. **Test command** - detect it (package.json `scripts.test`, `pytest`, `go test ./...`, `cargo test`) and offer it as Recommended, plus "no test gate". The gate runs after every build and must pass before commit.
2. **Pause after plan?** Yes (Recommended for first runs: user reads plan.md before any code is written) / No.
3. **Push?** Yes, push the `auto/...` branch to origin / No, commit only.

## 4. Write `.pipeline/config.json`
```json
{
  "task": "<specific task text>",
  "branch": "auto/<short-slug>",
  "testCmd": "<cmd or omit>",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "steps": {
    "plan":   { "model": "claude-opus-5",              "budgetUsd": 3,   "skills": [] },
    "build":  { "model": "claude-sonnet-5",            "budgetUsd": 6,   "skills": [] },
    "review": { "model": "claude-sonnet-5",            "budgetUsd": 2,   "skills": [] },
    "commit": { "model": "claude-haiku-4-5-20251001",  "budgetUsd": 0.5, "skills": [] }
  }
}
```
Fill `skills` from the answers. `budgetUsd` is a per-step hard cap (real API spend); tell the user the totals and that they can edit the file.

## 5. Run
```bash
node "$HOME/.claude/skills/setup-pipeline/pipeline.mjs" .pipeline/config.json
```
Use `run_in_background: true` (takes minutes) and read the output when notified. Do not touch the repo while it runs. Handle the exit code:

| Exit | Meaning | You do |
|---|---|---|
| 0 | Committed (and pushed if enabled) | Report branch, commit hash, push status, and test/review rounds |
| 10 | Paused after plan | Show `.pipeline/plan.md`, ask to approve or edit; then run the same command with `--from build` |
| 2 | Review/tests still failing after fix loops; **nothing committed** | Show `.pipeline/review.md` + `test-output.txt`; offer: fix manually, raise `maxFixLoops`, or re-run `--from build` |
| 1 | Error | Show the last lines and the newest `.pipeline/logs/*.log`; do not retry blindly |

## Rules
- Never edit code, commit, or push yourself while running this skill; the pipeline owns those steps.
- Never force-push and never target main/master. Report failures with their real output; do not claim success unless exit code 0.
- Resume points: `--from build`, `--from review`, `--from commit` (state lives in `.pipeline/`).
- Headless runs on Windows only expose the `PowerShell` tool (the runner maps `Bash` rules to it automatically); on macOS/Linux it uses `Bash`.
