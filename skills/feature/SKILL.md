---
name: feature
description: The spec flow: interview, spec with numbered acceptance criteria, plan, contract, one AC at a time with RED and GREEN commits, integration, E2E, smoke, then ship. Use for features touching the API contract, data or auth.
disable-model-invocation: true
argument-hint: "<idea> [--spike] [--gates every-ac|end-of-lane|end]"
---

# keel:feature — $ARGUMENTS

Read one phase reference at a time from `references/` instead of loading everything: `phase-0.md` … `phase-10.md` for the phases, and `ac-loop.md` for the loop itself.

## Phase 0 — preflight

```
keel preflight <NNN-slug>
```

It proves the ladder passed on this machine, the tree is clean, every required command is configured and Docker is up, then creates the branch. If it reports "not ready", fix what it names — do not work around it. If keel is not configured at all, stop and run `/keel:init`.

Ask one picker: flow size (full or spike) and gate mode (every-ac, end-of-lane, end). Then:

```
keel state start feature --gates <mode>
```

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

With `loops.red_author: subagent`, delegate the RED step to `keel:test-author`; with `loops.green_author: subagent`, delegate GREEN to `keel:implementer`. The hooks block production code in RED and test files in GREEN either way, and edits are scoped to the current lane. If a loop stalls, follow what keel prints.

`keel state green-done` tells you whether a human gate is due for this AC and what to do when it is not — it resolves the gate mode, an at-gate skip, a `[gate: skip]` tag and a background lane in one place, so do not decide that yourself.

### Running the two lanes in parallel

Optional, and only after the contract commit. Backend stays in this session; the frontend lane gets its own worktree, branch and stack, so the two never share a port or a database:

```
keel lane start web                  # interactive: open a second terminal there
keel lane start web --background     # or hand the lane to keel:lane-runner
keel lane status
```

In a background lane that lane's human gates are skipped by definition; every automatic check still runs. `keel lane merge web` brings it back before phase 6, and reports the files if it conflicts.

## Phase 6 — integration

If a web lane ran, `keel lane merge web` first. Then wire the real client to the real API: `keel verify module api` and `keel verify module web`.

## Phase 7 — E2E

Delegate to `keel:e2e-author` for the `[E2E]` ACs. Then `keel commit e2e AC-00n "<journey>"`.

## Phase 8 — smoke

Write the `[SMOKE]` checks as a script plus one `@smoke` test. `keel commit smoke SPEC-NNN "<checks>"`.

## Phase 9 — ship

`/keel:ship`.

## Phase 10 — close

After the PR merges, write an ADR under `docs/adr/` for any decision that had a real alternative, then:

```
keel state phase close
keel state close          # archives the flow to .keel/archive/ and clears state
```

Say what shipped in one line and stop.
