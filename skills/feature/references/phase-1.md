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
