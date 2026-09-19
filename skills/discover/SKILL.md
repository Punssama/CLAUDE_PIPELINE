---
name: discover
description: Turn a vague or hand-typed idea into a build-ready spec before any code is written. Interviews the user one question at a time (max 12) until the request is "ready to plan", helps choose a tech stack from 2-3 compared options, then writes SPEC.md, ROADMAP.md and a short CLAUDE.md and commits them. Use when the user has only an idea ("build me a card RPG", "I want an app that..."), when there is no repo or spec yet, when the user says "discover", or when setup-pipeline reports the request is too vague to run.
argument-hint: "[your idea, in any words]"
---

Output of this skill: a project whose main branch holds `SPEC.md`, `ROADMAP.md` and `CLAUDE.md`, clear enough that `/setup-pipeline` can build it milestone by milestone without guessing. Templates: `${CLAUDE_SKILL_DIR}/templates/SPEC.md` and `${CLAUDE_SKILL_DIR}/templates/ROADMAP.md`.

Plugin files are English; talk to the user in the language they write in. Write SPEC.md, ROADMAP.md and CLAUDE.md in English (downstream models work best with it), keeping the user's own product names and terms.

## Phase 0 - Where the project lives
- **Inside a git repo with code:** use it. Read README, CLAUDE.md / AGENTS.md, the package manifest, `git log --oneline -5` and the test setup first; never ask what the repo already tells you.
- **Inside a git repo that already has SPEC.md and ROADMAP.md:** the project is already discovered. Offer to extend the spec (new ACs and milestones) or to go straight to `/setup-pipeline`.
- **Not in a repo, or in a home / downloads / desktop folder:** ask for a project name and a parent folder. Suggest `<a projects folder the user already uses, else ~/projects>/<kebab-name>`. Then create the folder, `git init`, write a one-line `README.md`, and commit it (`chore: initial commit`), so the pipeline has a HEAD to diff against. Ask before creating anything.

If agentmemory tools are available, search it for the project name and idea: reuse prior decisions instead of asking again.

## Phase 1 - Is discovery even needed?
If `$ARGUMENTS` already states an outcome, a scope, a stack and done criteria (or the repo makes them obvious), say so and hand off to `/setup-pipeline` with that request. Discovery is for vague ideas; do not spend questions on clear ones.

## Phase 2 - Interview (max 12 questions)
Ask **one question per message**. Every question carries your recommended answer, so the user can simply agree (`AskUserQuestion` with the recommendation first and "(Recommended)", or plain chat for free-text answers). Never ask what you can infer from the idea or the repo.

If `superpowers:brainstorming`, `interview-me` or `mattpocock-skills:grilling` is installed, you may follow its questioning style, but this skill's checklist, cap and output win.

Work down this **Definition of Ready** checklist; skip items already answered:
1. **Problem and users** - who it is for, what it fixes for them.
2. **Core flows (MVP)** - 3-7 things a user can do. Each becomes an acceptance criterion `AC-n`: observable and testable ("player can play a card and the enemy's HP drops by its damage"), never vague ("good combat").
3. **Non-goals** - what v1 deliberately leaves out. Propose them; this is the main defense against scope creep.
4. **Platform** - web, desktop, mobile, CLI, bot, API, library.
5. **Data** - what is stored, where, user accounts or not.
6. **Integrations** - external APIs, payments, keys needed.
7. **Constraints** - offline, performance, budget, deadline, and the user's own experience level (drives the stack choice).
8. **Done** - what must work for v1 to count as finished.

Stop when every item is answered or covered by an assumption the user accepted, or at 12 questions. If the user says "enough", "skip", "you decide" (in any language): fill every open item with your recommended answer and record it under **Assumptions** in SPEC.md. Never leave an item as "unknown".

## Phase 3 - Choose the stack
Do not ask "which stack do you want?" to someone who may not know. Derive 2-3 options from platform, data, constraints and experience level, and compare them in one short table:

| Option | Fits because | Watch out for | Tests from the command line? |
|---|---|---|---|

Rules for the recommendation:
- **Prefer stacks that can be tested headlessly** (a single test command, no GUI editor needed): the pipeline gates every build on it. Web/TypeScript, Python, Go, Rust, Node CLIs are good; Unity or Unreal need an editor, and Godot needs extra setup, so recommend them only if the user insists.
- **For UI-heavy products (games, apps), split core logic from presentation**: rules, state and data in a plain, testable module first; the UI consumes it in a later milestone.
- Prefer boring, mature, well-documented choices, and ones matching the user's experience.
- If `source-driven-development` is installed, check current versions against official docs before recording them.

Ask the user to pick (`AskUserQuestion`, recommendation first). Record the choice, the rejected options and the reason in the SPEC's Stack section.

## Phase 4 - Write the documents
Fill the templates; keep the SPEC to 1-2 pages because every pipeline run reads it.
- **SPEC.md** - every section of the template. ACs numbered `AC-1..n`.
- **ROADMAP.md** - 2-6 milestones, each a vertical slice that runs and is testable, each listing the ACs it completes (`ACs: AC-1, AC-2`); together they cover every AC exactly once. **M1 is always**: project skeleton + test runner wired up + the smallest end-to-end behavior. Keep the heading format `## [ ] M<n> - <title>` exactly; `/setup-pipeline` parses it.
- **CLAUDE.md** - under ~40 lines: stack, install/run/test commands, folder layout to create, conventions, no-go zones. Every pipeline step loads it, so every extra line is paid on every run. If a CLAUDE.md already exists, merge into it instead of replacing it.

Show the user a compact summary (goal, AC list, stack decision, milestone list, assumptions). Apply their changes. On approval, commit the three files on the main branch (`docs: add spec, roadmap and project rules`).

## Phase 5 - Hand off
- If agentmemory tools are available, `memory_save` one entry: project, goal, stack decision with its reason, milestone count.
- Tell the user the next step in one line: run `/setup-pipeline` to build M1 (then `/setup-pipeline next` for each following milestone).

## Rules
- Never write product code in this skill; its only outputs are the three documents (plus the initial commit in Phase 0).
- One question per message, each with a recommendation. Max 12.
- Every AC must be testable. Rewrite vague ones before writing them down.
