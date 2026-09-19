# claude-pipeline

A Claude Code plugin that takes you from a rough idea to committed, reviewed code, one milestone at a time.

```
/discover  →  SPEC.md + ROADMAP.md          (interactive: you answer ≤ 12 questions)
/setup-pipeline  →  one milestone, automated:

  Plan (Opus) → Build (Sonnet) → test gate → Review (read-only) → Commit (Haiku)
                     ↑_______ fix loop while review/tests fail _______|

/setup-pipeline next  →  the next milestone
```

- **`/discover`** turns a vague, hand-typed idea ("build me a card RPG with...") into a spec: it asks one question at a time (max 12), helps you pick a tech stack from 2-3 compared options, and writes `SPEC.md`, `ROADMAP.md` and a short `CLAUDE.md`.
- **`/setup-pipeline`** builds one milestone (or any clear request) with a four-step headless pipeline. Each step is a separate `claude -p` run whose **permissions are locked by its tool list**, not just by instructions: the planner can only write `plan.md`, the reviewer can only write `review.md` and run read-only git, the committer has no file-editing tools. If review or tests still fail after the fix loops, **nothing is committed**.

## Install

### Step 1: Check you have three things

In a terminal (PowerShell on Windows, Terminal on macOS/Linux):

```bash
claude --version   # Claude Code
git --version      # Git
node --version     # Node.js 18 or newer
```

Missing one? Install it:

| Missing | Install |
|---|---|
| `claude` | https://docs.claude.com/en/docs/claude-code/setup, then run `claude` once to log in |
| `git` | Windows: https://git-scm.com/download/win · macOS: `xcode-select --install` · Linux: `sudo apt install git` |
| `node` | https://nodejs.org (LTS) |

Open a **new** terminal afterwards and run the three commands again.

### Step 2: Install the plugin

Start Claude Code (`claude`) and type these two commands in the chat:

```
/plugin marketplace add Punssama/CLAUDE_PIPELINE
```

```
/plugin install claude-pipeline@punssama
```

If asked for a scope, choose **user** so it works in every project.

<details>
<summary>Alternative: install from the terminal</summary>

```bash
claude plugin marketplace add Punssama/CLAUDE_PIPELINE
claude plugin install claude-pipeline@punssama
```

</details>

### Step 3: Restart and check

1. Quit Claude Code (`/exit`) and start it again: plugins load when a session starts.
2. Run `/plugin` → **Installed**: `claude-pipeline` should be **enabled** (or run `claude plugin list` in a terminal).
3. Type `/disc` and `/setup` in the chat: `discover` and `setup-pipeline` should appear in the suggestions.

### Update / uninstall

```
/plugin marketplace update punssama          # update, then restart Claude Code
/plugin uninstall claude-pipeline@punssama   # uninstall
/plugin marketplace remove punssama
```

### Install problems

| Problem | Fix |
|---|---|
| `Permission denied (publickey)` on `marketplace add` | No GitHub SSH key. Use HTTPS: `/plugin marketplace add https://github.com/Punssama/CLAUDE_PIPELINE.git`. Still failing? Run once: `git config --global url."https://github.com/".insteadOf git@github.com:` |
| `/discover` or `/setup-pipeline` not listed | Restart Claude Code. On a name clash use `/claude-pipeline:discover` or `/claude-pipeline:setup-pipeline` |
| Pipeline says `cannot run claude` | `claude` is not on the terminal's PATH. Open a new terminal and run `claude --version`; reinstall Claude Code if it fails |
| `node: command not found` | Node.js is not installed, or the terminal was opened before installing it |

## Usage

### From an idea

```
/discover a turn-based card RPG where the player builds a deck and fights through 3 floors
```

