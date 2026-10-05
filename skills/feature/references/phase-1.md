# Phase 1 — clarify, spec and plan

One phase, one gate, one commit. The interview, the criteria and the plan that says which files
each criterion touches all land in the same document, and the human is asked about it once.

```
interview ──► mockup + request path ──► numbered ACs
                                             │
                                   [ the AC list is settled ]
                                             │
                                   explorers (api / web / data)
                                             │
                                  files · order · test layer
                                             │
                                          THE GATE ──► commit, frozen
```

The order is the point. Criteria first, explorers second: a spec written with the code already
open describes what is convenient rather than what was wanted, and nothing afterwards can tell
the two apart. Running the explorers after the list is settled keeps what `approved` certifies
while still letting their findings land before the freeze.

## Before the first question

Load `keel:spec-authoring` and read its `references/clarify.md` **before asking anything** — the five questions, the per-task-type blocks, and the two probes most worth not skipping: identity, and work placement.

**The identity probe:** if the task mentions users, accounts, roles, login or permissions, settle *which of three things that means* before writing any criterion — a named entity with a foreign key, full authentication with sessions and tokens, or authorization over an auth layer that already exists. They differ by an order of magnitude in scope and all three get called "users". Write the answer into the spec. If it is authentication, stop: that is a design decision with real alternatives, not a criterion, and it usually wants its own feature.

**The work-placement probe:** if the task involves a list, a search, a filter, a sort, a total, a page of results or anything described as slow, settle **where the work runs** before writing any criterion — in the browser over data it already has, on the server in a query, or on both with the server as the truth. The three produce different acceptance criteria, a different contract, and different tests; picking by habit is how a filter that works on 40 rows becomes the thing that has to be rebuilt at 40,000. `clarify.md` has the readings, what each costs, and the one question that settles it.

Then interview with `AskUserQuestion`: edge cases, validation, authorization, data rules, error states, what is out of scope.

**Five questions the spec must answer before it is written** — if you cannot answer one from the interview, that is the next question to ask, not a gap to fill in yourself:

| | |
|---|---|
| What exactly is being built? | scope creep, and building the wrong thing |
| Where does it live? | architectural misfits |
| What pattern does it follow? | consistency with what is already there |
| What must not break? | regressions |
| How will we know it is done? | a testable exit condition — this one becomes the ACs |

**Stop and clarify rather than proceed** when: you are guessing what the user actually wants; the work touches more than three modules; you cannot tell which of two existing patterns to follow; the requirements contain *later*, *eventually* or *maybe*; or it changes a public interface or a database schema. The last one is not a nudge — see below.


## Ask with real options, not open questions

`AskUserQuestion` takes 2–4 options per question, and the options are the work. "What should happen on a duplicate URL?" is a prose question wearing a selection box; the useful version names the actual candidate behaviours and their consequences:

```
Q  A URL already saved — what should saving it again do?
   · Reject with 409 (recommended)   the list stays unique; the client shows the existing entry
   · Update the existing entry       last-write-wins; the original timestamp is lost
   · Allow a duplicate row           simplest; the list can show the same link twice
```

Each option says what it *means*, not just what it is called. Put your recommendation first and mark it, so answering is one keypress when the default is right.

Good questions to ask this way, because each has a small set of real answers: what an empty state shows, whether a failed save keeps the user's input, who may read another user's record, whether a limit is enforced or advisory, and what is explicitly out of scope. Ask open-ended only for the one thing a list cannot capture — usually "what is this for".

Two rules that keep it short: never ask what the code already answers (read it), and never ask what the mockup will force you to decide anyway — draw it and ask about the drawing.

`keel:spec-authoring`'s `references/clarify.md` carries the two probes worth never skipping: the **identity probe** (which of three things "user" means) and the **work-placement probe** (does this job run in the browser, on the server, or both). Both change the criteria list rather than decorate it.

## The spec file

`specs/NNN-slug.md`, from `templates/spec.md`. Sections: Context, Acceptance criteria, **UI mockup**, **Request path**, Data and migrations, Validation and security rules, Contract changes, Out of scope, Smoke checks, Decisions, and the **Plan** appended below them.

