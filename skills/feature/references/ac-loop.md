# The acceptance-criteria loop

One AC at a time, in plan order. Two commits per AC, one gate. Runs for `[API]` ACs in phase 4 and `[WEB]` ACs in phase 5.

```
keel state phase red
# write only this AC's tests
keel state red-done
keel commit red AC-00n "<what it asserts>"
# write the minimum production code
keel state green-done
keel commit green AC-00n "<what it does>"
keel gate ac approve|review|reject|skip
```

## RED

Write tests **only** for the current AC, at the lowest layer that can express it. Name and tag every test with the AC ID — `keel verify ac` filters on it and `keel trace` finds the test by it.

Edits are **lane-scoped**: in the `api` lane you may write `api-test` files, in the `web` lane `web-test` files. Crossing over is refused with the lane named. Switch deliberately with `keel state lane web` if that is really the work.

### When the test harness does not exist yet

The first AC in a package often has nothing to build on — no fixture, no factory, no base class, no Testcontainers setup, no MSW handlers. **Write it. It is allowed:** anything under the test path classifies as `api-test` or `web-test`, which is exactly what RED may write.

What will happen is that your first run fails on `cannot find symbol` or a Spring context error, and **`red-done` refuses it** — those are in the reject list. That is the check doing its job rather than an obstacle: a test that cannot compile has not demonstrated anything. Keep going until the test *runs* and fails on its **assertion**, then `red-done`. The refusal is the difference between "my test fails" and "the behaviour is missing", and only the second one is a RED.

Three things to hold to while you build it:

- **Build only what this AC's test needs.** A factory with fields nothing asserts on is the test-side version of code no test drives — the same rule as GREEN, and it is easier to break here because scaffolding feels free.
- **It rides in the `red` commit.** There is no separate type for test infrastructure and it does not need one; `red` already allows `api-test`, `web-test` and `e2e`. Say so in the message — `keel commit red AC-003 "rejects a duplicate email — adds the repository fixture"` — so a large first commit reads as deliberate rather than as scope creep.
- **The first AC pays for what the rest reuse.** That is fine and worth saying out loud at the gate, because the diff will look disproportionate next to the criterion it proves.

**A missing package is not a missing fixture. Adding a dependency is MANDATORY spec work.**

If the harness needs something that is not installed — Testcontainers, MSW, a mocking library, an assertion library — **stop. Do not install it.** The hook refuses it during a flow and names the reason, but the rule holds whether or not the hook catches the particular command:

> A new dependency outlives this branch. Somebody maintains it, it carries a licence and a supply chain, and it ships to everyone who runs this code. That is a decision with a blast radius past the criterion you are trying to satisfy, and getting one test to compile is not a mandate to make it.

It goes in the spec as an acceptance criterion, through the gate, approved by a person — then it gets installed. If the spec is already frozen, that is an amendment: `keel state phase spec`, the dated block, `keel ask spec-amended`.

Once it is approved, record it and the guard steps aside for that package only:

```
keel state dep <name> --by user     # after the gate, never before
keel state dep                      # what has been approved on this flow
```

`--by user` matters for the same reason it does on a blocking question: a model approving its own dependency is the failure this rule exists to prevent, and a self-approval is recorded as one and reported at ship. The allowlist is per package and per flow — approving `zod` does not approve `lodash`, and it does not carry to the next feature.

What is *not* this rule: restoring what a lockfile already names. A bare `npm install`, `npm ci` or `./gradlew build` installs nothing new and is left alone.

**If the harness turns out to be large** — no container setup at all, no test database, an entire mocking layer absent — stop and say so before building it. That is a planning finding, not a RED step: `keel:explorer` reports *the test layer that fits, and where similar tests live*, so "nothing like this exists yet" was information phase 2 should have had. Building a test platform inside one AC's RED step buries a real decision inside a commit that claims to be about one criterion.

`keel state red-done` runs this AC's tests plus the tests in changed packages, then decides:

| Outcome | What keel does |
|---|---|
| Tests **pass** | Refuses. Either the behaviour already exists — record it with `keel state ac AC-00n --status already-met` and the evidence — or the test asserts nothing. |
| Fails on an **assertion** | Accepted. Phase becomes `red`, AC status `red`. |
| Fails on **setup** | Refused, with the matched pattern. Fix the setup; a compile error, a Spring context failure or a Docker error is not a red test. |

Classification is substring matching over the trimmed output, `red_accept` checked **before** `red_reject` — an assertion signal wins, because a genuine failure can also print alarming words.

