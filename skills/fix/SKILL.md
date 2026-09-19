---
name: fix
description: Bug flow: reproduce with a failing test, confirm at Gate R, investigate in a fresh context, get the fix plan approved at Gate F, then fix the root cause. Use for defects and regressions.
disable-model-invocation: true
argument-hint: "<symptom> [--no-gates]"
---

# keel:fix — $ARGUMENTS

## 0 — report

Write down symptom, exact error, steps, expected behaviour. Start clean:

```
keel state start fix --phase bug-repro
keel state ac BUG-<n> --layer API --current
```

For a UI-only bug with Claude in Chrome enabled, observe it in the browser first: page, console, network.

## 1 — reproduce

Write the smallest failing test at the lowest layer that shows it: unit, then slice, then Testcontainers integration, then Playwright. Then:

```
keel state repro-done
keel commit red BUG-<n> "reproduce <symptom>"
```

## Gate R

Ask the user: does this failing test show the bug you meant? Record it:

```
keel gate R approve            # or: keel gate R reject --note "..."
```

## 2 — investigate

Delegate to `keel:investigator`. It is read-only: logs, stack traces, `git log -p`, `git bisect run`, read-only SQL. Production code stays locked.

## Gate F — the fix plan

Present: root cause, evidence, files to change, approach, risk, one alternative, and whether a regression E2E test is needed. Ask the user to approve.

```
keel gate F approve            # unlocks production code
```

Options if not approved: investigate more, change approach, or hand over to `/keel:feature` because it is a missing requirement.

## 3 — fix

Change the cause, never the test. Then:

```
keel state green-done
keel commit fix BUG-<n> "<what changed>"
```

If the fix fails twice, save what you learned, `/clear`, and reproduce again.

## 4 — ship

`/keel:ship`.
