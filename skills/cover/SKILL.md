---
name: cover
description: Raise coverage on the changed lines by writing reviewed tests. Groups the uncovered lines, decides test, delete or accept for each, and reviews every test for real assertions. Use in ship step 2 and on code that predates keel.
disable-model-invocation: true
argument-hint: "[--app api|web] [--base main]"
---

# keel:cover — $ARGUMENTS

**This is not the AC loop.** A coverage test is written against code that already exists, so it passes the moment you write it. RED-before-GREEN cannot apply, and its absence is exactly where tautological tests appear — a test that asserts what the code *does* rather than what it *should do* executes the line, moves the number, and proves nothing. The review replaces "it must fail first". Treat it as the step that matters, not a formality.

## 1. Measure and group

```
keel state phase coverage-fix
keel cover
```

Uncovered lines are grouped by file and proximity, so one group is what one test can plausibly cover. A `!` marks a security-critical path from `security.coverage_paths`, where the bar is 100% — a single line there fails the tier.

## 2. Decide each group before writing anything

Three verdicts, and the second and third are not escape hatches:

```
keel cover decide <key> test
keel cover decide <key> delete
keel cover decide <key> accept --reason "…"
```

| Verdict | When | Consequence |
|---|---|---|
| `test` | A realistic scenario reaches the line | Write it, then have it reviewed |
| `delete` | Nothing can reach it — a defensive branch that cannot trigger, a dead overload | Production code may **lose** lines here and gain none. Needs the reviewer to agree, because deleting changes behaviour |
| `accept` | Untestable without absurd contortion — a shutdown hook, a catch for an impossible IO error | Recorded like an unlock, printed in the final review and the PR body. A reason is required |

If a line cannot be reached by any sensible test, that is a design question, not a reason to lower the threshold.

## 3. Write the test, then review it

Load the testing skill for the layer (`keel skills for coverage-fix --layer API`). Write the smallest test that covers the group **and asserts the behaviour the line exists for**.

Then run `keel:reviewer` with the **assertions** lens on the diff. It is looking for:

- assertions that restate the implementation instead of the requirement
- no meaningful assertion at all — a call with no check, a mock verified and nothing else
- a scenario no user could produce, invented only to reach the line
- a duplicate of an existing test under a new name

Apply its findings before committing.

## 4. Commit and repeat

```
keel commit coverage <ID> "cover <what>"
keel cover
```

`keel commit coverage` refuses any **added** production line and refuses to touch `.keel/config.yml` — raising coverage cannot include lowering the threshold. Repeat until `keel cover` reports the threshold met. If a round leaves the same lines uncovered, keel says so and the stall ladder starts; do not simply try again.

## Finishing

In ship, return to step 1 of `/keel:ship` once coverage passes. On its own, stop when the threshold is met and say which lines were accepted and why.