The two drawing sections come from `keel:spec-authoring`, and they are written **before** the criteria list is final: an ASCII mockup of four states (default, empty, loading, error) for any `[WEB]` criterion, and an ASCII request path marked `+` new / `~` changed for any `[API]` one. They are not documentation of an agreed spec — they are how the missing criteria get found. Run `keel spec check` before asking for approval.

Every AC is numbered, layer-tagged and testable:

```
- AC-001 [API] Given <state>, when <action>, then <observable result>
- AC-004 [WEB] …
- AC-006 [E2E] …
- AC-007 [SMOKE] …
```

Layer tags drive real behaviour: `[API]` ACs run in the `api` lane, `[WEB]` in `web`, and RED/GREEN edits are scoped to that lane. `[E2E]` is phase 6, `[SMOKE]` phase 7.

Tag a genuinely trivial criterion `[gate: skip]` to skip its human gate — keel reads the tag from the spec line when the AC is registered.

## If it touches the schema, it gets its own section

A schema change is the one part of a feature that is **hard to undo, runs against data you did not create, and fails in production rather than in a test**. So it does not live in a "data notes" bullet. It gets a `## Migration` section in the spec, and it is written before the criteria are settled, because the strategy decides what the criteria are.

**Ask these before choosing anything** — the answers are the whole difference between a migration that is a formality and one that takes the table offline:

| Ask | Why it changes the answer |
|---|---|
| How many rows are in the table now? How fast does it grow? | 10k rewrites instantly; 100M does not. The same DDL is two different operations |
| Is it written to continuously, or is there a quiet window? | decides whether a lock of any length is survivable |
| Must the app stay up through it? | decides expand-contract versus a stop-the-world change |
| Are there read replicas, and do they lag? | a long migration on the primary becomes a stale-read window |
| Is there existing data that would violate the new rule? | a unique or NOT NULL constraint fails at apply time, on production data, after the deploy has started |

**Check rather than assume.** `SELECT count(*)`, and for a constraint you are about to add, run the query that finds the rows which would violate it. Do it against a copy or a disposable database — never truncate or delete on a shared one. A migration written against an imagined table is the most common way this phase fails.

**Then name the strategy explicitly**, by what the change is:

| Change | Strategy |
|---|---|
| Add a nullable column | safe, apply directly |
| Add NOT NULL | add nullable → backfill in batches → set NOT NULL. Never in one statement on a large table |
| Backfill | batched with a bound, resumable, and stated in rows-per-batch — not one `UPDATE` |
| Add an index | `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction — Flyway needs that migration marked accordingly |
| Add a unique constraint | find the violating rows first, decide what happens to them, *then* add it |
| Drop or rename a column | expand-contract across two releases: stop writing, deploy, then drop. Never one release |
| Change a type | expand-contract — new column, dual-write, backfill, cut over, drop |

**Reversibility is part of the strategy, not an afterthought.** Say what rolling back does, and what happens to rows written between the deploy and the rollback. "We would roll forward" is a valid answer; not having one is not.

**The strategy becomes acceptance criteria**, tagged `[API]` — the migration applies cleanly to a database with realistic data, the backfill is resumable, the constraint holds afterwards. A migration whose only test is "the app started" has not been tested.

Then **draw before you finish the criteria list** — the drawings are how you find the criteria the interview missed:

- a `## UI mockup` in ASCII showing four states — default, empty, loading, error — when the spec has any `[WEB]` criterion. Drawing the empty and error states is what surfaces the criteria nobody mentioned.
- a `## Request path` in ASCII when it has any `[API]` criterion: endpoint → controller → use case → repository → table, each box marked `+` new or `~` changed, with both the success and the failure response drawn.

Show both in the terminal as you write them, and keep them inside 80 columns.

Then write `specs/NNN-slug.md` from `templates/spec.md`, which carries the shape. Its frontmatter is not decoration: `status`, `created`, `approved`, `frozen`, `superseded_by` and `contract` are what let a reader six months later tell a live spec from a frozen one from a replaced one, without the terminal you had.

