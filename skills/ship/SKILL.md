---
name: ship
description: Finish a branch the same way every time: verify, coverage, audit, trace, reviewers in parallel, final human review, then open the PR.
disable-model-invocation: true
---

# keel:ship

Run these in order. Stop and report at the first failure; never skip a step.

0. If a lane is still open (`keel lane status`), merge it first: `keel lane merge web`.
1. `keel verify fast` and `keel verify module api` / `keel verify module web`. At most 2 fix rounds.
2. `keel verify coverage`. If it fails, run `/keel:cover` rather than adding tests ad hoc — it groups the uncovered lines, makes you decide test, delete or accept for each, and reviews every test for real assertions. At most 2 rounds. Never weaken a test, and never edit a threshold.
2b. `keel verify deps`, unless no manifest or lockfile changed on this branch — in which case it says so and stands down. A finding at or above `security.deps.fail_on` blocks the push.
3. `keel audit` — commit composition, disabled tests, unlocks, branch type.
4. `keel trace --strict` — every AC has a test and a commit.
5. Reviewers in parallel with `keel:reviewer`, one lens each from `review.lenses` — correctness, security, performance, and architecture when `architecture.style` is set. Each must end with `BLOCKING: yes|no`.
6. Fix blocking findings, one commit each (`keel commit fix <AC> "review — ..."`), then go back to step 1. At most 2 review rounds.
7. **Final human review, never skipped.** Show: spec summary or inline ACs, the trace table, coverage numbers, non-blocking findings, unlocks, skipped gates, diffstat. Ask the user to approve, request changes, or stop.
8. On approval: `keel gate final approve`. Then refresh the knowledge base, which happens *after* the human has seen the code diff so it never rides inside a reviewed commit:

```
keel state phase memory
keel memory update
keel commit memory SPEC-NNN "<what changed in the knowledge base>"
```

9. `keel pr` — it pushes and opens the PR with the trace table, the coverage numbers, every unlock, every accepted coverage line and every skipped gate in the body. The push is refused until the coverage verdict, and the dependency verdict when a manifest changed, both match this commit.
9. After the merge, finish the flow: `/keel:feature` phase 10 — the ADR, then `keel state close`.
