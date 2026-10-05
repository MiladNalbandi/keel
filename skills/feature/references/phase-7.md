# Phase 7 — end to end (optional)

The `[E2E]` acceptance criteria, against a running stack. Delegated, because browser exploration produces a lot of output that does not belong in the main session.

**Only if the flow kept it on at phase 0.** If E2E was skipped, the flow goes from smoke (or
earlier) straight to ship. Ship still runs the full E2E suite inside `keel verify release`, so an
`[E2E]` criterion with no spec will show up there — say so at the final review.

```
keel state phase e2e
# delegate to keel:e2e-author
keel verify e2e AC-00n
keel commit e2e AC-00n "<journey>"
keel state phase ship
```

The stack is already up from smoke. If smoke was skipped: `keel stack up`, and `keel stack migrate`
if keel reported pending migrations — stale dev data is the most common cause of a confusing E2E
failure. `keel verify e2e` prints a drift note itself when it finds one.

## Is the tool configured?

Check `commands.e2e` in `.keel/config.yml` before delegating — a blank command fails inside
`keel:e2e-author` as an unexplained shell error, which reads as a broken test rather than a missing
tool. If it is blank, ask (`keel ask e2e-tool-missing --blocking`) whether to set one up now.
**Either answer** still ends with `keel:e2e-author` writing and committing the `[E2E]` specs — "no"
only means it is told not to run them. Say so plainly at the final review and in the PR body: an
unrun `@e2e` test must never quietly read as a passing one.

## Delegating to `keel:e2e-author`

It explores the running app with `playwright-cli` (not Playwright MCP — the CLI keeps snapshots on disk instead of in the conversation), writes the spec, runs it, and ends `E2E-RESULT: pass` or `fail`. Capped at 40 turns. Give it only the `[E2E]` AC text, the URLs, and the fact that only `e2e/` is writable this phase — not the whole spec.

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
