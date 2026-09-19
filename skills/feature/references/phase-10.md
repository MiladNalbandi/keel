# Phase 10 — close

After the PR merges. Without this the flow never formally ends, and the next one starts on top of stale state.

```
keel state phase close
# write an ADR if a decision had a real alternative
keel state close
```

## The ADR

One per decision that had a genuine alternative — not one per feature. `docs/adr/NNNN-title.md`:

- **Context** — the forces, in three sentences.
- **Decision** — what was chosen, in the present tense.
- **Alternatives** — what else was considered and why it lost.
- **Consequences** — what this makes easy, and what it makes hard.

An ADR is immutable once merged. Supersede it with a new one that references it by number rather than editing it.

If nothing had a real alternative, write no ADR. A file recording "we used the obvious approach" is noise.

Commit it with `keel commit docs ADR-NNNN "<title>"` — the `close` phase allows the `specs` and `other` buckets and denies application code.

## `keel state close`

Archives the whole flow state to `.keel/archive/<flow>-<spec>-<timestamp>.json` and clears the working state, so `keel status` reports no active flow. The archive keeps the AC table, both commit shas per AC, the gate log with every skip and forced transition, the unlock log, and the flaky record — which is what makes a past flow auditable after the branch is gone.

It reports `<done>/<total> ACs done`. If that is not what you expect, check the board before closing.

## Then

`/clear`. The next flow starts from `keel preflight`.

## Failure modes

- **"no active flow to close"** — it was already closed, or `keel state abort` was used. `abort` throws state away without archiving; `close` is the one that keeps the record.
- **ACs not all done** — closing does not check. If the count is short, something was skipped: look at the board and the gate log before you archive.
- **The branch is still open** — close is about keel's state, not git's. Delete the branch separately once the merge is confirmed.
