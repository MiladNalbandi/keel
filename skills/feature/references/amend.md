# When the spec looks wrong — check, then amend in the open

## When something looks missing — check the spec first

Most things that look missing are not. Before concluding the spec is wrong, **read it again properly**, and say which of these it is:

- **Already there, under different words.** Search the whole spec, not the AC you are on — validation rules, the data section and the drawings carry criteria the numbered list does not repeat.
- **Covered by a different AC**, possibly one not started yet. Check `keel state show` before deciding a behaviour has no home.
- **Deliberately out of scope.** That section exists to be load-bearing. Something listed there is answered, not missing.
- **A criterion you are reading too narrowly.** An AC is a statement of behaviour, not a spec of the implementation; the freedom to choose how is not a gap.

Only when none of those hold is something genuinely absent. That is a real event — and the spec is deliberately frozen while the loop runs: `specs/` is denied in `red`, `green` and `gate`, so you cannot quietly edit it to match what got built.

## When the spec turns out to be wrong

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

## The amendment gate — write the block, then ask before committing it

Write the dated block first so there is something concrete to judge, then **stop before `keel commit docs`**. Show them the block as it now reads, what it changes, which ACs it touches — including any already green — and what you propose to do about each. Then put it with `AskUserQuestion`:

| Choice | What happens |
|---|---|
| **Approve the amendment** | `keel commit docs SPEC-NNN "amend: …"`, then back to the loop — `keel state phase red`, or phase 2 first if the API shape moved |
| **Let me give you context** | they explain what you were missing. Rewrite the block with it, show it again, ask again. This is the common one, and the reason to ask before committing rather than after |
| **Change the amendment** | it is close but wrong — they say how, you revise, and it comes back here |
| **The spec needs rebuilding** | the amendment is not the problem; the spec is. See below |

Loop on the middle two as many times as it takes. **Only Approve leads to a commit** — nothing gets committed while a question is still open, which is what makes this a gate rather than a notification.

## When they decide the spec should be rebuilt

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

## 2026-09-20 — AC-004
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

