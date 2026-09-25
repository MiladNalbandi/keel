---
name: review
description: Run one of keel's review agents on demand, outside the flow's own review points — the whole-branch code review, one lens or all lenses of the ship review, or one acceptance criterion's review. Read-only; it reports and never fixes.
disable-model-invocation: true
argument-hint: "[code | all | correctness|security|performance|architecture|assertions | ac <AC-ID>] [--base <ref>]"
---

# keel:review — $ARGUMENTS

The flow already reviews at four fixed points: the AC gate, phase 6.6, ship and the final review.
This is for the moments in between — a second look before asking for a gate, a performance pass on
one worrying change, a review on a branch that was never run through a flow. It starts the same
agents with the same scope the flow would give them, so the answer means the same thing.

## Pick the agent from the argument

| Argument | Agent | Scope |
|---|---|---|
| *(none)* or `code` | `keel:code-reviewer` | the whole branch diff |
| `correctness`, `security`, `performance`, `architecture` or `assertions` | `keel:reviewer`, that one lens | the whole branch diff |
| `all` | `keel:reviewer`, one per lens, **all in parallel in one message** | the whole branch diff |
| `ac AC-00n` | `keel:ac-reviewer` | that criterion's RED and GREEN commits |

Anything else: say which arguments exist and stop. Do not guess a lens from a near miss.

**The lenses for `all`** are `review.lenses` in `.keel/config.yml` (default `correctness`,
`security`, `performance`), plus `architecture` when `keel arch show` names a style. That is the set
ship runs; running a different set here would make the two disagree about what "all" means.

## Work out the scope before starting anything

**Branch diff.** The base is `--base <ref>` when given, otherwise `base_branch` in
`.keel/config.yml` (default `main`). Scope is `git diff <base>...HEAD`. If that diff is empty, say so
and stop: an agent sent to review nothing will find something to say anyway.

**One criterion.** Find its commits: the `red` and `green` columns of `keel trace`, or
`git log --format='%h %s' --grep='^test(AC-00n)'` for RED and `--grep='^feat(AC-00n)'` for GREEN.
With `loops.commit_style: single` there is no RED commit — test and code land together in one
`feat(AC-00n)` — so pass that one sha and say it is a single commit. If a paired project is missing
either commit, say which and stop; reviewing half a criterion reads as a clean result.

## Start it

Give each agent exactly what the flow would: the scope, the lens for `keel:reviewer`, and the AC with
its two shas for `keel:ac-reviewer`. Nothing about what you expect it to find — a reviewer told
where to look stops looking anywhere else.

## Report what it said, not your summary of it

- Each finding in the agent's own words, blocking and non-blocking separated.
- The verdict line exactly as it ended: `CODE-REVIEW: pass|findings`, `BLOCKING: yes|no`,
  `AC-REVIEW: pass|findings`.
- For `all`: one section per lens, then a one-line tally (`2 of 4 lenses blocking`).

**Do not fix anything, and do not move the flow.** This command reports. A verdict here does not
change the phase, pass a gate or count as one of ship's review rounds. If a flow is running and the
user wants the findings fixed, that goes through the phase built for it:

```
keel state phase review-fix
keel commit fix <AC> "review — <what changed>"
```

and then back to wherever the flow was. Say that once, at the end, only when a flow is running
and something was blocking.
