# The Flows

Every piece of work runs inside a **flow**. A flow is a fixed sequence of **phases**, and each phase
decides which files may be written. The pre-tool hook enforces that table on every edit.

| Command | Use it for |
|---|---|
| `/keel:feature` | a specced feature, with the full acceptance-criteria loop |
| `/keel:change` | a small change, no spec |
| `/keel:fix` | a bug: reproduced before it is fixed |
| `/keel:diagnose` | a bug you cannot reproduce yet (read-only) |
| `/keel:hunt` | a read-only sweep for bugs, producing a proven backlog |
| `/keel:ship` | finishing any branch the same way every time |

## The feature flow

```
preflight → workspace → spec → plan → contract
                                        │
             ┌──────────────────────────┘
             ▼
   ┌──► RED ──► GREEN ──► gate ──┐      one loop per acceptance criterion
   └─────────────────────────────┘
             │ all criteria done
             ▼
 integration → security → e2e → smoke → ship → final review → memory → close
```

- **spec**: numbered, layer-tagged acceptance criteria (`AC-001 [API] …`), approved by a human.
- **RED**: write the failing test. Production code is frozen.
- **GREEN**: the minimum code to pass. Tests are frozen.
- **gate**: a human decides whether the criterion is really met: `approve`, `review`, `reject` or `skip`.
- **ship**: verify, coverage, audit, trace, reviewers in parallel, then the final human review and the PR.

Off the main line there are repair phases: `refactor`, `review-fix` and `coverage-fix`. Each exists
to fix one kind of thing and then hand back.

## The fix flow

```
bug-report → workspace → bug-repro → Gate R → bug-investigate → Gate F → bug-fix → e2e → ship → close
```

Gate R asks "is this reproduction the bug you meant?". Gate F approves the fix plan. Production code
stays locked until Gate F.

## Where am I?

```
keel status      # flow, phase, criteria, agents in flight, what blocks a push
keel todos       # the same as a checklist
```

Or open the [[Dashboard]].