1. **Where**: if you are not in a project, it asks for a name and folder, then creates it with `git init` and a first commit.
2. **Interview**: one question per message, each with a recommended answer you can just accept. It covers users, core flows (written as testable acceptance criteria `AC-1..n`), non-goals, platform, data, integrations, constraints and "done". Say "enough" or "you decide" at any point and it fills the rest with recorded assumptions.
3. **Stack**: 2-3 options compared (fit, pitfalls, testable from the command line?). It prefers stacks the pipeline can test headlessly and, for games and apps, separates core logic from the UI.
4. **Documents**: `SPEC.md`, `ROADMAP.md` (2-6 runnable milestones, each listing its ACs; M1 is always skeleton + test runner + first slice) and a short `CLAUDE.md`. You approve them, then they are committed.

Then build milestone by milestone:

```
/setup-pipeline          # builds M1
/setup-pipeline next     # builds the next unticked milestone
```

### From a clear request (existing project)

```
/setup-pipeline add a /health endpoint returning {"status":"ok"}, with a test
```

A readiness gate checks four things: outcome, scope, stack and done criteria. If one or two are missing it asks up to 3 questions; if the request is really a product idea, it sends you to `/discover` instead of guessing.

It does not dead-end: typing `/setup-pipeline` or `/setup-pipeline next` in a project without a roadmap suggests 2-3 sensible next changes from the code and the last run, and every blocker (no git, uncommitted work, an unmerged previous run) comes with a recommended fix it applies once you agree.

### What `/setup-pipeline` does

| Phase | What happens | You |
|---|---|---|
| 0. Get ready | Finds the project and fixes blockers after asking: no git yet, uncommitted changes, a previous run left on its `auto/...` branch | Pick a fix (one is recommended) |
| 1. Mode | Milestone (SPEC + ROADMAP exist) or request (readiness gate) | Answer ≤ 3 questions if needed |
| 2. Toolkit | Token profile, framework, add-ons; reuses the previous run's choices on `next` | Choose |
| 3. Config | Writes `.pipeline/config.json`, shows a summary with the max budget | Confirm |
| 4. Run | Plan → Build → test gate → Review → Commit on a new `auto/...` branch | Approve the plan if you chose to pause |
| 5. Merge | Merges the branch into main, ticks the milestone in ROADMAP.md, saves the outcome to agentmemory if used | Confirm the merge |

In milestone mode the runner **rejects a plan that does not map every AC of the milestone to a task** (one retry), and the reviewer grades the change against those ACs.

### Live dashboard

When a run starts, Claude sends you a link like `http://127.0.0.1:3120/#run=...`. One local page shows **every pipeline run on the machine**, across all your projects:

- step progress (Plan → Build → Test → Review → Commit), elapsed time and fix-loop round
- **real cost** per step and in total, against the budget cap
- a live feed of every file read or edited and every command each step runs
- test results, Critical review findings, and `plan.md` / `review.md` / test output
- runs that were killed mid-way are marked `stopped`

![Pipeline dashboard](assets/dashboard.png)

It uses the first free port from 3120 up, listens on `127.0.0.1` only, and stops by itself when the last Claude Code session closes (a small SessionStart/SessionEnd hook keeps count). Open it any time by asking Claude for the pipeline dashboard. Run history is kept in `~/.claude-pipeline/` (override with `CLAUDE_PIPELINE_HOME`).

### Token profiles

| Profile | Plan | Build | Review | Commit | Fix loops | Max budget per run* |
|---|---|---|---|---|---|---|
| Economy | Sonnet 5 | Sonnet 5 | Haiku 4.5 | Haiku 4.5 | 1 | ~$4.80 |
| Balanced | Opus 5 | Sonnet 5 | Sonnet 5 | Haiku 4.5 | 2 | ~$11.50 |
| Quality | Opus 5 | Sonnet 5 | Opus 5 | Haiku 4.5 | 3 | ~$19.50 |

\* Sum of the four per-step caps, before fix loops (each loop adds Build + Review). It is a **ceiling**; real runs usually cost much less.

