---
name: ship
description: Finish a branch the same way every time: verify, coverage, audit, trace, reviewers in parallel, final human review, then open the PR.
disable-model-invocation: true
---

# keel:ship

Run these in order. Stop and report at the first failure.

## First — ask which steps run this time

Ship is the longest sequence in the flow, and not every branch needs all of it. Put the choice up
with `AskUserQuestion` before step 0, in three bands, because **skipping a step is not the same as
removing its gate** and the difference has to be visible at the moment of choosing:

| Band | Steps | What skipping means |
|---|---|---|
| **Always runs** | 0 merge lane · 3 audit · 4 trace · 7 final review | not offered. Cheap, read-only, and the final review's table is built from 3 and 4 |
| **Deferred, not avoided** | 1b release · 2 coverage · 2b deps | `keel pr` refuses without a fresh verdict for HEAD (`gates.pushBlockers`). Skip these and the push still stops — you have moved the work, not removed it |
| **Genuinely optional** | 6.5 security · 5 reviewers · 6b reverse-trace | nothing downstream demands them. Skipping is a real choice with a real cost |

For the reviewers, ask **which lenses** rather than all-or-nothing — a three-line change rarely
needs four Opus agents on it.

**Record every skip**, the same way a skipped gate and an unlock are recorded: with a reason, shown
again at step 7, and printed in the PR body. A skip nobody sees at the end is indistinguishable
from a step that silently did not run.

Default when the user has no preference: run everything. The question exists to let a small branch
move quickly, not to make the full sequence opt-in.

## Fixing what ship finds — leave the ship phase to do it

**The `ship` phase writes nothing but `other`** (`'*': 'deny'`). That is deliberate: ship is a
sequence of checks, and a phase that could quietly edit production code between them would be
checking a moving target. So every fix here starts by leaving, and comes back:

| What found it | Go to | Commit as | Return to |
|---|---|---|---|
| verify fast / module (1) | `keel state phase review-fix` | `keel commit fix <AC> "verify — …"` | step 1 |
| coverage (2) | `/keel:cover` — it sets `coverage-fix` itself | `keel commit coverage "…"` | step 1 — a coverage pass can change production code |
| dependencies (2b) | `keel state phase review-fix` | `keel commit fix <AC> "deps — …"` | step 2b |
| audit (3) | depends on what it names — usually `review-fix` | `keel commit fix <AC> "audit — …"` | step 3 |
| trace (4) | a missing test is `keel state phase red` for that AC | `keel commit red <AC> "…"` | step 4 |
| a reviewer (5–6) | `keel state phase review-fix` | `keel commit fix <AC> "review — …"` | step 1 |
| behaviour outside the spec (6b) | see 6b — it is often not a fix at all | | |

Then `keel state phase ship` and pick up where you left off. `review-fix` is the general-purpose
one: it allows production code **and** test files, because a finding is sometimes that the test is
wrong.

**Two rounds, then stop and ask.** Steps 1 and 6 each cap at two. A third round means the check and
the change disagree about something neither will settle by repetition, and that is a decision for
the user, not another attempt.

**Some findings are not fixes.** A trace gap can mean the AC was never really done; a reviewer can
be describing a criterion that is wrong rather than code that is wrong; 6b routinely surfaces scope
that should have been an amendment. Those go back to the AC loop or the spec, not into a `fix`
commit — and shipping is not resumed until they do.

0. If a lane is still open (`keel lane status`), merge it first: `keel lane merge web`.
1. `keel verify fast` and `keel verify module api` / `keel verify module web`. At most 2 fix rounds.
1b. `keel verify release` — every module suite, the full E2E suite and smoke, against **this**
   commit. Steps 1 and 6 can change code after phase 7 ran, so without this the branch ships on a
   suite that never saw its last commit. The verdict is stored per sha in `.keel/release.json` and
   the push is refused until it matches HEAD. A project with no browser surface records that once:
   `keel verify release --skip "<why>"`, which is printed in the PR body like an unlock. **Re-run
   it after any fix round.**
