---
name: toolkit
description: Suggest and install the companion plugins that make claude-pipeline cheaper and better - ponytail, agent-skills, context-mode, agentmemory, superpowers, mattpocock-skills. Offers a Recommended set, a Full set (everything compatible, for people who do not want to read), or a pick-your-own list, shows each one's real token cost, and installs only what the user confirms. Use when the user says "toolkit", "which plugins should I install", "install everything", "set up my tools", after the first install of claude-pipeline, or when setup-pipeline finds no toolkit choice.
argument-hint: "[recommended | full | skip]"
---

Helper: `${CLAUDE_SKILL_DIR}/toolkit.mjs` (Node). It reads `catalog.json` (the only plugins it can ever install) and drives the `claude plugin` CLI. Plugin files are English; talk to the user in the language they write in. Keep messages short.

**Asking questions.** Use `AskUserQuestion` with plain inputs: 1-4 questions per call, 2-4 options per question (never add "Other": the picker adds it), header of at most 12 characters, short labels, details in `description`. If a call fails validation, retry once with simpler text, then ask in plain chat as a numbered list.

## 1. Look at the machine
```bash
node "${CLAUDE_SKILL_DIR}/toolkit.mjs" --status --tokens
```
The JSON has, per plugin: `installed` / `installedAs` (plugin, or copied "loose skills"), `alwaysOnTokens` (input tokens it adds to every session; `measured` says whether the number is measured), `unmet` (a requirement this machine fails, e.g. Node too old), `headless`, `license`, `notes`, `setup`. It also has `presets` (`recommended`, `full`: ids and total tokens) and `chosen` (what the user picked before, or null).

## 2. Show it, briefly
One line per plugin: name, what it does *for them* (`does`), `+N tokens/session`, and status (installed / not installed / unavailable: reason). Then say plainly:
- **Recommended** = ponytail + agent-skills: less code and output, plus the skills the Plan, Build and Review steps use. Small (`presets.recommended.alwaysOnTokens`).
- **Full** = everything compatible (adds context-mode and agentmemory). More capability, but it adds `presets.full.alwaysOnTokens` tokens to every interactive session; say the number.
- **context-mode** (a source-available plugin, Elastic License 2.0): it protects the context window from huge tool output (web pages, logs, large files). Measured in this pipeline's headless steps it adds about 8.6K input tokens per step and saves nothing on small outputs, so the pipeline keeps it OFF in its own steps. It pays off in long interactive sessions with big outputs. Needs Node 22.5+.
- superpowers and agent-skills are alternatives (two routers on one task conflict): Full and Recommended use agent-skills.

## 3. Let them choose
If `$ARGUMENTS` is `recommended`, `full` or `skip`, take it without asking. Otherwise ONE `AskUserQuestion`:
- **Recommended set** (Recommended)
- **Full set**
- **Let me pick**
- **Skip for now**

Someone who says they want low cost or few tokens gets Recommended, not Full.

- **Skip**: run `node "${CLAUDE_SKILL_DIR}/toolkit.mjs" --record skip`, say `/toolkit` is always available, and stop.
- **Let me pick**: one `AskUserQuestion` call with up to 3 questions. (1) multiSelect "Efficiency and memory": ponytail / context-mode / agentmemory. (2) single-select "Framework": agent-skills / superpowers / none. (3) multiSelect "Extras": mattpocock-skills. Leave out anything with `unmet` and say why. Never both agent-skills and superpowers: if both are chosen, ask which one to keep.
- Take the ids from `presets.<name>.ids` for a preset. Drop anything already installed and anything with `unmet` (say what was left out and why). Nothing left to install → say so, record the choice (step 6), stop.

## 4. Confirm once
List exactly what will be installed: id, source repo (`marketplace` in the catalog: github.com/<repo>), license. Show each chosen plugin's `notes` that matter (for context-mode and agentmemory: requirements, license and side effects; context-mode edits `~/.claude/settings.json` on its first start). State: these are third-party plugins from those repos; they run hooks or servers with the user's own permissions; nothing outside the list is installed. Then `AskUserQuestion`: **Install** / **Change the selection** / **Cancel**.

## 5. Install
```bash
node "${CLAUDE_SKILL_DIR}/toolkit.mjs" --install id1,id2
```
Allow up to 5 minutes (roughly 10-60 seconds per plugin); run it in the foreground. It prints one JSON array: `ok`, `verified`, `message`, `setup` per plugin. Report each as installed or failed (with the message; typical causes are no network or a blocked GitHub). It rewrites SSH GitHub URLs to HTTPS for its own child processes only; it never edits git or SSH configuration.

## 6. Record and follow up
```bash
node "${CLAUDE_SKILL_DIR}/toolkit.mjs" --record <recommended|full|custom> id1,id2
```
(list every plugin the user chose, including ones that were already installed). Then tell them:
- Restart Claude Code once: plugins load when a session starts.
- Each installed plugin's `setup` lines (agentmemory needs its server started with `npx -y @agentmemory/agentmemory@latest`, plus a one-time engine install on native Windows; run `/context-mode:ctx-doctor` after restarting). Give the commands; do not start servers yourself unless asked.
- How the pipeline uses them: ponytail, agent-skills and superpowers can be selected as step skills in `/setup-pipeline`; plugins whose catalog `headless` is `off` (context-mode, agentmemory, mattpocock-skills) are switched off inside the headless steps, and every step also skips all MCP servers (`--strict-mcp-config`, about 5K input tokens saved per step, measured).

## Rules
- Install only ids from `catalog.json`; never run an install command yourself instead of the helper.
- Never change global git or SSH configuration.
- Never install without the confirmation in step 4.
