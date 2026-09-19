---
name: diagnose
description: Read-only investigation for a bug you cannot reproduce yet. Fans out parallel hypotheses, produces evidence and a reproduction recipe, then hands off to the fix or feature flow. Use when you do not yet know what is happening.
disable-model-invocation: true
argument-hint: "<symptom>"
---

# keel:diagnose — $ARGUMENTS

`/keel:fix` needs a committed failing test before Gate R. That ordering is deliberate — it
stops a fix landing for a bug nobody demonstrated — but it leaves no entry point for the
hardest bugs: intermittent failures, races, production-only behaviour, anything you cannot
make fail on demand yet.

This flow fills that gap. **It changes nothing.** No production code, no tests, no commits
beyond an investigation note. Its only output is understanding, and ideally a recipe.

## 0 — frame the symptom

Write down, in the reporter's words: the exact error text, when it happens and when it does
not, what was expected, and what is already known to be irrelevant. Then:

```
keel state start fix --phase bug-investigate
keel state ac BUG-<n> --layer API --current
```

The `bug-investigate` phase denies every writable bucket but `other`, so the guard enforces
the read-only rule rather than relying on discipline.

For a UI symptom with Claude in Chrome enabled, look at it first — page, console, network.

## 1 — fan out on competing hypotheses

List three or four **distinct** candidate causes, then send one `keel:investigator` per
hypothesis **in parallel**. They are read-only, so running four costs tokens and nothing
else — and it beats the serial three-attempts-then-escalate loop, because competing
hypotheses do not contaminate each other.

Give each agent the symptom, the evidence so far, and **one** hypothesis to confirm or kill.
Do not tell an agent what the others are testing.

Each returns evidence and ends `ROOT-CAUSE: confirmed` or `ROOT-CAUSE: unconfirmed`, and the
`SubagentStop` hook blocks it if that line is missing.

Load the `keel:debugging` skill for technique: `references/bisect.md` for "when did this
start", `references/logs-and-traces.md` for reading the failure, and
`references/data-forensics.md` for read-only SQL.

## 2 — rank what came back

Write up, in one place: each hypothesis, confirmed or killed, and the evidence either way.
Killed hypotheses matter as much as the surviving one — they are what stops the next session
retracing the same ground.

Then try to produce a **reproduction recipe**: the exact conditions under which it fails.
Concurrency of eight; a row whose url differs only by case; the second run against a dirty
database; ten thousand rows. A recipe is what makes this flow worth running, because it is
what `keel:reproducer` needs.

## 3 — the gate: three exits

Show the user the ranked causes, the evidence, and the recipe if you have one. Then one
question, with three answers:

| Exit | When | What to do |
|---|---|---|
| **Hand to `/keel:fix`** | You have a reproduction recipe | Start the fix flow and give `keel:reproducer` the recipe — not the cause. It must write the test from the symptom, or it will confirm your theory instead of the bug. |
| **Hand to `/keel:feature`** | It is not a defect: the behaviour was never specified | Start the spec flow with the evidence as input. Do not fix an unspecified behaviour inside a bug flow. |
| **Record unresolved** | Nothing confirmed | Write the note, keep every killed hypothesis, and stop. `keel state abort` clears the flow. |

Never end this flow by starting to fix something. The whole value is that it stopped before
guessing.

## Notes

- Keep the investigation note out of the way: `docs/` or the spec folder, not the source tree.
- If a hypothesis needs a write to test, it is not a diagnosis step — it belongs after Gate F
  in `/keel:fix`.
- This is also where the stall ladder's step 2 belongs: when a loop repeats the same failure
  three times, a fresh-context diagnosis is this flow in miniature.
