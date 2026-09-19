# Bug flow — fix, reset, ship

Phase `bug-fix`, entered only through Gate F. `api-main` and `web-src` allow, new migrations allow, **tests deny**.

```
keel state phase bug-fix       # Gate F approval sets this for you
# change the cause
keel state green-done
keel commit fix BUG-<n> "<what changed>"
```

## Rules

- **Change the cause, not the test.** Tests are frozen in this phase, so the guard enforces it: if the fix seems to need the reproducing test edited, the diagnosis was wrong.
- Touch only the files the approved plan named. Extra files need an explanation at ship, where `keel audit` and the reviewers will see them.
- Put the root cause in the commit body, not just the subject. In six months that body is the only explanation anyone has.
- A new migration is allowed; existing ones stay immutable.

## When the fix fails

| Attempt | What to do |
|---|---|
| First failure | Back to `bug-investigate`. The cause was wrong, and Gate F is asked again before the next fix. |
| Second failure | **Reset.** Do not try a third time in the same context. |

```
keel state phase reset
# write down what you learned and what you ruled out
/clear
keel state phase bug-repro
```

A context full of failed attempts makes the next attempt worse, not better. The reset exists because two wrong fixes mean the framing is wrong, and a fresh context is the cheapest way to change it. Save the learnings first or the reset costs you the evidence.

## Regression E2E

Only when the bug was user-visible across both apps. Delegate to `keel:e2e-author`, then `keel commit e2e BUG-<n> "<journey>"`. For a bug that a unit test caught, an E2E test is cost without cover.

## Then

`/keel:ship`. The reviewers and the final human review run exactly as they do for a feature; `keel trace` treats `BUG-<n>` like any other ID, so the fix needs its test and its commit to pass `--strict`.

## Failure modes

- **`green-done` passes but the module suite broke** — the fix changed behaviour something else relied on. That is a second bug, not collateral: decide deliberately which behaviour is correct.
- **The reproducing test now passes for the wrong reason** — check the fix actually addresses the cause in the plan. A test that passes because a code path stopped running is not fixed.
- **You want to edit the test because it is "slightly wrong"** — the guard refuses it. Reject at Gate R next time round instead; amending the red commit is the sanctioned route.