| Accepted (`loops.red_accept`) | Refused (`loops.red_reject`) |
|---|---|
| `assertionfailederror`, `assertionerror`, `comparisonfailure` | `compilation error`, `cannot find symbol`, `unresolved reference` |
| `expected:`, `expected <`, `expected but was`, `but was:` | `applicationcontext`, `no qualifying bean` |
| `received:`, `tobe(`, `toequal(` | `could not connect to docker`, `docker environment` |
| `status expected` | `initializationerror`, `no tests found`, `classnotfoundexception`, `noclassdeffounderror`, `syntax error` |

Note: the design doc describes these as category names (`assertion`, `compile`); the implementation uses these literal substrings. Override with the substrings, not the categories.

## GREEN

Production code only — test files for every AC are frozen, and the lane still applies. Write the **minimum** code that makes the test pass: no field, endpoint, abstraction or branch no current test drives. New migrations may be added; existing ones are immutable.

### Work bottom-up, and stop when it goes green

```
migration → entity → test fixture → authorization rule → use case
          → input validation → response mapping → controller → route
```

Adapt the names to the architecture the project actually uses — `keel:architecture` says where each belongs — but keep the direction. The usual instinct is to start at the controller and work inward, which means nothing executes until the last piece lands and a failure at the end could have come from any of six files. Bottom-up, each layer is exercised as it arrives, and the thing that broke is the thing you just wrote.

**Stop at green.** The order is a route, not a checklist to finish: if the test passes at the use case, the remaining boxes were not part of this AC. A layer written past green is code no test drives, which is the one thing GREEN forbids.

### Say it as you write it

**If you are writing code you would report as a finding in someone else's review, say so — in one sentence, at the moment you write it — and then write it anyway if the AC or a decision requires it.**

The failure this prevents is *silent compliance*. A constraint explains a choice; it does not make the choice good, and treating "that was decided" as closing the question collapses two separate things — doing as asked, and saying nothing. It is also nearly impossible for the user to catch: the diff looks deliberate, and the only person who knows it would have been written differently is the one who wrote it. Nobody can review an absence of objection.

Three signals that always trip it:

- **Duplication you are about to repeat again.** Copying a block once is fine. The third copy is the signal, not the tenth.
- **A branch no test can reach.** You are in GREEN — every line should exist because a test drove it. One that does not will also miss the coverage floor at ship, and `/keel:cover` will make you decide about it then, more expensively.
- **A constraint older than the code it is shaping.** The further a decision is from the code it produces, the more it needs restating rather than less. Ask once whether it still holds.

This is not relitigating. No stays no; it is flagged once, when it bites, with the cost named — and then it goes in the gate summary, where the person who made the decision can see what it cost.

Most ACs touch three or four of these, not nine. One that appears to need all nine is worth re-reading — it is usually two criteria wearing one number.

`keel state green-done` runs this AC's tests with **one flake rerun** — a failure that passes on an unchanged rerun is recorded in `state.flaky` and does not count. Then, when `tests.module_suite_at` is `every-ac`, the whole lane suite. It reports per-AC coverage when `coverage.per_ac` is `warn` (default) or `enforce`; `enforce` fails the transition.

Its last line tells you whether a human gate is due for this AC and what to do when it is not. **Do not decide that yourself** — `gateDue` resolves the gate mode, an at-gate skip and its scope, a `[gate: skip]` tag and a background lane in one place.

## REFACTOR — optional, between GREEN and the gate

GREEN's "minimum code that passes" rule is right, and it accumulates duplication: three ACs each
add the smallest thing that worked, and none of them was allowed to tidy. `refactor` is where that
is discharged, while the tests are green and say what must not change.

```
keel state phase refactor     # from green
# production code only — tests stay frozen
keel commit refactor AC-00n "<what shape changed>"
keel state phase gate
```

**Skip it when there is nothing to do.** It is a phase, not a step: most ACs go straight from
green-done to the gate, and an invented refactor is a diff a reviewer has to read for no reason.

**Load the design reference for your lane before moving anything** — `references/design.md` under
`keel:kotlin-spring-implementation` or `keel:web-implementation`. This is the phase those exist
for: SOLID, the language's own idioms, and which patterns are worth their cost. Applying them in
GREEN would mean building an abstraction no test drives; applying them here means applying them to
duplication that is already real, with the tests green and holding the behaviour still.

Both open with the same test, which settles most of these arguments: **name the second caller.**
If you cannot, the abstraction is speculation. If you can, the duplication already exists and this
is exactly where to discharge it.

Two rules make it safe, and both are enforced rather than asked for:

- **Tests are frozen**, exactly as in GREEN. A refactor that may edit its own tests is one that can
  change behaviour and still be green — which is the only thing distinguishing a refactor from a
  rewrite.
