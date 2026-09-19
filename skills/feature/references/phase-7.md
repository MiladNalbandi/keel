# Phase 7 — end to end

The `[E2E]` acceptance criteria, against a running stack. Delegated, because browser exploration produces a lot of output that does not belong in the main session.

```
keel stack up
keel state phase e2e
# delegate to keel:e2e-author
keel verify e2e AC-00n
keel commit e2e AC-00n "<journey>"
```

## Before starting

Check migration drift — stale dev data is the most common cause of a confusing E2E failure:

```
keel stack migrate     # if keel reported pending migrations
```

`keel verify e2e` prints a drift note itself when it finds one.

## Delegating to `keel:e2e-author`

It explores the running app with `playwright-cli` (not Playwright MCP — the CLI keeps snapshots on disk instead of in the conversation), writes the spec, runs it, and ends `E2E-RESULT: pass` or `fail`. Capped at 40 turns. Give it the AC text, the URLs, and the fact that only `e2e/` is writable this phase.

## Rules

- Only the `e2e` bucket is writable. `api-main`, `web-src` and unit tests are all denied — if a component needs a test id, that is a `[WEB]` AC, not an edit here.
- Locators are roles, labels and text.
- Seed data **through the API** in fixtures, never by clicking through the UI.
- One spec per feature, one test per E2E AC, the AC ID in the title, tagged `@e2e`.
- The `line` reporter. On failure, report the failing step and the trace path — never paste a trace.

## Failure modes

- **Flaky on timing** — `verify` reruns a failure once and records a pass as flaky in state; it is reported at the gate and in the final review rather than hidden. Two failures is a real failure.
- **The stack is not healthy** — `keel stack up` waits for health. If it times out, read the last log lines with `keel stack logs api` rather than retrying blindly.
- **The turn cap is reached** — the agent returns a failure summary and the trace path. Read the summary; do not start again from scratch.
- **A test needs a UI change to be testable** — stop, go back to a `[WEB]` AC. The guard will refuse the edit anyway.
