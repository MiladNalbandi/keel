---
name: feature
description: Use for a feature that touches the API contract, data or auth: spec with numbered acceptance criteria, then one criterion at a time (failing test, then code), review, and ship.
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

## Phase 1 — interview, spec and plan → `references/phase-1.md`

One phase, one gate, one commit. **Read `references/phase-1.md` before asking anything** — it has
the probes, the schema rules, the piece-by-piece review and the gate choices.

```
interview ──► mockup + request path ──► numbered ACs ──► [settled] ──► explorers ──► plan ──► THE GATE
```

- **Criteria first, explorers second.** If you are reading source to decide what a criterion says,
  stop and ask the user instead.
- Show each piece (mockup, request path, ACs, rules, out of scope) and wait; a revision is shown too.
- A schema change gets its own `## Migration` section, with a named strategy and rollback.
- The spec lives in `specs/`, or `.keel/specs/` in layout keel/external — `keel spec new` picks the right one. In those layouts `keel commit docs` records the approval instead of committing.
- Gate: `keel ask spec-approved --blocking --by feature …`, offered as approve / edit ACs / rewrite a
  section / review first / change order or files / reject. Never answer it yourself.
- On approval: frontmatter `status: frozen`, `approved`, `frozen`; `keel commit docs SPEC-NNN "spec and plan"`.
  Nothing is committed before that. Then tell them to start a fresh session for phase 2.

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

### Parallel lanes → `references/lanes.md`

Only after the contract commit, and **only if the user chooses it** — sequential (default),
parallel interactive, or parallel background (that lane's human gates are skipped; say so first).
`keel lane merge web` before the full-diff review.

### When the spec looks wrong → `references/amend.md`

Read the spec again first — most "missing" things are there under other words, in another AC, or
out of scope. If it really is wrong: **tell the user before touching it**, write a dated
`## Amendments` block (keep the `Was:` line), ask `keel ask spec-amended --blocking`, and only on
approval `keel commit docs SPEC-NNN "amend: …"`. Never edit the spec silently.

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
