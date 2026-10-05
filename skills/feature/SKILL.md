---
name: feature
description: The spec flow: interview, spec with numbered acceptance criteria and the plan under them, contract, one AC at a time with RED and GREEN commits, a full-diff review, integration, then optional security, smoke and E2E, then ship. Use for features touching the API contract, data or auth.
disable-model-invocation: true
argument-hint: "<idea> [--spike] [--gates every-ac|end-of-lane|end] [--skip security,smoke,e2e]"
---

# keel:feature — $ARGUMENTS

Read one phase reference at a time from `references/` instead of loading everything: `phase-0.md` … `phase-9.md` for the phases, and `ac-loop.md` for the loop itself.

## Phase 0 — preflight

```
keel preflight <NNN-slug>
```

It proves the ladder passed on this machine, the tree is clean, every required command is configured and Docker is up, then creates the branch. If it reports "not ready", fix what it names — do not work around it. If keel is not configured at all, stop and run `/keel:init`.

Ask one picker with `AskUserQuestion`: flow size (full or spike), gate mode (every-ac, end-of-lane, end), and **which optional phases run** — security, smoke, E2E (multi-select, all on by default). Then:

```
keel state start feature --gates <mode> [--skip security,smoke,e2e --skip-reason "<why>"]
```

This is the only time those three are asked about. Later phases do not ask again; the CLI steps over a skipped phase and prints the next one. Ship still runs smoke and E2E inside `keel verify release`, and still has its security lens and dependency check — skipping here moves those checks to ship, it does not remove them.

## Phase 1 — interview, spec and plan

One phase, one gate, one commit. The interview, the criteria and the plan that says which files each criterion touches all land in the same document, and the human is asked about it once:

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

**The order inside the phase is load-bearing.** Criteria first, explorers second. A spec written with the code already open describes what is convenient rather than what was wanted, and nothing afterwards can tell the two apart — so the explorers do not run until the AC list is settled. What that buys, and what breaks if you reorder it, is under *What `approved` still certifies* below.

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

### If it touches the schema, it gets its own section

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

### Write it a piece at a time, and show each piece

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

### Then the explorers, and the plan under the criteria

Only once the AC list is settled. Ask `keel:explorer` for the files each AC touches — one per area (API, web, data), all in a single message so they run in parallel. They are read-only, capped at 60 lines, and deliberately **do not** comment on architecture: that prohibition is what keeps the AC loop free of drive-by refactors.

Append a `## Plan` section to the same spec file: **AC order** (dependencies first — the AC that creates the row before the one that reads it), **files per AC** from the maps, the **contract delta** or "none", the **test layer per AC** (the lowest that can express it), and the **lane assignment** — if both lanes have work, say here whether the web lane runs interactively in a second terminal or in the background. It cannot start until after the contract commit in phase 2, because both lanes need the generated client.

Show the order and the per-AC file list as you write them, the same way you showed every other piece.

The explorers' **exposures** — concurrency, idempotency, authorization, data shape — arrive here, and this is the reason they run inside this phase instead of after it. A criterion they surface goes into the list now, before the freeze; a phase later it would cost an amendment to a document minutes old.

### Closing the phase — one blocking question, not a vibe

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

### What `approved` still certifies

**That the criteria were agreed before anyone read the implementation.** This is the guarantee the merge could have quietly destroyed, and the only thing protecting it is the order inside the phase: interview and criteria from what was wanted, explorers afterwards, code never open while the AC list is still being written. Run the explorers first and the spec starts describing the code that already exists — which looks identical on the page, six months later, to a spec that did not.

So: if you find yourself reading source to decide what a criterion should say, you have crossed the line this phase is built around. Ask the user instead.

Then **tell them to start a fresh session for phase 2** and stop. The frozen spec is the whole context the contract needs; carrying the interview transcript into it buys nothing and crowds out the contract file.

## Phase 2 — contract

Edit the contract file, regenerate both sides, then `keel verify fast`.

**Show the contract delta and ask before committing it.** This is the only artifact in the flow with consumers outside this branch, and the cheapest moment to catch a mistake in it — after this commit, generated code exists on both sides and every AC is written against it, and it is the last point at which both lanes still agree.

