---
name: feature
description: The spec flow: interview, spec with numbered acceptance criteria, plan, contract, one AC at a time with RED and GREEN commits, integration, E2E, smoke, then ship. Use for features touching the API contract, data or auth.
disable-model-invocation: true
argument-hint: "<idea> [--spike] [--gates every-ac|end-of-lane|end]"
---

# keel:feature — $ARGUMENTS

Read one phase reference at a time from `references/` instead of loading everything.

## Phase 0 — preflight

`keel status`. If keel is not configured, stop and run `/keel:init`. Create the branch, then:

```
keel state start feature --gates <mode>
```

Ask one picker: flow size (full or spike) and gate mode (every-ac, end-of-lane, end).

## Phase 1 — interview and spec

Interview the user with `AskUserQuestion`: edge cases, validation, authorization, data rules, error states, what is out of scope. Then write `specs/NNN-slug.md` with:

- numbered ACs, each tagged `[API]`, `[WEB]`, `[E2E]` or `[SMOKE]`, each testable
- data and migration notes, validation and security rules
- out of scope, contract changes, smoke checks

Register them: `keel state ac AC-001 --layer API` for each. Ask for approval, then `keel commit docs SPEC-NNN "spec"`. Start a fresh session before the next phase.

## Phase 2 — plan

Plan mode. Ask `keel:explorer` (one per area, in parallel) for the files each AC touches. Append to the spec: AC order, files per AC, contract delta, test layer per AC. Get approval.

## Phase 3 — contract

Edit the contract file, regenerate both sides, then `keel verify fast`. Commit with `keel commit contract SPEC-NNN "<what changed>"`.

## Phases 4 and 5 — the AC loop

For each AC in plan order (`references/ac-loop.md` has the details):

```
keel state phase red
# write only this AC's tests, tagged with the AC ID
keel state red-done
keel commit red AC-00n "<what it asserts>"
# write the minimum production code
keel state green-done
keel commit green AC-00n "<what it does>"
keel gate ac approve|review|reject|skip
```

With `loops.red_author: subagent`, delegate the RED step to `keel:test-author`; with `loops.green_author: subagent`, delegate GREEN to `keel:implementer`. The hooks block production code in RED and test files in GREEN either way. If a loop stalls, follow what keel prints.

## Phase 6 — integration

Wire the real client to the real API. `keel verify module api` and `keel verify module web`.

## Phase 7 — E2E

Delegate to `keel:e2e-author` for the `[E2E]` ACs. Then `keel commit e2e AC-00n "<journey>"`.

## Phase 8 — smoke

Write the `[SMOKE]` checks as a script plus one `@smoke` test. `keel commit smoke SPEC-NNN "<checks>"`.

## Phase 9 — ship

`/keel:ship`.
