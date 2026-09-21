# AI_PIPELINE

Unified multi-model AI coding pipeline for **Claude Code** (Anthropic) and **Antigravity** (Google DeepMind Gemini Pro & Flash).

Takes you from a rough, vague idea to tested, reviewed, production-ready code in any local folder (git optional).

```
/discover  →  SPEC.md + ROADMAP.md          (interactive: 1 question at a time)
/setup-pipeline  →  one milestone, automated:

  Plan → plan check → Build → quality gates → Review (read-only) → Commit
                         ↑_ a failing gate goes straight back to Build; review only runs when gates pass _|

/setup-pipeline next  →  the next milestone
```

---

## ⚡ Highlights

- **Dual Ecosystem Support**: Native plugin for **Claude Code** (`ai-pipeline` / `claude-pipeline`) and native deterministic workflows for **Antigravity** (`workflows/pipeline.workflow.js`).
- **Multi-Model Orchestration**: Flexible execution across Gemini 3.1 Pro / 3.8 Flash / 3.7 Flash and Claude Opus 5 / Sonnet 5 / Haiku 4.5.
- **Zero-Token Automated Quality Gates**: Local offline checks (`tests`, `lint`, `types`, `secrets`, `trace`, `size`) intercept build errors immediately on your machine — preventing wasted reviewer model costs.
- **Tiered Quality & Budgets**: Select `economy`, `balanced`, or `premium` to configure model selection, reasoning effort (`low` to `max`), web research depth, and plan critique passes.
- **Live Local Web Dashboard**: Machine-wide real-time dashboard on port `3120` displaying live tool execution streams, `SPEC.md` / `ROADMAP.md` previews, plan diffs, and interactive approvals.
- **VCS Flexibility**: First-class support for Git repositories or plain folders (`"vcs": "none"`) with instant one-command `--undo`.
- **Intelligent Toolkit & Cleanup**: `/toolkit` scans your tech stack to suggest tailored plugins; `/clean` safely uninstalls unused project-scoped tools.

---

## 📦 Installation

### For Claude Code (`claude`)

Add the marketplace and install `ai-pipeline`:

```bash
# Add marketplace repository
/plugin marketplace add https://github.com/Punssama/AI_PIPELINE.git

# Install plugin
/plugin install ai-pipeline@punssama
```

*(Note: `claude-pipeline` is maintained as a backward-compatible alias).*

### For Google DeepMind Antigravity (`antigravity`)

The repository includes native Antigravity plugin manifests and workflow definitions:
- Manifest: `.antigravity/plugin.json`
- Workflow: `workflows/pipeline.workflow.js`

Load the workflow directly in your Antigravity environment:
```javascript
import runPipeline, { meta } from './workflows/pipeline.workflow.js';

await runPipeline({
  milestone: 'M1',
  tier: 'balanced', // 'economy' | 'balanced' | 'premium'
  gates: 'standard'
});
```

---

## 🚀 Workflow & Commands

### 1. Interactive Discovery (`/discover`)

Turn a vague, unstructured idea into an actionable product specification:

```bash
/discover a turn-based card RPG where the player builds a deck and fights through 3 floors
```

1. **Project Setup**: Prompts for project name and directory if starting fresh.
2. **Targeted Interview**: Asks focused questions one at a time (≤ 12) covering core user flows, non-goals, data model, platform, and acceptance criteria (`AC-1..n`).
3. **Tech Stack Comparison**: Evaluates 2–3 options based on fit, headless testability, and separation of UI and core domain logic.
4. **Specification Documents**: Generates `SPEC.md`, `ROADMAP.md` (structured runnable milestones M1..Mn), and `CLAUDE.md`.
5. **Instant Dashboard Launch**: Automatically opens the local web dashboard to preview your spec and roadmap.

### 2. Milestone Automation (`/setup-pipeline`)

Build milestones sequentially or run custom development tasks:

```bash
# Build milestone 1 (skeleton, test suite, first slice)
/setup-pipeline

# Build the next uncompleted milestone from ROADMAP.md
/setup-pipeline next

# Request mode: targeted feature or bugfix in an existing project
/setup-pipeline add a /health endpoint returning {"status":"ok"}, with a test
```

Pipeline phases:
1. **Plan**: Architecture design and granular task breakdown with acceptance criteria and test matrix mapping.
2. **Plan Lint / Critique**: Zero-token plan verification checking AC coverage and test completeness (with adversarial Principal Engineer critique in `premium` tier).
3. **Build**: Test-driven implementation strictly adhering to `.pipeline/plan.md`.
4. **Quality Gates**: Automated execution of offline tests, linter, typecheck, secret scanning, and AC traceability. Blocking failures loop directly back to Build.
5. **Review (Read-Only)**: Independent staff-level audit of code changes, requirements, edge cases, and security vulnerabilities.
6. **Commit**: Clean atomic commit summarizing milestone deliverables and verified ACs.

---

## 🎯 Quality Tiers

Configure execution depth in `.pipeline/config.json` via the `"tier"` parameter.

### Antigravity (Gemini)

| Tier | Planner | Plan Critique | Builder & Test | Reviewer (Read-Only) | Committer | Target Use Case |
|---|---|---|---|---|---|---|
| **economy** | `gemini-3.8-flash` (`medium`) | None | `gemini-3.8-flash` (`medium`) | `gemini-3.8-flash` (`medium`) | `gemini-3.8-flash` (`medium`) | Rapid prototyping, tight budgets, simple scripts |
| **balanced** | `gemini-3.1-pro` (`high`) | None | `gemini-3.1-pro` (`high`) | `gemini-3.1-pro` (`high`) | `gemini-3.1-pro` (`high`) | Production features, balanced cost and deep reasoning |
| **premium** | `gemini-3.8-flash` (`max`) | `gemini-3.1-pro` (`max`) | `gemini-3.1-pro` (`max`) | `gemini-3.1-pro` (`max`) | `gemini-3.7-flash` (`high`) | Mission-critical code, security-sensitive systems, complex architectures |

