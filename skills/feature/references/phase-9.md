# Phase 9 — ship

`/keel:ship` runs the blueprint. It is fixed steps around agent steps, with caps, ending in a human review that cannot be skipped. This file is the reference for what each step checks and what to do when it fails.

```
keel lane status          # merge any open lane first
keel verify fast && keel verify module api && keel verify module web
keel verify coverage
keel audit
keel trace --strict
keel verify release
# three reviewer lenses in parallel
keel gate final approve
keel pr
```

## The steps

| Step | Cap | Fails when |
|---|---|---|
| `verify fast`, `verify module` | 2 fix rounds | any compile, typecheck or test failure |
| `verify coverage` | 2 coverage-fix rounds | changed lines below 95%, branches below 90%, or global below the `ratchet` baseline |
| `keel audit` | none — stops | a red commit holds production code, a green commit holds tests, a disabled marker was added, an unlock has no reason, or the branch is `spike/` |
| `keel trace --strict` | none — stops | an AC has no test, or no green commit |
| `verify release` | none — stops | E2E or smoke fails. Requires `commands.e2e` |
| 3 × `keel:reviewer` | 2 review rounds | any lens ends `BLOCKING: yes` after the second round |
| Final human review | none — **cannot be skipped** | you request changes or stop |
| `keel pr` | none | push or `gh` fails |

## Coverage fixes

In the `coverage-fix` phase, test files are writable and production code is **delete-only** — unreachable lines may go, nothing may be added. `keel commit coverage` enforces the other half: any added line in a production file is refused, and the commit may not touch `.keel/config.yml`, because raising coverage cannot include lowering the threshold.

## The reviewers

Three at once on the same diff and spec, one lens each — correctness, security, performance (`review.lenses`). Each must end `BLOCKING: yes|no`; the `SubagentStop` hook blocks a reviewer that forgets the line. Apply blocking findings one commit each:

```
keel commit fix AC-00n "review — <what changed>"
```

Then go back to step 1. Non-blocking findings go to the final review, not into this branch.

## The final review

Show: the spec summary or inline ACs, the trace table, coverage per app, every non-blocking finding, the unlock log, every skipped gate, and a diffstat. Then ask. On approval `keel gate final approve`, then `keel pr` — which pushes and opens the PR with the generated body.

## Failure modes

- **`keel pr` is blocked by the coverage gate** — the verdict is missing or for an older commit. `keel verify coverage` again; the gate only reads the stored verdict, it never runs tests.
- **`trace --strict` reports an AC with no test** — the AC ID is missing from the test name or tag. That is a real gap, not a formatting problem.
- **`audit` flags a commit composition** — it cannot be fixed by amending history here. Add the missing piece as its own correctly-typed commit.
- **A spike branch** — `/keel:ship` refuses it by design. Spikes are for learning; redo the work as a real flow.
