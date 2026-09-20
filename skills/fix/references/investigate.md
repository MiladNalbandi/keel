# Bug flow — investigate and Gate F

Phase `bug-investigate`. **Nothing is writable** but the `other` bucket: no production code, no tests. The point is to explain before changing.

```
keel state phase bug-investigate
# delegate to keel:investigator
```

## Delegating to `keel:investigator`

Read-only, Opus by default, capped at 40 turns. Give it the symptom, the failing test, and the evidence so far. It returns ranked hypotheses with evidence and ends `ROOT-CAUSE: confirmed` or `ROOT-CAUSE: unconfirmed` — the `SubagentStop` hook asks for it back if the line is missing.

What it may use:

- read-only code and git history, `git log -p`
- `git bisect run keel verify ac BUG-<n>` — the failing test makes bisect mechanical
- Gradle test reports
- `keel stack logs api --since 5m`
- read-only SQL through `docker compose exec db psql`, or a read-only database MCP when `mcp.database_readonly` is on

It cannot edit files. That is enforced by its tool list and by the phase matrix.

## Three hypotheses, then escalate the model

If three hypotheses come back unconfirmed, step the model up once rather than continuing at the same level. If it is still unconfirmed after that, report what was ruled out — a narrowed unknown is a real result, and better than a guessed fix.

## Gate F — the fix plan

Present: the root cause, the evidence for it, the files to change, the approach, the risk, **one alternative**, and whether a regression E2E test is needed. Then:

```
keel gate F approve                    # -> phase bug-fix, production code unlocked
keel gate F reject --note "<why>"      # -> back to bug-investigate
```

Gate F is what unlocks production code. Options are: approve; investigate more; change approach (you describe it, the plan is rewritten, it asks again); or **missing requirement** — this is not a defect, so stop the bug flow and hand the evidence to `/keel:feature`.

`--no-gates` records an automatic approval.

## Failure modes

- **A plausible cause with no evidence.** `ROOT-CAUSE: confirmed` means confirmed, not believed. A hypothesis that has not been tested against the failing test is still a hypothesis.
- **The plan names "refactor X" as the fix.** Almost always wrong: fix the cause narrowly, then refactor separately with a clean diff.
- **The investigator wants to change a file to test a theory.** It cannot, by design. Have it prove the theory from evidence instead — logs, history, a read-only query.
- **The cause is a missing requirement.** Take the fourth option. Forcing a requirement gap through a bug flow produces an untested feature.