Other ways it saves tokens: interactive questions happen once in `/discover` instead of the headless steps guessing; the headless steps read a short `SPEC.md` instead of a chat history; plugins you did not choose are switched off for the headless steps (`disablePlugins`); skills per step are capped; `CLAUDE.md` is kept short.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Committed (and pushed if enabled) |
| 10 | Paused after the plan: read `.pipeline/plan.md`, then continue with `--from build` |
| 3 | The plan does not cover the milestone's ACs: clarify or split the milestone |
| 2 | Review or tests still failing: see `.pipeline/review.md`; nothing was committed |
| 1 | Error: see `.pipeline/logs/` |

Resume from a step: `--from build | review | commit`. It never runs on `main`/`master` and never force-pushes.

## Configuration (`.pipeline/config.json`)

Written by `/setup-pipeline`; you can edit it and rerun.

```json
{
  "milestone": "M2",
  "project": "request mode: up to 10 lines of context",
  "task": "request mode: outcome, scope, non-goals, done criteria",
  "guidance": "Ponytail level: full. Terse output.",
  "branch": "auto/m2-combat",
  "testCmd": "npm test",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "disablePlugins": ["superpowers@superpowers-marketplace"],
  "steps": {
    "plan":   { "model": "claude-opus-5",             "budgetUsd": 3,   "skills": ["planning-and-task-breakdown"] },
    "build":  { "model": "claude-sonnet-5",           "budgetUsd": 6,   "skills": ["test-driven-development", "ponytail:ponytail"] },
    "review": { "model": "claude-sonnet-5",           "budgetUsd": 2,   "skills": ["code-review-and-quality"] },
    "commit": { "model": "claude-haiku-4-5-20251001", "budgetUsd": 0.5, "skills": [] }
  }
}
```

| Field | Meaning |
|---|---|
| `milestone` | Milestone mode: plan, build and review only this ROADMAP milestone, gated on its ACs |
| `project` / `task` | Request mode: context (plan step only) and the task |
| `guidance` | One line added to **every** step |
| `disablePlugins` | Plugins (`name@marketplace`) switched off for the headless steps only; your normal Claude Code is unaffected |
| `skills` | Skill names **installed on your machine**. Empty is fine |
| `budgetUsd` | Hard spending cap per step |

### Optional companion plugins

| Tool | What it adds | Install |
|---|---|---|
| [ponytail](https://github.com/DietrichGebert/ponytail) | Less code, less prose | `claude plugin marketplace add DietrichGebert/ponytail` → `claude plugin install ponytail@ponytail` |
| [superpowers](https://github.com/obra/superpowers) | Plan/TDD/debug/review discipline | `claude plugin marketplace add obra/superpowers-marketplace` → `claude plugin install superpowers@superpowers-marketplace` |
| [agent-skills](https://github.com/addyosmani/agent-skills) | Full lifecycle skills incl. security, performance | `claude plugin marketplace add addyosmani/agent-skills` → `claude plugin install agent-skills@addy-agent-skills` |
| [agentmemory](https://github.com/rohitg00/agentmemory) | Memory across sessions | `claude plugin marketplace add rohitg00/agentmemory` → `claude plugin install agentmemory@agentmemory`, then `npx -y @agentmemory/agentmemory@latest` to start its server |

None are required: the "Light" setup works with nothing else installed. `/setup-pipeline` asks before installing anything.

## Caveats

- **It spends real API money.** `budgetUsd` caps each step; see the token profiles above.
- The Build step can run shell commands (except commit, push, reset and branch switching). Use it on repositories you trust.
- Keep `pauseAfterPlan: true` for the first few runs so you read the plan before code is written.
- Status (0.4.1): end-to-end tested on Windows with Haiku on every step, including a two-milestone run with merges and two projects running at once on the dashboard. Not yet tested end to end with Opus/Sonnet, on macOS/Linux, or with pushing to a remote.

## License

MIT