- **user stories** — one per distinct actor. If they all have the same role there is probably one; if a story has no *so that*, it is a task with a role bolted on
- numbered ACs, each tagged `[API]`, `[WEB]`, `[E2E]` or `[SMOKE]`, each testable
- data and migration notes, validation and security rules
- out of scope, contract changes, smoke checks
- a **definition of done** — mostly enforced, and worth writing because the two or three lines that are not are the ones that get skipped

## Write it a piece at a time, and show each piece

**Do not write the whole spec and then ask once.** A spec presented finished gets read as finished: the user skims a page of text they did not watch being built, and the criterion that is subtly wrong is the one nobody stops on. Go a section at a time, put it in the terminal, and wait:

| Piece | What you are really asking |
|---|---|
| `## UI mockup`, four states | is this the screen you meant — especially empty and error |
| `## Request path` | is this the shape of the change, and is `+`/`~` right on every box |
| The numbered ACs | is each one true, testable, and are any missing |
| Data, validation, security | are these the rules, or the rules you assumed |
| Out of scope | the cheapest section to get agreement on, and the one that prevents the most argument later |

**A revision is a change too.** When they ask for something different, show the revised piece and confirm it — do not apply it silently and move on. Silent application is how a spec drifts from what was agreed while every individual step looked reasonable.

Register the criteria only once the AC list itself is settled: `keel state ac AC-001 --layer API` for each. Then run `keel spec check` — it names states you have not drawn, `[API]` criteria missing from the path, and empty sections; it warns rather than blocks, so decide with the gaps in front of you.

**Nothing is committed during any of this.** The spec file is written and rewritten freely; `keel commit docs` happens once, after the gate below, and never as a way to save progress mid-interview.

## Register the ACs

```
keel state ac AC-001 --layer API --current
keel state ac AC-002 --layer API
keel state ac AC-004 --layer WEB
```

`keel state board` shows what is registered.

## Then the explorers, in parallel

Only once the AC list is settled. Start one `keel:explorer` per area — API, web, data — in a single message so they run concurrently. Each returns a file map for the ACs in its area, the patterns to follow, and ends `MAP-END`. They are read-only and capped at 60 lines.

Explorers deliberately **do not** comment on architecture. That prohibition protects the AC loop from drive-by refactors; architecture is `keel:arch-surveyor`'s job at init, not a planning opinion.

Their **exposures** — concurrency, idempotency, authorization and data-shape findings — arrive here, before the freeze, which is the whole reason they run inside this phase rather than after it. Add them as criteria now, or the first one costs an amendment to a document that is minutes old.

## Append the plan

Under `## Plan`, in the same file:

- **AC order.** Dependencies first: the AC that creates the row before the one that reads it.
- **Files per AC.** From the explorer maps.
- **Contract delta.** Which paths and schemas change, or "none".
- **Test layer per AC.** The lowest layer that can express it.
- **Lane assignment.** The tags already decide it. If both lanes have work, say here whether the web lane runs interactively in a second terminal or in the background — it cannot start until after the contract commit in phase 2, because both lanes need the generated client.

## The gate — cannot be skipped

Spec approval is one of the two gates that can never be skipped, and it is the only one in this phase. Show the AC list, the order, the per-AC file list and whatever `keel spec check` still reports, then ask and wait for `--by user`.

On approval, set `status: frozen` and both `approved:` and `frozen:` to today, then:

```
keel commit docs SPEC-NNN "spec and plan"
```

From here `specs/` is denied in red, green and gate, and any change is a dated amendment.

**One date, two meanings, and both are true at once now.** `approved` still says the criteria were agreed before anyone read the implementation — the ordering above is what keeps that honest, not the calendar. `frozen` says nothing more will be appended. They used to be a phase apart because the document went on growing after the first gate; it no longer does.

Then **start a fresh session** before phase 2. State is on disk; the SessionStart hook re-injects a brief.

## Closing the phase — one blocking question, not a vibe

The piece-by-piece review above is where the spec actually gets agreed. This gate is the seam between agreeing it and building on it — everything after this point builds on the spec, and a criterion that is wrong here is wrong in a test, in the code, and in the review. It is one question over a document they have already watched take shape, not their first look at a finished page. Raise it as a question keel will not proceed past:

