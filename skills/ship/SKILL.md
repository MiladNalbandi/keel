---
name: ship
description: Finish a branch the same way every time: verify, coverage, audit, trace, reviewers in parallel, final human review, then open the PR.
disable-model-invocation: true
---

# keel:ship

Run these in order. Stop and report at the first failure; never skip a step.

1. `keel verify fast` and `keel verify module api` / `keel verify module web`. At most 2 fix rounds.
2. `keel verify coverage`. At most 2 coverage-fix rounds: add tests for uncovered changed lines, never weaken a test.
3. `keel audit` — commit composition, disabled tests, unlocks, branch type.
4. `keel trace --strict` — every AC has a test and a commit.
5. Reviewers, three in parallel with `keel:reviewer`, one lens each: correctness, security, performance. Each must end with `BLOCKING: yes|no`.
6. Fix blocking findings, one commit each (`keel commit fix <AC> "review — ..."`), then go back to step 1. At most 2 review rounds.
7. **Final human review, never skipped.** Show: spec summary or inline ACs, the trace table, coverage numbers, non-blocking findings, unlocks, skipped gates, diffstat. Ask the user to approve, request changes, or stop.
8. On approval: `keel gate final approve`, push, then `gh pr create --fill` with the trace table in the body.
