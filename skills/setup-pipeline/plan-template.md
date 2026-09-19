# Plan: {{short title}}

## Goal
{{1-3 sentences: the outcome, in the user's terms}}

## Non-goals
- {{what this plan deliberately does not do}}

## Assumptions
- {{every guess you made instead of asking, one per line}}

## Interfaces
{{public functions, endpoints, file formats or data shapes the tasks must agree on; "None" if trivial}}

## Tasks
### T1: {{imperative title}} ({{AC ids, e.g. AC-1}})
- Files: `{{path}}` (new), `{{path}}` (edit)
- Do: {{what to implement, concretely enough that another model can build it without asking questions}}
- Verify: `{{exact command}}` -> {{what you expect to see}}

## Test matrix
| AC / requirement | Test (file::name) | Asserts |
|---|---|---|
| {{AC-1}} | {{tests/test_x.py::test_name}} | {{the observable behaviour it proves}} |

## Risks and rollback
- {{what could go wrong, and how to undo it}}

## Test command
`{{one command that runs every test}}`
