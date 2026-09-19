# Small changes

Behaviour changes, one to three acceptance criteria, one area, no contract, database or auth change. A new validation rule, a new optional field from existing data, a changed default or sort order, a new error message or empty state.

```
keel state start change --size small --phase red
keel state ac CHG-014.1 --layer API --current
keel state ac CHG-014.2 --layer API
```

IDs are `CHG-<n>.<m>` — they live in state and in the PR body, not in a spec file. That is the only thing a small change drops: the spec and its approval. Every test and commit rule still applies.

## The loop

Identical to the feature flow's — see `../../feature/references/ac-loop.md`. RED, `keel state red-done`, `keel commit red`, GREEN, `keel state green-done`, `keel commit green`, then the gate.

The commits carry the change ID: `test(CHG-014.1): …` then `feat(CHG-014.1): …`.

## Gates

Default gate mode for a small change is `end` — one gate after the last AC, not one per AC. `keel state green-done` tells you whether a gate is due, so do not decide it yourself.

## Every commit is size-checked

`keel commit` runs the escalation triggers on the branch diff before each commit in a change flow:

| Trigger | Kind |
|---|---|
| the contract changed | **must** escalate |
| a migration was added or changed | **must** escalate |
| a path in `change.auth_paths` changed | **must** escalate |
| both apps changed | suggest |
| more than `change.size_limits_files` files (10) | suggest |
| more than `change.max_inline_acs` ACs (3) | suggest |

A **must** trigger stops the commit until you either `keel escalate` or record a reason with `keel escalate --override "<why>"`. See `escalate.md`.

## Then

`/keel:ship`.

## Failure modes

- **A third AC appears, then a fourth** — the suggest trigger fires at 3. Four ACs in one change is the signal it was always a feature.
- **The fix turns out to need a migration** — stop and escalate. That is a must trigger, and it exists because a migration is not reversible in the way code is.
- **Only one AC and it feels obvious** — still write the failing test. "Obvious" is where the loop earns its keep.