A contract change can be entirely valid and still wrong: a renamed field, an enum narrowed, a response that became nullable, a status code a client's error handling does not expect, a required request field added where old callers send nothing. `keel verify fast` proves the shape compiles and the sides match each other. It cannot know who else is calling this.

Put the delta in front of them as a diff, not a summary — endpoint by endpoint, marking what is new, what changed shape, and anything **removed or narrowed**, which is the half that breaks callers:

| Choice | What happens |
|---|---|
| **Approve** | `keel commit contract SPEC-NNN "<what changed>"` |
| **Change it** | say what, amend the contract, regenerate, come back here |
| **This breaks a consumer** | not a contract problem — the spec assumed something untrue. Go back and amend it |

Then commit with `keel commit contract SPEC-NNN "<what changed>"`.

## Phases 3 and 4 — the AC loop

For each AC in plan order (`references/ac-loop.md` has the details):

```
keel state phase red
# write only this AC's tests, tagged with the AC ID
keel state red-done
keel commit red AC-00n "<what it asserts>"
# write the minimum production code
keel state green-done
keel commit green AC-00n "<what it does>"
keel gate ac approve|review|reject|skip
```

With `loops.red_author: subagent`, delegate the RED step to `keel:test-author`; with `loops.green_author: subagent`, delegate GREEN to `keel:implementer`. The hooks block production code in RED and test files in GREEN either way, and edits are scoped to the current lane. If a loop stalls, follow what keel prints.

`keel state green-done` tells you whether a human gate is due for this AC and what to do when it is not — it resolves the gate mode, an at-gate skip, a `[gate: skip]` tag and a background lane in one place, so do not decide that yourself.

### Running the two lanes in parallel — ask, do not decide

Only after the contract commit, and **only if the user says so**. This is not a model decision: it changes how many terminals they are watching, whether a whole lane's human gates happen at all, and whether the review at ship is over work a person saw being written. Put it to them with `AskUserQuestion` once the contract is committed and the spec has `[WEB]` criteria:

| Choice | What it means |
|---|---|
| **Sequential** (default) | one lane at a time in this session. Every gate happens. Simplest to follow, slowest in wall-clock |
| **Parallel, interactive** | `keel lane start web`, second terminal, they drive it. Both lanes keep their gates |
| **Parallel, background** | `keel lane start web --background` hands the lane to `keel:lane-runner`. Faster, and **that lane's human gates are skipped by definition** — say this out loud before they choose, not afterwards |

Default to sequential when they have no preference. The background lane trades a category of review for wall-clock, and that is a trade only they can price.

The mechanics once chosen — backend stays in this session; the frontend lane gets its own worktree, branch and stack, so the two never share a port or a database:

```
keel lane start web                  # interactive: open a second terminal there
keel lane start web --background     # or hand the lane to keel:lane-runner
keel lane start web --acs AC-004,AC-005   # or name the criteria yourself
keel lane status
```

`lane start` hands the lane its own seeded state — its criteria, its branch, its lane name — and takes those criteria off this session's board, where they then read `lane`. The two sessions never pick up the same work, and the edit hook holds each side to its own directories while the lane is open. A background lane goes to `keel:lane-runner`, which works inside that worktree and never runs a keel command from here.

In a background lane that lane's human gates are skipped by definition; every automatic check still runs. `keel lane merge web` brings it back before phase 5 — it refuses while criteria are unfinished unless you pass `--force`, folds the lane's criteria and gate log into this session's state so `keel trace` and the PR body can see them, and reports the files if it conflicts. Approving the last criterion here holds at the gate rather than moving on to integration while a lane is still out.

### When something looks missing — check the spec first

Most things that look missing are not. Before concluding the spec is wrong, **read it again properly**, and say which of these it is:

- **Already there, under different words.** Search the whole spec, not the AC you are on — validation rules, the data section and the drawings carry criteria the numbered list does not repeat.
- **Covered by a different AC**, possibly one not started yet. Check `keel state show` before deciding a behaviour has no home.
- **Deliberately out of scope.** That section exists to be load-bearing. Something listed there is answered, not missing.
- **A criterion you are reading too narrowly.** An AC is a statement of behaviour, not a spec of the implementation; the freedom to choose how is not a gap.