2. `keel verify coverage`. If it fails, run `/keel:cover` rather than adding tests ad hoc — it groups the uncovered lines, makes you decide test, delete or accept for each, and reviews every test for real assertions. At most 2 rounds. Never weaken a test, and never edit a threshold.
2b. `keel verify deps`, unless no manifest or lockfile changed on this branch — in which case it says so and stands down. A finding at or above `security.deps.fail_on` blocks the push.
3. `keel audit` — commit composition, disabled tests, unlocks, branch type.
4. `keel trace --strict` — every AC has a test and a commit.
5. Reviewers in parallel with `keel:reviewer`, one lens each from `review.lenses` — correctness, security, performance, and architecture when `architecture.style` is set. Each must end with `BLOCKING: yes|no`.
6. Fix blocking findings, one commit each (`keel commit fix <AC> "review — ..."`), then go back to step 1. At most 2 review rounds. A finding spanning several criteria — one N+1 across three ACs — takes the spec id rather than an arbitrary one of them: `keel commit fix SPEC-NNN "review — …"`.

   **Show what each reviewer said, and what you did not change.** The same rule the AC gate has: each finding in the reviewer's own words, what changed per finding, and — the part that gets dropped — **every blocking finding you judged not real, with why**. A dismissed blocking finding is a decision made on the user's behalf and it is invisible unless said. Carry those to step 7.
6b. **Walk the diff the other way — no behaviour outside the spec.** Steps 1–6 all run spec → code: every AC has a test, every test has a commit, coverage holds, the lenses read the change. Nothing runs code → spec, so a behaviour nobody asked for passes every one of them. Go through the diff and name anything implementing no criterion — an extra endpoint, a field that crept into a response, a config flag, a convenience method with no caller. Each is one of three things, and say which: it belongs to an AC and the trace table is wrong, it is scope that should have been an amendment, or it comes out before the PR. `keel trace --strict` cannot do this; it only walks the direction where every AC is accounted for.

7. **Final human review, never skipped. Show the whole picture, including the parts that make it look worse.**

   A review summary is not a case for the change. The reviewer is deciding whether to merge, and every omission makes that decision worse while making the summary read better — so present all of it in one place, unsummarised:

   | Show | Especially |
   |---|---|
   | The spec | its goal and AC list, plus **every amendment** with its `Was:` line — a criterion agreed on Thursday reads exactly like one agreed in phase 1 unless you say so |
   | The trace table | `keel trace --strict` — AC → test → commit |
   | Coverage | the numbers, and **every line accepted** rather than covered |
   | Review findings | blocking ones fixed, the non-blocking ones nobody fixed, and **every blocking finding dismissed as not real, with the reason** |
   | Release | the `keel verify release` verdict for this sha, and the `--skip` reason if e2e was skipped |
   | **Ship steps skipped** | every step the opening question turned off, with its reason — and for anything in the deferred band, that its push gate is still outstanding |
   | Security | what phase 6.5 found, and what was triaged as unreachable |
   | Step 6b | anything in the diff that implements no criterion |
   | Gates | **every skipped gate, and its scope** — including a background lane, where they were skipped by definition and no one chose it per AC |
   | Unlocks | every `keel unlock`, with the reason given at the time |
   | Flakes | anything in `state.flaky` — a test that failed once and passed on rerun is a fact about this branch |
   | The diff | diffstat, and the files a reviewer should actually open |

   **Do not lead with the summary and bury the exceptions.** If there are three skipped gates and an accepted coverage block, that is the headline, not a footnote after the green checkmarks. A reviewer who finds out afterwards that a gate was skipped has been given a decision they did not know they were making.

   Then ask: approve, request changes, or stop.

   Mergeable means all of it, not most: the spec reflects intended behaviour and its ACs are numbered and testable; the contract matches real behaviour or the spec says it is unaffected; tests map to ACs and **failed before** the implementation; validation, authorization and ownership are explicit and tested; sensitive data is not exposed and error responses are intentional; formatting, static analysis, the suite and smoke all pass; every non-obvious decision has an ADR; and no behaviour outside the spec was added.
8. On approval: `keel gate final approve`. Then refresh the knowledge base, which happens *after* the human has seen the code diff so it never rides inside a reviewed commit:

```
keel state phase memory
keel memory update
keel commit memory SPEC-NNN "<what changed in the knowledge base>"
```

9. `keel pr` — it pushes and opens the PR with the trace table, the coverage numbers, every unlock, every accepted coverage line and every skipped gate in the body. The push is refused until the coverage verdict, and the dependency verdict when a manifest changed, both match this commit.
9. After the merge, finish the flow: `/keel:feature` phase 10 — the ADR, then `keel state close`.
