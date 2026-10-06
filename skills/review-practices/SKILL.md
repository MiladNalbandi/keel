---
name: review-practices
description: How to review a change well — spec and standards kept apart, tests read first, a code-smell baseline, five axes, honest severities and a fix for every problem. Preloaded into keel:ticket-reviewer; load it for any code review.
user-invocable: false
---

# keel:review-practices — reviewing a change well

Built from the two most-installed review skills of 2026 — Matt Pocock's `code-review` and Addy
Osmani's `code-review-and-quality` (both MIT) — rewritten for keel's review jobs. Credits at the end.

## 1. Two questions, never mixed

| Axis | Question | Fails when |
|---|---|---|
| **Spec** | does the change do what the ticket asked — all of it, and only it? | something asked is missing or half done · it is done but wrong · **behaviour nobody asked for** (scope creep) |
| **Standards** | does it follow how *this repo* writes code? | it breaks a documented rule · it fights the pattern of its neighbours · a code smell below |

A change can pass one and fail the other. Report them apart; never let a clean axis hide the other.

## 2. Read the tests first

Before the code: do the tests prove the ticket's behaviour — the happy path **and** the edge the
ticket names? A test that only calls the code, asserts nothing, or asserts the implementation
rather than the behaviour is a finding of its own. Then read the implementation.

## 3. The repo's standards win

Look for what the repo documents: `CONTRIBUTING.md`, `CODING_STANDARDS.md`, a style guide,
`docs/knowledge/conventions.md`, and the `like:` neighbour file keel picked. **A documented repo
rule always overrides the baseline below** — if the repo endorses something the baseline flags,
drop the flag. Skip anything a linter or formatter already enforces (keel runs those itself).

## 4. The smell baseline — always a judgement call

Applies even when the repo documents nothing. Say "possible …", never "violation". Smell → fix:

- **Unclear name** — the name does not say what it does or holds → rename it; if no honest name comes, the design is unclear.
- **Duplicated code** — the same shape in two hunks or files → extract it once, call it from both.
- **Feature envy** — a function uses another object's data more than its own → move it to that data.
- **Data clump** — the same few values always travel together → give them one small type.
- **Primitive obsession** — a string or number stands in for a domain idea → give the idea its own type.
- **Repeated switch** — the same `if`/`switch` on the same kind, in several places → one map or polymorphism.
- **Shotgun surgery** — one small change forces edits in many files → gather what changes together.
- **Divergent change** — one file edited for several unrelated reasons → split it by reason.
- **Speculative generality** — options, hooks or layers the ticket does not need → delete; add when needed.
- **Message chain** — `a.b().c().d()` → one method on the first object hides the walk.
- **Middle man** — a wrapper that only passes calls on → call the real target.
- **Bolted-on branch** — a new `if` for a feature pushed into an unrelated flow → its own helper or policy.

## 5. The five axes, for bugs

1. **Correctness** — wrong logic, edge cases (empty, zero, null, max, concurrent), errors swallowed.
2. **Readability** — could it be much shorter? does each abstraction earn its place?
3. **Architecture** — logic in the layer that owns it; the existing helper reused, not copied; a refactor that removes complexity rather than moving it.
4. **Security** — input checked, authorization on every new path, no secret or personal data in code or logs.
5. **Performance** — a query in a loop, unbounded lists, work repeated per item. **Quantify**: "one query per row, ~50 ms × 200 rows", not "could be slow".

## 6. Severity, honestly

| keel | Means | Example |
|---|---|---|
| `blocking` | must not merge | data loss, a security hole, broken behaviour, a test that proves nothing |
| `minor` | should fix, does not block | a smell, an unclear name, a missed edge that cannot happen yet |
| *(leave out)* | nit or taste | formatting, preference — not worth the author's time |

- **Do not rubber-stamp.** "Looks good" needs the line that proves it.
- **Do not soften a real problem.** A bug that will hit production is `blocking`, not "maybe".
- **Comment on the code, not the person.**
- **Every problem gets a fix** — the *to do*, in plain words. Good fixes: replace a chain of
  conditions with a model or a lookup; merge duplicate branches; move feature logic out of a shared
  module; reuse the canonical helper; make a type boundary explicit; delete a pass-through wrapper;
  split a large file.

## Credits

- Matt Pocock, `code-review` — github.com/mattpocock/skills (MIT): the Spec/Standards split, scope creep, the repo-overrides rule and the smell baseline (after Fowler, *Refactoring*, ch. 3).
- Addy Osmani, `code-review-and-quality` — github.com/addyosmani/agent-skills (MIT): the five axes, tests first, severity labels, structural fixes and honesty in review.