Only when none of those hold is something genuinely absent. That is a real event — and the spec is deliberately frozen while the loop runs: `specs/` is denied in `red`, `green` and `gate`, so you cannot quietly edit it to match what got built.

### When the spec turns out to be wrong

It happens. An AC meets the code and proves impossible, a criterion nobody thought of surfaces in RED, the shape agreed in phase 1 does not survive contact. **That is the loop working, not a failure of it.**

**Tell the user before you touch it.** Do not amend and mention it afterwards, and do not fold the amendment into an explanation of what you were doing anyway. State plainly: the spec was approved and frozen, here is what it says, here is what the code shows, here is why they cannot both be true. Say what the amendment would change and which ACs it affects — including any already green. Then stop, and let them decide. They approved this document; a change to it is theirs to make, not yours to report.

Then amend it, in the open:

```
keel state phase spec          # legal from red, green or gate
# amend specs/NNN-slug.md — as a dated block, never a silent edit
keel state ac AC-00n --layer API     # register a new criterion, if one appeared
keel ask spec-amended --blocking --by feature \
  --question "AC-00n <what changed and why>. Approve the amendment?"
keel commit docs SPEC-NNN "amend: <what changed>"
keel state phase red           # or contract first, if the shape of the API moved
```

### The amendment gate — write the block, then ask before committing it

Write the dated block first so there is something concrete to judge, then **stop before `keel commit docs`**. Show them the block as it now reads, what it changes, which ACs it touches — including any already green — and what you propose to do about each. Then put it with `AskUserQuestion`:

| Choice | What happens |
|---|---|
| **Approve the amendment** | `keel commit docs SPEC-NNN "amend: …"`, then back to the loop — `keel state phase red`, or phase 2 first if the API shape moved |
| **Let me give you context** | they explain what you were missing. Rewrite the block with it, show it again, ask again. This is the common one, and the reason to ask before committing rather than after |
| **Change the amendment** | it is close but wrong — they say how, you revise, and it comes back here |
| **The spec needs rebuilding** | the amendment is not the problem; the spec is. See below |

Loop on the middle two as many times as it takes. **Only Approve leads to a commit** — nothing gets committed while a question is still open, which is what makes this a gate rather than a notification.

### When they decide the spec should be rebuilt

Sometimes an amendment is the third patch on a document that was wrong from the interview, and the right answer is to start it again. That is a legitimate outcome of this gate, not a failure — say so plainly, because a model that treats "start over" as defeat will argue for a patch that nobody wants.

```
keel state close        # archives the flow to .keel/archive/ and clears state
```

Two things to be straight about before they choose it:

- **It archives, it does not delete.** The spec, the state and every AC verdict go to `.keel/archive/`, so the old version is readable afterwards and worth reading — a spec that failed is evidence about the interview that produced it.
- **The commits stay.** `keel state close` clears keel's state; it does not touch git. Every `red` and `green` commit is still on the branch. Ask what they want done with them — kept as a starting point, or a fresh branch from the base — and do not decide it for them.

Then `/keel:feature` from phase 0 with what the last attempt taught you. Say what that was: the interview questions that were not asked, the identity probe that was skipped, the criterion that was never testable. Starting over without that is how the second spec fails the same way.

**Append the change, do not rewrite in place.** A criterion edited silently leaves a document that reads as though it always said that, and the reviewer at ship has no way to tell what was agreed in phase 1 from what was agreed on Thursday:

```markdown
## Amendments

### 2026-09-20 — AC-004
Was: the export runs synchronously and returns the file.
Now: the export is queued and returns a job id; AC-007 covers polling.
Why: the query takes 40s on realistic data — measured, not assumed.
Approved: <who>, via keel ask spec-amended.
```

Keep the original criterion visible in the `Was:` line. That is the difference between a spec with a history and a spec that quietly agrees with whatever got built.

The amendment is a **separate commit**, which is the whole point: a reviewer at ship can see the spec moved, when, and why. The failure this prevents is editing the spec to describe what was already built — that turns it from a contract into a transcript, and everything the flow claims about traceability stops being true while still looking true.

