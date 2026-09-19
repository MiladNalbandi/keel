---
name: change
description: Work without a spec: triage the change as trivial or small, run the AC loop for small changes, and escalate to the spec flow when a trigger fires. Use for small work, refactors, and quick fixes.
disable-model-invocation: true
argument-hint: "<description> [--trivial|--small] [--yes]"
---

# keel:change — $ARGUMENTS

## 1. Triage

Ask one question: **could a test notice a difference?**

- **No** → trivial: refactor, rename, formatting, docs, dependency bump, UI typo.
- **Yes** → does it touch the contract, a migration or auth, or need more than 3 ACs?
  - Yes → stop and recommend `/keel:feature`.
  - No → small change with 1 to 3 acceptance criteria.

Show the proposed size, the reason, the files you expect to touch, and for a small change the draft ACs. Confirm with `AskUserQuestion` unless `--yes`.

## 2. Start the flow

```
keel state start change --size <trivial|small> --phase <trivial|red>
keel state ac CHG-<n>.1 --layer API --current      # small changes only
```

## 3. Trivial

Make the change. Do not touch existing tests, the contract or migrations. Then:

```
keel commit trivial <area> "<imperative message>"
```

If keel refuses, it was not trivial: rerun as a small change.

## 4. Small

For each AC, in order, run the loop from `keel:feature`: RED, `keel state red-done`, `keel commit red`, GREEN, `keel state green-done`, `keel commit green`. The human gate is at the end by default.

## 5. If a trigger fires

`keel commit` stops when the contract, a migration or auth changed, or the change grew. Ask the user: escalate, or stay small with a reason.

```
keel escalate                          # inline ACs become a spec, commits kept
keel escalate --override "<reason>"    # stay small, reason recorded
```

## 6. Finish

`/keel:ship`.