- **It cannot reach `red`.** `refactor` leads to `gate` or back to `green`, so nothing new gets
  built under cover of cleaning up. If the tidy needs a behaviour change, it is a criterion.

Run the AC and lane suites again before the gate: `keel state phase green` then `green-done` if you
want the full check, or rely on the gate's own lane suite when `tests.module_suite_at` is `gate`.

## The gate

`keel gate ac <decision>` prints the board first, then:

| Decision | Effect |
|---|---|
| `approve` | AC marked done; moves to the next todo AC in `red`, or to `integration` when none remain |
| `review` | Run `keel:ac-reviewer` on this AC's two commits, then return to the gate. Findings are acted on in `review-fix` — see below |
| `reject --note "…"` | AC back to `todo`, phase back to `red` |
| `skip [--scope lane\|flow]` | Records the skip; `flow` also sets gate mode to `end`. Automatic checks still run and the final review lists it |

With `gates.ai_review_on_skip: true`, a skipped gate gets a `keel:ac-reviewer` pass instead; `AC-REVIEW: findings` means the gate applies after all.

**Why this is not `keel:reviewer`.** That agent takes a lens and a scope, and ship gives it both — one lens each over the whole branch. At this gate there is no lens to give and the scope is two commits, so it ended up sweeping all five: security with its routing table, architecture with `keel arch show`, performance, correctness, assertions. Reviewing one criterion cost about what ship's entire review round costs, and a review that expensive stops being run — which is worse than a cheap one, because `approve` skips it and the cost falls on whoever is being careful.

`keel:ac-reviewer` asks three questions and no others: is the criterion met, does the test prove it, and is the code good and consistent with what is already in the files it touches. Security, architecture and performance are left out on purpose — ship re-runs all three over the branch, where they belong.

### Acting on what the review found — the `review-fix` phase

`review` returns to the gate with findings, and the gate phase writes nothing (`'*': 'deny'` — only `other`). Fixing them there is refused. Go to the phase built for it:

```
keel state phase review-fix     # legal from gate
# fix what the review found — production code AND test files are both writable here
keel commit fix AC-00n "review — <what changed>"
keel state phase gate           # back to the gate, decide again
```

**`review-fix` is the one phase that allows tests and production code together**, and that is deliberate: a review finding is sometimes *"this test asserts the wrong thing"*, and a loop that could only change production code would force you to make the code match a bad test. RED's freeze exists to stop you quietly weakening a test to get green — not to stop you fixing one a reviewer just showed is wrong.

**Cap it at two rounds**, the same as ship. A third means the review and the implementation disagree about something neither will settle — stop and put it to the user.

Sort each finding before you fix anything, because two of the three are not fixes:

| The finding says | What it actually is |
|---|---|
| the code is wrong | a fix — `review-fix`, then back to the gate |
| the test is wrong | also a fix, and the reason this phase allows test files |
| **the criterion is wrong** | not a fix. `reject --note` puts the AC back to `todo` and the phase back to `red` |
| **the spec is wrong** | not a fix either — the amendment path, in the main flow |

A finding fixed in `review-fix` stays inside this AC and keeps its own commit, so the trace table still shows what changed and why after a human asked for the review.

### Show them the review and the fix before deciding the gate again

**A human asked for this review. Do not answer it on their behalf.** Coming back with "reviewed and fixed, approve?" hides the two things they actually wanted: what the reviewer said, and what you decided to do about it. Put all of it up before the gate decision:

- **What the reviewer found** — each finding in its own words, not your summary of it. Blocking and non-blocking, separated.
- **What you changed**, per finding, and the `keel commit fix` sha.
- **What you did not change, and why.** This is the part that gets dropped and the part that matters most: a finding you judged wrong, out of scope, or already covered is a decision you made on their behalf, and it is invisible unless you say it.
- **Anything that turned out not to be a fix** — a criterion or a spec problem, and which path you propose for it.

Then ask for the gate decision. They may still reject after seeing it, which is the point: the review is evidence for their decision, not a substitute for it.

## When it stalls

Every failure is fingerprinted. The same fingerprint `loops.stall_repeats` times (default 3) is a stall, and a new fingerprint resets the count. One ladder step per stall:

1. Re-read the trimmed failure and the AC; do not guess.
2. Ask `keel:investigator` for a fresh-context diagnosis before the next attempt.
3. Step the model up for the next attempt.
4. Stop and ask the user: the failure, what you tried, the two options you see.

`caps.red_turns` (8) and `caps.green_turns` (15) are backstops, not the primary signal. `keel stall reset` clears the counter after a real change of approach.
