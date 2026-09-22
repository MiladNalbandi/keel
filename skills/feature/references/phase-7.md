# Phase 7 — end to end

The `[E2E]` acceptance criteria, against a running stack. Delegated, because browser exploration produces a lot of output that does not belong in the main session.

```
keel stack up
keel state phase e2e
# delegate to keel:e2e-author
keel verify e2e AC-00n
keel commit e2e AC-00n "<journey>"
```

## Before starting — three things, in order

**1. The gate right before this phase.** Phase 6.6's full-diff review (`keel:code-reviewer`) and
its own `e2e-approved` question happen just before `keel state phase e2e` — see the feature
`SKILL.md`. Do not re-ask it here; it has already been asked by the time this phase starts.

**2. Is the tool even configured?** Check `commands.e2e` and `commands.smoke_e2e` in
`.keel/config.yml` before delegating — a blank command fails inside `keel:e2e-author` as an
unexplained shell error, which reads as a broken test rather than a missing tool. If either is
blank, ask (`keel ask e2e-tool-missing --blocking`) whether to set one up now. **Either answer**
still ends with `keel:e2e-author` writing and committing the `[E2E]` specs — "no" only means it is
told not to run them. Say so plainly at the final review and in the PR body: an unrun `@e2e` test
must never quietly read as a passing one.

**3. Migration drift** — stale dev data is the most common cause of a confusing E2E failure:

```
keel stack migrate     # if keel reported pending migrations
```

`keel verify e2e` prints a drift note itself when it finds one.

## The gate right after this phase

Before `keel state phase smoke`, ask `smoke-approved --blocking` the same way — proceed, show the
diff, or stop here. See the feature `SKILL.md` for the exact question.

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