```
keel ask spec-approved --blocking --by feature \
  --question "Spec and plan written, <n> ACs registered in order, contract delta <summary>, spec check reports <n> gaps. Approve and start the contract?"
```

**One question covers both halves**, because they were agreed together and in front of the same person. It was two gates until the plan phase was folded in; the second one asked for approval of a document the user had already watched take shape, and bought a session boundary in the middle of writing it.

Put the decision in front of them before you ask — the AC list, the AC order, the per-AC file list, and each gap `keel spec check` named with what you propose to do about it. Then stop and wait. Do not answer it yourself: `--by user` is what separates a decision from a self-answer, and a spec the model approved on the user's behalf is the one failure this gate exists to prevent.

**Offer the ways of not approving, not just a yes.** A bare approve/reject makes disagreement expensive to express, and expensive disagreement gets skipped. Present these with `AskUserQuestion`, then answer the blocking question with whatever comes back:

| Choice | What happens |
|---|---|
| **Approve** | freeze it, commit, move to the contract |
| **Edit specific ACs** | ask which numbers, change them, come back to this gate |
| **Rewrite a section** | ask which — goal, validation, auth, edge cases, out of scope — rewrite, come back |
| **Review it first** | send the spec for an adversarial read before approving: vague, untestable or overlapping criteria are what it catches, and `keel spec check` cannot |
| **Change the order or the files** | the criteria are right but the plan under them is not. Rework that section, come back |
| **Reject** | the spec does not match the intent. Go back to the interview with what was missing — not a patch, a restart of phase 1 |

Every path except Approve returns here. Do not proceed on anything else.

**Plan mode's own approval is not this.** Accepting a plan in the harness confirms what you are about to do; it records nothing in keel, `keel ask list` does not know it happened, and the ship report cannot say a human saw the criteria. Both, in that order: the harness lets you act, the recorded answer is what makes it a decision anyone can audit later.

Once it is approved: set `status: frozen`, `approved: <today>` and `frozen: <today>` in the frontmatter, then `keel commit docs SPEC-NNN "spec and plan"`, which prints the same check again at the moment of the decision. From here `specs/` is denied in red, green and gate, and any change is a dated amendment.

**Approved and frozen together, now that the document stops growing here.** The two dates were a phase apart when the plan was appended after the spec gate; stamping `frozen` on a document that was still being written would have been a lie, so the freeze waited. It no longer has to.

## What `approved` still certifies

**That the criteria were agreed before anyone read the implementation.** This is the guarantee the merge could have quietly destroyed, and the only thing protecting it is the order inside the phase: interview and criteria from what was wanted, explorers afterwards, code never open while the AC list is still being written. Run the explorers first and the spec starts describing the code that already exists — which looks identical on the page, six months later, to a spec that did not.

So: if you find yourself reading source to decide what a criterion should say, you have crossed the line this phase is built around. Ask the user instead.

Then **tell them to start a fresh session for phase 2** and stop. The frozen spec is the whole context the contract needs; carrying the interview transcript into it buys nothing and crowds out the contract file.

## What makes an AC testable

- Observable from outside: what a user sees, what a client receives, what gets stored or sent.
- One requirement each. "Validates and emails" is two ACs.
- Small enough to map to one or two tests at one layer.

If you cannot imagine the test, the AC is too vague — that is the signal to ask another question, not to write it and hope.

## Failure modes

- **An AC with no layer tag** — it will default to `API` and land in the wrong lane.
- **A "non-functional" AC** ("should be fast") — turn it into a number and a layer, or move it to Out of scope.
- **Validation and security rules left empty** — phase 1's exit criteria include them, and the security review later has nothing to check against. An authorization rule written here is what makes an IDOR detectable.
- **The explorers run before the criteria** — then the spec describes the code that exists, and `approved` certifies nothing. Settle the list first, every time.
- **An AC whose files overlap another AC's** — order them adjacently and in one lane, or the second one's RED will fail on the first one's half-finished code.
- **A plan that renames things** — a rename is not part of an AC. It is a separate `/keel:change` before or after, because the AC loop's GREEN rule forbids code no test drives.
- **An explorer that returns nothing useful** — its area probably has no existing code. Say so in the plan instead of inventing structure.
