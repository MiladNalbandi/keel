# Phase 0 — preflight

```
keel preflight <NNN-slug>
```

Proves the machine is ready, then creates the branch. Checks, in order:

| Check | Fails when |
|---|---|
| Run ladder | `.keel/setup.json` is missing, or a rung is still failing |
| Clean tree | `git status --porcelain` is non-empty |
| Required commands | any `commands.*` key a tier needs is blank — see `keel doctor` |
| Docker | `runtime.services` is `docker` and `docker info` fails |

On success it creates `feat/<slug>` (override the prefix with `--prefix fix`, skip branch creation with `--no-branch`) and prints `ready.`

**If it says "not ready", fix what it names.** Do not work around it — every problem it reports would otherwise surface three phases later as a confusing test failure. If keel is not configured at all, stop and run `/keel:init`.

## Then start the flow

Ask one picker: flow size (full or spike) and gate mode (`every-ac`, `end-of-lane`, `end`).

```
keel state start feature --gates <mode> [--spec specs/NNN-slug.md]
```

`state start` resets state, so it is also the way to enter a phase that transitions would otherwise refuse (`--phase <name>`).

## Failure modes

- **"the run ladder has not passed here yet"** — this is a fresh clone or a new machine. `/keel:init`, not `--force`.
- **"the tree is not clean"** — commit or stash. The flow's commits have to be attributable to ACs, and stray changes break `keel audit` later.
- **"commands not configured"** — `keel doctor` lists each key and which tier needs it. `codegen` and `static_checks` have no sensible default and must be filled in per project.
- **Spike work** — a `spike/` branch is allowed here but `/keel:ship` refuses it, by design.

Commit: none. Phase 0 produces no commit.
