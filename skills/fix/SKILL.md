---
name: fix
description: Bug flow: reproduce with a failing test, confirm at Gate R, investigate in a fresh context, get the fix plan approved at Gate F, then fix the root cause. Use for defects and regressions.
disable-model-invocation: true
argument-hint: "<symptom> [--no-gates]"
---

# keel:fix — $ARGUMENTS

Read one phase reference at a time from `references/`: `reproduce.md`, `investigate.md`,
`fix.md`. If you cannot make the bug fail on demand yet, stop and use `/keel:diagnose`
instead — this flow needs a reproduction before it will do anything.

## 0 — report

```
keel preflight <NNN-slug> --prefix fix
```

It proves the ladder passed here, the tree is clean, required commands are configured and
Docker is up, then creates the branch. Fix what it names rather than working around it.

Write down the symptom, the exact error, the steps, and the expected behaviour. Then:

```
keel state start fix --phase bug-report
keel state ac BUG-<n> --layer API --current
```

For a UI-only bug with Claude in Chrome enabled, observe it in the browser first: page,
console, network.

## 1 — reproduce

```
keel state phase bug-repro
```

Delegate to **`keel:reproducer`**. Give it the symptom report and nothing else — no theory
about the cause. That restriction is the point: an agent that knows the suspected cause
writes a test confirming the theory rather than one demonstrating the symptom, and a test
that passes for the wrong reason is worse than no test.

It names the bug class, loads the matching technique from `keel:debugging`, writes the
smallest failing test at the lowest layer that shows the symptom, and ends `REPRO: confirmed`
or `REPRO: not-reproducible`.

- **`REPRO: confirmed`** → `keel commit red BUG-<n> "reproduce <symptom>"`, then Gate R.
- **`REPRO: not-reproducible`** → stop here and run `/keel:diagnose <symptom>`. Do not weaken
  an assertion until something goes red.

## Gate R

```
keel state phase gate-r
```

Show the failing test and its output, then ask the user one question with three answers:

| Answer | Effect |
|---|---|
| Yes, this is the bug | `keel gate R approve`, then investigate |
| No, reproduce differently | `keel gate R reject --note "…"`, back to `bug-repro`; amend the red commit |
| **Stop** | End the flow. The reproducing test stays on the branch for later — it is worth keeping even unfixed |

`keel state start fix --no-gates`, or `gates.bug_gates: false`, waives both bug gates for the
flow: `keel gate R` and `keel gate F` with no decision then record an automatic approval, and
the waiver appears in the final review and the PR body. With the gates on, a bare `keel gate R`
is a usage error — a gate is not passed by leaving the decision out.

## 2 — investigate

```
keel state phase bug-investigate
```

Nothing is writable here but the `other` bucket: production code stays locked until Gate F,
and the guard enforces it.

Send **`keel:investigator`** — several **in parallel**, one hypothesis each, when there is
more than one plausible cause. They are read-only, so competing hypotheses cost tokens and
nothing else, and they do not contaminate each other. Do not tell one agent what another is
testing.

Each ends `ROOT-CAUSE: confirmed` or `ROOT-CAUSE: unconfirmed`. If three hypotheses come back
unconfirmed, escalate the model once (`keel models set opus investigator --yes`) and try the
surviving leads again. Still nothing → `/keel:diagnose`, which is built for this.

## Gate F — the fix plan

```
keel state phase gate-f
```

Present: root cause, evidence, the files to change, the approach, the risk, one alternative,
and whether a regression E2E test is needed.

```
keel gate F approve            # unlocks production code
```

Not approved → investigate more, change the approach, or hand over to `/keel:feature` because
it is a missing requirement rather than a defect.

## 3 — fix

```
keel state phase bug-fix
```

Change the cause, never the test. Touch only the files named in the plan; explain any extra.
Load `keel:architecture` for placement if the fix adds code.

```
keel state green-done
keel commit fix BUG-<n> "<what changed>"
```

If the fix fails twice, do not try a third time from the same context: `keel state phase
reset`, save what you learned to the note, `/clear`, and reproduce again.

## 4 — regression E2E, if the bug was user-visible

Only when the bug crossed both apps or would be invisible to a unit test. Delegate to
**`keel:e2e-author`** with the symptom and the fix, then:

```
keel commit e2e BUG-<n> "<journey that used to break>"
```

Skip it for a bug the reproducing test already covers — a second test at a higher layer that
adds no coverage is cost, not safety.

## 5 — ship

`/keel:ship`. A security-class bug does not skip the security phase.