### Claude Code

| Tier | Planner | Builder | Reviewer | Committer | Research | Plan Critique | Quality Gates |
|---|---|---|---|---|---|---|---|
| **economy** | Sonnet 5 | Sonnet 5 | Haiku 4.5 | Haiku 4.5 | None (spec only) | No | Standard |
| **balanced** | Opus 5 | Sonnet 5 | Sonnet 5 | Haiku 4.5 | GitHub (up to 3 repos) | No | Standard |
| **premium** | Opus 5 (`max`) | Sonnet 5 (`max`) | Opus 5 (`max`) | Haiku 4.5 | Deep (up to 5 repos, arch comparison) | Yes (Staff Engineer pass) | Strict + Mutation Check |

Explicit overrides in `.pipeline/config.json` always take precedence over tier defaults.

---

## 🛡️ Zero-Token Quality Gates

Offline checks execute before any reviewer model is called, preventing billable API costs on simple syntax, lint, or test failures:

| Gate | Automated Tools / Engines | Blocking? | Details |
|---|---|---|---|
| `tests` | `npm test`, `pytest`, `cargo test`, `go test` | Yes | Verifies automated test suite passes |
| `lint` | `eslint`, `ruff`, `biome`, `golangci-lint`, `clippy` | Yes | Static analysis and code quality |
| `types` | `tsc --noEmit`, `mypy`, `pyright` | Yes | Type safety verification |
| `secrets` | `gitleaks` (git diff mode) or built-in scanner | Yes | Detects leaked credentials, API keys, tokens |
| `trace` | Built-in AC tracer | Yes | Confirms every milestone acceptance criterion has tests |
| `size` | Built-in diff limit check | Advisory (Warn) | Flags oversized diffs indicating scope creep |
| `audit` | `osv-scanner`, `trivy`, `npm audit`, `pip-audit` | Advisory (Warn) | Dependency vulnerability checks |

---

## 📊 Live Web Dashboard

Manage, monitor, and approve pipeline runs with the built-in real-time dashboard:

```bash
node skills/setup-pipeline/pipeline.mjs --dashboard [project-folder]
```

- **URL**: `http://127.0.0.1:3120`
- **Live Event Stream**: Real-time tool execution, assistant thoughts, and terminal output.
- **Spec & Roadmap Viewer**: Live markdown previews of `SPEC.md` and `ROADMAP.md` updated in real time.
- **Interactive Approval**: Pause after planning to inspect, edit, or reject the plan before implementation begins.
- **Plan Linting**: In-browser linting verifies task coverage and acceptance criteria alignment before approval.
- **Multi-Project Management**: Monitors multiple concurrent projects across your system.

---

## 🧰 Toolkit & Clean

### Companion Toolkit (`/toolkit`)

Scan your project stack and install optimized, token-efficient companion plugins:
- **Stack-Aware Suggestions**: Analyzes `package.json`, manifests, or `SPEC.md` to recommend relevant plugins (e.g., Supabase, Stripe, Cloudflare, TypeScript/Python language servers).
- **Token Efficiency**: Pre-measures token footprints to keep context usage minimal.
- **Project-Scoped Isolation**: Service and infrastructure plugins install to `.claude/settings.local.json` for the current project only.

### Project Cleanup (`/clean`)

Safely de-provision project-specific plugins when archiving or finishing a project:
- Removes plugins installed solely for the target project.
- Preserves shared global tools (language servers, general skills).
- Offers safe abandonment tracking to declutter dashboard views without modifying project source code.

---

## ⚙️ Configuration Reference (`.pipeline/config.json`)

```json
{
  "vcs": "git",
  "milestone": "M1",
  "tier": "balanced",
  "gates": "standard",
  "pauseAfterPlan": true,
  "push": false,
  "guidance": "Concise code, strict typing.",
  "disablePlugins": [],
  "steps": {
    "plan":   { "model": "gemini-3.1-pro",   "budgetUsd": 1.5, "skills": [] },
    "build":  { "model": "gemini-3.1-pro",   "budgetUsd": 3.0, "skills": [] },
    "review": { "model": "gemini-3.1-pro",   "budgetUsd": 1.5, "skills": [] },
    "commit": { "model": "gemini-3.7-flash", "budgetUsd": 0.2, "skills": [] }
  }
}
```

### Git-Free Environments (`"vcs": "none"`)

Work safely in plain folders without initializing git:
- Tracks working tree snapshots in `.pipeline/baseline`.
- Run one-command instant rollback if needed:
  ```bash
  node skills/setup-pipeline/pipeline.mjs .pipeline/config.json --undo
  ```

---

## 🧪 Testing & Verification

The test suite requires no external network connections or paid API credentials:

```bash
npm test
```

Runs 87 automated unit and integration tests covering:
- Plan linting and acceptance criteria validation
- Offline quality gate execution and failure routing
- Multi-tier configuration inheritance and overrides
- Multi-model pricing calculation (Gemini & Claude)
- Dashboard HTTP server, WebSocket event streams, and project registration
- Git and VCS-less state management

---

## 📄 License

[MIT](LICENSE)
