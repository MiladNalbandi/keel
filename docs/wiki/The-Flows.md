# The Flows

Every piece of work runs in a **flow**: a fixed order of **phases**. Each phase decides which files
may be written, and a hook enforces it on every edit.

| Command | For |
|---|---|
| `/keel:feature` | a specced feature, with the acceptance-criteria loop |
| `/keel:change` | a small change, no spec |
| `/keel:fix` | a bug, reproduced before it is fixed |
| `/keel:diagnose` | a bug you cannot reproduce yet (read-only) |
| `/keel:hunt` | a read-only sweep that produces a proven bug backlog |
| `/keel:ship` | finishing any branch the same way every time |

## Feature

```
preflight → workspace → spec → contract
                                  ▼
               ┌──► RED ──► GREEN ──► gate ──┐   once per acceptance criterion
               └─────────────────────────────┘
                                  ▼
 integration → security → e2e → smoke → ship → final review → memory → close
```

- **spec**: numbered, layer-tagged criteria (`AC-001 [API] …`) and the plan, approved by a human.
- **RED**: write the failing test; production code is frozen.
- **GREEN**: the minimum code to pass; tests are frozen.
- **gate**: a human approves, asks for a review, rejects or skips.
- **ship**: verify, coverage, reviewers in parallel, final human review, PR.

Repair phases (`refactor`, `review-fix`, `coverage-fix`) fix one kind of thing and hand back.

## Fix

```
bug-report → workspace → bug-repro → Gate R → bug-investigate → Gate F → bug-fix → e2e → ship
```

Gate R: "is this the bug you meant?" Gate F approves the fix plan; code stays locked until then.

**Where am I?** `keel status`, or the [[Dashboard]].
