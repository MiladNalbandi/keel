# Trivial changes

Nothing observable changes: a refactor, a rename, a file move, formatting, comments, docs, a dependency bump with no effect, log wording, a UI typo.

```
keel state start change --size trivial --phase trivial
# make the change
keel commit trivial <area> "<imperative message>"
```

The commit message is `refactor(<area>): …`. Use `docs`, `chore` or `build` as the area when that is what it is.

## What is writable

`api-main` and `web-src` allow. Test files are **new-only** — you may add a test file but not edit an existing one. The contract, migrations and everything else deny.

## Trivial is checked, not trusted

`keel commit trivial` refuses and tells you to redo it as a small change when:

| Check | Why it matters |
|---|---|
| It edits an **existing** test file | If behaviour did not change, no existing test needed to change. That it did is the evidence. |
| It touches the contract or a migration | Both are observable to clients, by definition |

The first check is the load-bearing one. A refactor that needs a test edited is not a refactor.

## When it is refused

Two honest options:

1. **Make it a small change.** `keel state start change --size small --phase red`, write the AC the behaviour change implies, and drive it through the loop.
2. **Fix the refactor** so behaviour really is unchanged, and the existing tests pass untouched.

Do not reach for `keel unlock` here. The refusal is information, not an obstacle.

## Then

`/keel:ship` — trivial changes still get the reviewers and the final human review. They skip only the spec and its approval.

## Failure modes

- **"it edits existing tests"** and you believe the test was simply wrong — that is still not trivial. A wrong test is a bug fix (`/keel:fix`) or an AC, both of which leave a record of why it changed.
- **A rename that touches 40 files** — still trivial if no test changed, but `check-size` will suggest escalating on file count. Continuing is fine; the reason is logged.
- **A dependency bump that changes behaviour** — the moment a test notices, it is small, not trivial.
