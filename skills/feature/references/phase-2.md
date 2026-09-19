# Phase 2 — plan

Plan mode. The output is a plan section appended to the spec, and an approved order of work.

## Ask the explorers, in parallel

Start one `keel:explorer` per area — API, web, data — in a single message so they run concurrently. Each returns a file map for the ACs in its area, the patterns to follow, and ends `MAP-END`. They are read-only and capped at 60 lines.

Explorers deliberately **do not** comment on architecture. That prohibition protects the AC loop from drive-by refactors; architecture is `keel:arch-surveyor`'s job at init, not a planning opinion.

## Append to the spec

- **AC order.** Dependencies first: the AC that creates the row before the one that reads it.
- **Files per AC.** From the explorer maps.
- **Contract delta.** Which paths and schemas change, or "none".
- **Test layer per AC.** The lowest layer that can express it.

## The gate — cannot be skipped by config

Get the plan approved, then:

```
keel commit docs SPEC-NNN "plan"
```

`/clear` is recommended after this phase.

## Lane assignment

ACs are already tagged, so the lanes follow. If both lanes have work, decide here whether the web lane runs interactively in a second terminal or in the background — it cannot start until after the contract commit in phase 3, because both lanes need the generated client.

## Failure modes

- **An AC whose files overlap another AC's** — order them adjacently and in one lane, or the second one's RED will fail on the first one's half-finished code.
- **A plan that renames things** — a rename is not part of an AC. It is a separate `/keel:change` before or after, because the AC loop's GREEN rule forbids code no test drives.
- **An explorer that returns nothing useful** — its area probably has no existing code. Say so in the plan instead of inventing structure.