Two things to decide out loud rather than assume:

- **An AC already green under the old wording.** Its commit no longer matches its criterion. Either reopen it (`keel gate ac reject --note "spec amended"` puts it back to `todo` and the phase back to `red`) or say in the amendment that it shipped under the previous wording and why that is acceptable. Do not leave it unmentioned.
- **A changed API shape.** Go through phase 2 again — amend the contract, regenerate both sides, `keel commit contract` — before returning to the loop. An amended spec whose contract never moved is the same drift in a different file.

If the change is large enough that the plan no longer holds, that is not an amendment; go back to phase 1 and rewrite the plan section under the criteria.

## After the loop

```
last AC ──► lane merge ──► full review ──► integration ──► security? ──► smoke? ──► e2e? ──► ship
                              │  ▲                          (? = chosen at phase 0)
                              ▼  │
                           review-fix
```

Read one reference per phase. Each is short; load it when you enter the phase, not before.

## Phase 4.5 — full-diff review → `references/full-review.md`

The last AC gate moves to `full-review`. If a web lane ran, `keel lane merge web` first — the review needs the whole branch. One `keel:code-reviewer` (Sonnet, read-only) over `git diff main...HEAD`, given only the spec's ACs and scope. Then `keel state full-review pass|findings`. Findings go through `review-fix` and get **one** re-read; still findings after that, stop and ask.

## Phase 5 — integration → `references/phase-5.md`

Wire the real client to the real API: `keel verify module api` and `keel verify module web`. Tests are frozen; new behaviour here is a missed AC. Then show the diff since the contract commit and ask: `keel gate integration approve|skip [--note "..."]`. There is no review choice — the full-diff review just ran. The gate moves to the next phase the flow kept on.

## Phase 5.5 — security (optional) → `security` skill

Only if kept on at phase 0. Two pipelines in parallel: `keel:security-auditor` over the diff, and `keel verify deps --force` then `keel:dependency-triager` over what it reports. Clean → say so in one line and `keel state advance`. Any finding → stop and let the user decide each one: fix (`review-fix`, one `keel commit fix` each), accept with a reason, not a finding (say why), or a spec amendment. A dismissed finding is invisible later, so never dismiss one on your own.

## Phase 6 — smoke (optional) → `references/phase-6.md`

Only if kept on. Before E2E because it is the cheap check: a broken stack shows up in seconds, not inside a long E2E run. `[SMOKE]` checks as a script plus one `@smoke` test, seeding their own data. `keel commit smoke SPEC-NNN "<checks>"`, then `keel state advance`.

## Phase 7 — E2E (optional) → `references/phase-7.md`

Only if kept on. Check `commands.e2e` is configured first; if blank, ask `e2e-tool-missing --blocking`. Delegate to `keel:e2e-author` with only the `[E2E]` ACs and the URLs. `keel commit e2e AC-00n "<journey>"` per AC.

## Phase 8 — ship

**Ask before you start it.** Everything after the integration gate runs without stopping, so this is the first question since then. `/keel:ship` is long: verify, coverage, an audit, a trace, reviewers in parallel, up to two fix rounds. Stopping here is much cheaper than in the middle of it.

Put it to them with `AskUserQuestion`, with the state in front of them first — ACs done, the full-diff review verdict, what security found (or that it was skipped), what smoke and E2E cover (or that they were skipped and will run at ship), and anything still open:

| Choice | What happens |
|---|---|
| **Ship it** | `/keel:ship` runs the full sequence |
| **Show me the diff first** | walk the branch diff with them, then come back here |
| **Something is not right** | name it. If it is code, fix it before shipping; if it is the spec, that is an amendment and the loop is not finished |
| **Stop here** | leave the branch as it is. State is on disk; `keel status` says where to resume |

Then `/keel:ship`.

## Phase 9 — close

After the PR merges, write an ADR under `docs/adr/` for any decision that had a real alternative, then:

```
keel state phase close
keel state close          # archives the flow to .keel/archive/ and clears state
```

Say what shipped in one line and stop.
