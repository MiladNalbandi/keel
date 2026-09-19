# Escalating a change

A change grew past what a change flow should carry. Escalating keeps everything already done.

```
keel escalate                          # become a spec flow
keel escalate --override "<reason>"    # stay small, reason recorded
```

## What `keel escalate` does

1. Writes `specs/NNN-<branch-slug>.md` with the numbered next index, containing the Context, an Acceptance criteria list built from the inline ACs — each marked `(done)` if its status is already `done` — plus empty Out of scope, Contract changes and Smoke checks sections.
2. Sets the flow to `feature`, size `full`, spec to that file, phase to `spec`.
3. Logs `escalated to spec flow` in the gate log.

**Nothing is redone.** The branch stays, every commit stays, and finished ACs stay finished. You resume at spec approval: add the ACs the change flow did not have, get them approved, and continue. The contract phase runs if the contract was the trigger.

## What `--override` does

Records `escalation-override: <reason>` in the gate log and lets the commit through. The reason appears in the final human review and in the PR body, so staying small is a visible decision rather than a quiet one.

Use it for a **suggest** trigger you disagree with — "both apps changed" because one line of copy moved, say. Using it to bypass a **must** trigger (contract, migration, auth) is possible and almost always wrong: those three are the changes whose blast radius the spec flow exists to contain.

## Which triggers are which

Must: the contract changed, a migration was added or changed, a path in `change.auth_paths` changed.
Suggest: both apps changed, more than 10 files, more than 3 ACs.

`keel check-size` shows the current diff's triggers without committing anything.

## Failure modes

- **Escalating with no ACs registered** — the spec gets a placeholder `- AC-001 [API] …`. Register the inline ACs first so the spec starts from real content.
- **The branch name makes a poor slug** — the spec filename comes from it. Rename the branch before escalating if it matters.
- **Escalating twice** — the second run writes a second spec file. Check `keel status` for the spec already attached before running it.
