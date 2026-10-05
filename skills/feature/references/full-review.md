# Phase 4.5 — full-diff review

Right after the last AC is green, before integration. The first point anything reads every AC
together instead of two commits at a time.

```
keel lane merge web                      # if a web lane ran — the review needs the whole branch
# phase is already full-review after the last AC gate
# delegate to keel:code-reviewer over git diff main...HEAD
keel state full-review pass|findings
```

## Why here

Integration, security, smoke and E2E all build on this code. A cross-AC bug found now costs one
fix commit; found after E2E, it costs the E2E run again too.

## Scope — narrow on purpose

`keel:code-reviewer` (Sonnet, read-only) reports only what needs the whole diff in view:
correctness across ACs, consistency with the codebase, duplication across ACs, and anything outside
the spec's scope. Security, architecture, performance and assertions are `keel:reviewer`'s lenses
at ship.

Give it only the spec's AC list and scope, and the diff. It opens files only around changed hunks.

## The loop — one round, then ask

```
CODE-REVIEW: pass       → keel state full-review pass        (phase integration)
CODE-REVIEW: findings   → keel state full-review findings    (phase review-fix)
                           keel commit fix <AC> "review — …"
                           keel state phase full-review       # one more read
still findings          → stop and ask the user
```

One re-review only. A second round of findings means the finding and the fix disagree about
something neither will settle by repeating it.

## What ship does with it

`keel state full-review pass` stores the HEAD sha. At ship, if nothing in production code changed
since that sha, the `correctness` lens is not run again — this review already covered it.
