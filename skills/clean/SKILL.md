---
name: clean
description: Clean up after a project you gave up on. Removes the plugins that were installed only for that project (and service plugins no other project uses) and keeps everything shared - language tools, general plugins such as ponytail, and plugins other projects still use. Nothing is removed without a confirmation and the project's own files are never touched. Use when the user says "clean", "clean up this project", "I abandoned this project", "remove the plugins for this project", "uninstall what this project needed", or wants to tidy their plugins after dropping a project.
argument-hint: "[project folder]"
---

Helper: `${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs` (Node). Plugin files are English; talk to the user in the language they write in. Keep messages short.

**Asking questions.** Use `AskUserQuestion` with plain inputs: 1-4 questions per call, 2-4 options per question (never add "Other": the picker adds it), header of at most 12 characters, short labels, details in `description`. If a call fails validation, retry once with simpler text, then ask in plain chat as a numbered list.

**What "only for that project" means.** `/toolkit` installs service and platform plugins (Stripe, Supabase, Cloudflare ...) for the project alone (Claude Code's `local` scope), and language servers, `frontend-design` and general plugins for all projects. So a clean is exact for the first kind. Older installs made for all projects are judged by the projects this plugin has seen (sessions that started in them, dashboard registrations, pipeline runs): a service plugin goes only if this project needs it and none of those does. Language tools and general plugins (ponytail, agent-skills ...) are shared by nature and are never touched.

## 1. Which project?
Use `$ARGUMENTS` if it is a folder; otherwise the current project root. If the user means another project ("the old one"), run `node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --projects` (JSON, newest first) and let them pick (`AskUserQuestion`, at most 4 options, the picker's own "Other" takes a path). Say the folder in one line.

## 2. Look before touching anything
```bash
node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --clean-plan "<dir>"
```
The JSON has `remove` (each with `id`, `title`, `scope`, `why`, and `global: true` when it was installed for all projects) and `keep` (each with `why`, and `usedBy` folders for a plugin other projects use). Show it in plain words, one line per plugin:
- **Would remove (only this project uses them):** title and why. For `global: true`, add: "installed for all projects, but no other project I know uses it (I only know projects where a session or the pipeline ran)".
- **Would keep (shared):** title and why, naming the other projects by folder name.
- Say general plugins are left alone on purpose, without listing them.

Nothing to remove: say so, then go to step 5.

## 3. Confirm
ONE `AskUserQuestion`: **Remove all listed** (Recommended) / **Let me pick** / **Keep everything**. "Let me pick" is a multiSelect of the removable plugins (4 options per question; ask several questions for more). Keep everything: skip to step 5.

## 4. Remove
```bash
node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --clean-apply "<dir>" id1,id2
```
It uninstalls only what the plan lists for that folder and refuses any other id. Report each as removed or failed (with its message; do not retry blindly). Tell the user: it takes effect after `/reload-plugins` or a restart, and `/toolkit` can install any of them again with one confirmation.

## 5. Mark the project abandoned (ask)
ONE `AskUserQuestion`: **Yes, mark it abandoned** (Recommended) / **No, I may come back**. Yes runs:
```bash
node "${CLAUDE_SKILL_DIR}/../toolkit/toolkit.mjs" --abandon "<dir>"
```
This is bookkeeping only: the project stops counting as a user of any plugin (so a plugin only it used can go later), leaves the dashboard's Documents list and stops getting plugin hints. Starting a Claude session in that folder again undoes it. Its run history in the dashboard stays until the user clicks "Clear finished" there.

## Rules
- Never delete, move or edit the project's files or its git history. This skill only uninstalls plugins and writes the plugin's own bookkeeping in `~/.claude-pipeline/`.
- Never uninstall anything the plan does not list, and never without the confirmation in step 3. Never uninstall general plugins.
- If unsure whether a plugin is shared, keep it and say why.
