# The Flows

Every piece of work runs in a **flow**: a fixed order of **phases**. Each phase decides which files
may be written, and a hook enforces it on every edit.

| Command | Use it when |
|---|---|
| `/keel:init` | setting up a repo, once |
| `/keel:feature` | a feature touches the API contract, data or auth |
| `/keel:change` | a small change, no spec |
| `/keel:fix` | a bug you can reproduce |
| `/keel:diagnose` | a bug you cannot reproduce yet (read-only) |
| `/keel:hunt` · `/keel:hunt-next` | finding bugs you do not know about, then taking the next one |
| `/keel:review` · `/keel:review-pr` | reviewing your own branch · someone else's PR (see [[Code Review]]) |
| `/keel:cover` | closing coverage gaps on changed lines |
| `/keel:ship` | a branch is done: checks, reviewers, final review, PR |
| `/keel:status` · `/keel:memory` | where am I · what keel knows about the project |

## Feature

```
preflight → workspace → spec → contract
                                  ▼
               ┌──► RED ──► GREEN ──► gate ──┐   once per acceptance criterion
               └─────────────────────────────┘
                                  ▼
 full review → integration → security? → smoke? → e2e? → ship → final review → memory → close
                              (? = optional, chosen once at the start)
```

- **spec**: numbered, layer-tagged criteria (`AC-001 [API] …`) and the plan, approved by a human.
- **RED**: write the failing test; production code is frozen.
- **GREEN**: the minimum code to pass; tests are frozen.
- **gate**: a human approves, asks for a review, rejects or skips.
- **full review**: one reviewer reads the whole branch, right after the last criterion.
- **security, smoke, e2e**: optional. Smoke runs first because it is the quick check.
- **ship**: verify, coverage, reviewers in parallel, final human review, PR. Smoke and E2E always run here.

Repair phases (`refactor`, `review-fix`, `coverage-fix`) fix one kind of thing and hand back.

## Fix

```
bug-report → workspace → bug-repro → Gate R → bug-investigate → Gate F → bug-fix → e2e → ship
```

Gate R: "is this the bug you meant?" Gate F approves the fix plan; code stays locked until then.

**Where am I?** `keel status`, or the [[Dashboard]].
