---
name: hunt
description: Bug hunt: confirm the lens set, fan out one read-only agent per lens in parallel, prove every candidate against the running stack, render a ranked report, then drain the backlog one finding at a time into /keel:fix or /keel:feature. Use when asked to go and find the bugs.
disable-model-invocation: true
argument-hint: "<scope> [--lenses a,b,c]"
---

# keel:hunt — $ARGUMENTS

**A hunt changes nothing.** Its output is a backlog and a report. Every fix happens in a flow
started from `keel hunt next`, never here, and the guard enforces that in all five phases
rather than relying on you to remember it.

The flow exists because `/keel:fix` and `/keel:diagnose` both start from **one known symptom**.
Neither discovers anything, and neither leaves a record. This one does both.

Two rules carry the whole design. Read them before anything else:

- **A finding is a claim until something runs.** Reading code produces plausible prose; the
  report is only worth having because nearly every line of it says "proven by execution" and
  gives the command. Nothing gets a severity until a verifier reproduced it.
- **Findings share causes.** One defect routinely surfaces as three or four separate-looking
  symptoms across different lenses. Dispatched separately they become conflicting fixes to one
  line of code. Group them, and hand over the group.

## 0 — scope

```
keel hunt start --scope <all|diff|path,path>
```

It records the sha, the branch, the stack health and the proposed lens set, and repairs the
`.gitignore` block so the backlog never shows up in `git status` — an untracked backlog would
make `keel preflight` refuse, and preflight is step 0 of the fix flow this feeds.

If the repo is unfamiliar, send **one** `keel:explorer` for a map now and keep it: six hunters
sharing one map beats six agents each re-reading the tree. It ends `MAP-END`.

For the security lens, run `keel verify deps --force` **first**. `keel:dependency-triager`
states its own precondition — it stops if it was handed no scan output — and `keel verify deps`
stands down when no manifest changed, which on a whole-repo hunt is the normal case.

## 1 — confirm the lenses. This is the gate.

Show the user the proposed set with one line each on what it looks for, and ask them to drop or
add any. Then:

```
keel hunt lenses --confirm <a,b,c>
```

`keel hunt add` refuses every candidate until this has run, and this is the only command that
leaves `hunt-scope`. Fanning out first produces six result sets that cannot be ingested — so
skipping the question costs a full sweep, immediately and visibly.

## 2 — sweep

```
keel state phase hunt-sweep
```

One **`keel:hunter`** per confirmed lens, **in parallel**, each given exactly one brief from
`references/lenses.md` and **nothing about what the others are looking at**. That isolation is
the same rule `/keel:fix` states for competing investigators, for the same reason: hunters who
know each other's ground converge on the same obvious three findings and miss the rest.

Each ends `FINDINGS: <n>`. Write each JSON block to `.keel/hunt/incoming/<lens>.json`, then:

```
keel hunt add --lens <lens> --json .keel/hunt/incoming/<lens>.json
```

A lens-supplied severity is dropped here, and you are told it was. Nothing has measured
anything yet.

## 3 — prove

```
keel state phase hunt-prove
```

Bring the stack up first (`keel stack up`). Then one **`keel:prover`** per candidate, up to
`hunt.prove_concurrency` at a time. Give it the **symptom**, never the `claim` — a prover told
the theory confirms the theory.

| Verdict | Means | Recorded with |
|---|---|---|
| `proven` | a command produces the symptom, twice | `--repro <file>` and `--severity` |
| `unproven` | it could not be produced | `--evidence`: what was tried |
| `false` | the claim is wrong | `--evidence`: the check that is really there |

```
keel hunt prove F-003 --verdict proven --severity high \
  --evidence "..." --repro .keel/hunt/repro/F-003.sh
```

A `proven` verdict without a stored recipe is refused. The recipe is the deliverable — it is
what travels into the fix flow — and an evidence paragraph is not one. `unproven` is not a
polite `false`: it is kept, without a severity, so nobody mistakes it for either a confirmed
bug or a dismissed one.

## 4 — report

```
keel state phase hunt-report
```

With every verdict in, group the causes — this is the only point where one reader sees them
all:

```
keel hunt group F-003 F-007 F-011 --cause "<one sentence>" --lead F-003
keel hunt report
```

**The report is rendered from the backlog by the CLI, not written by you.** Do not hand-edit
it; rerun the command. It refuses to render while any finding is still a candidate, because a
report that mixes measured findings with unexamined guesses is the thing this flow exists to
stop being.

```
keel commit docs HUNT-<run> "bug hunt: N proven, M suspected"
```

Commit it before draining: `keel preflight` refuses a dirty tree.

## 5 — triage

```
keel state phase hunt-triage
```

Show the user the report, then one question with three answers:

| Exit | When | What to do |
|---|---|---|
| **Take the top group** | Something proven is worth fixing now | `keel hunt next --take`, then `/keel:fix` for a `defect` or `/keel:feature` for `unspecified` |
| **Close one** | It is known, accepted, or not worth fixing | `keel hunt close <id> --as accepted\|wontfix --note "…"` |
| **Stop** | The inventory is the deliverable | The backlog persists. `keel state abort` clears the flow, not the findings |

Two rules for the handover, both of which answer a way the manual version went wrong:

- **Dispatch the group, never the symptom.** The lead's recipe is the reproduction; the
  symptoms are extra regression criteria in the Gate F plan. Four findings become one fix with
  four assertions, not four fixes racing to edit one line.
- **Give `keel:reproducer` the recipe file, not the `claim`.** It must write its test from the
  symptom. Handing it a theory is how you get a test that passes for the wrong reason.

Draining continues across sessions with `/keel:hunt-next`. A twenty-finding backlog is not one
sitting's work, and `gates.bug_gates: false` exists for exactly this.

## Notes

- The backlog is per-machine and gitignored. It survives `git checkout` — which is what lets a
  hunt run on `main` and be drained into `fix/` branches — but not `git clean -fdx` or
  `git stash -u`, and it is invisible inside a `keel lane` worktree.
- `keel hunt list` flags a verdict taken on an older commit. Reprove before acting on it.
- If the lenses read shallow, `keel models set opus hunter --yes` and sweep again.
- **What keel cannot enforce:** nothing stops a prover writing to whatever `DATABASE_URL`
  points at. Point it at a disposable stack. The deterministic parts of this flow are the
  refusals — no severity without a verdict, no proof without a recipe, no report with an
  unexamined finding in it — and those are the parts that hold every time.
