# <Project name> - Spec

> Source of truth for the pipeline. Keep it to 1-2 pages: every pipeline run reads it.

## Goal
<One or two sentences: what this is and the problem it solves.>

## Users
<Who uses it and in what situation.>

## Acceptance criteria
Each criterion is observable and testable. IDs are stable; never renumber. The pipeline requires at least one automated test whose name or comment contains each ID.

- **AC-1** <User can ... and sees ...>
- **AC-2** <...>

## Non-goals
- <Explicitly out of scope for this version.>

## Platform
<Where it runs: web / desktop / mobile / CLI / bot / API / library.>

## Stack
| Layer | Choice | Why |
|---|---|---|
| Language | <...> | <...> |
| Framework / engine | <...> | <...> |
| Test runner | <...> | <...> |
| Storage | <...> | <...> |

**Decision:** <chosen option> over <rejected options>, because <reasons>. Trade-off accepted: <...>.

## Data
<What is stored, where, and whether there are user accounts. "None" is a valid answer.>

## Integrations
<External APIs, payments, services, required keys. "None" is a valid answer.>

## Constraints
<Offline, performance, budget, deadline, target devices, the user's own experience level.>

## Definition of done (v1)
<What must work for the first version to count as finished.>

## Commands
| Purpose | Command |
|---|---|
| Install | `<...>` |
| Run | `<...>` |
| Test | `<...>` |
| Lint | `<...>` |
| Types | `<...>` |
| Build | `<...>` |

The pipeline's quality gates run the Test, Lint, Types and Build rows (rows left as `<...>` are auto-detected; delete rows that do not apply).

## Assumptions
Decisions made without an explicit answer from the user. Revisit if wrong.
- <...>
