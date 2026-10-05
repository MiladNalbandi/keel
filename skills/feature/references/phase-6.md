# Phase 6 — smoke (optional)

The `[SMOKE]` items, as checks that work locally **and** after a deploy. Under `smoke.max_seconds` (60) in total.
Runs before E2E: it is the cheap check that the app is up and the critical path works, so a broken
stack shows up here in seconds instead of inside a 40-turn E2E run.

**Only if the flow kept it on at phase 0.** If smoke was skipped, the CLI never enters this phase —
`keel gate integration` or `keel state advance` names the next one. Ship still runs smoke inside
`keel verify release`, so skipping here moves the check, it does not remove it.

```
keel stack up
keel stack migrate     # if keel reported pending migrations
keel state phase smoke
# write smoke/NNN-slug.sh and one @smoke test
keel smoke
keel commit smoke SPEC-NNN "<checks>"
keel state advance     # e2e, or ship if E2E was skipped
```

## What goes in

Plain Bash against `BASE_URL` and `API_URL`, which `keel smoke` sets from `e2e.web_url` and `e2e.api_url`:

| Check | How | Passes when |
|---|---|---|
| API health | `curl /actuator/health` | `status` is `UP` |
| A critical write | `curl -X POST` with a fixture body | `201`, and `jq` finds the expected fields |
| A critical read | `curl GET` the resource just created | body matches what was written |
| The app loads | the `@smoke` Playwright test | the shell renders and the critical route is reachable |

`keel smoke` runs every `smoke/*.sh` then `commands.smoke_e2e`, and exits non-zero on the first failure with one line per check.

## Rules

- Only the `smoke` bucket is writable this phase.
- Smoke is a **subset**, not a second E2E suite: one `@smoke` test covering the single most critical path.
- Every check must be safe to run against a deployed environment. Nothing destructive, nothing that assumes an empty database.
- **It seeds its own data.** E2E has not run yet, and after a deploy it never does — a check that
  needs a row must create it first.
- Portable shell — no GNU-only flags, since this may run on a different machine than yours.

## Failure modes

- **The check depends on data that is not there** — it will pass on a warm dev database and fail after a deploy. Seed what it needs, or assert something that is always true.
- **It takes too long** — `smoke.max_seconds` exists because a slow smoke check stops being run. Trim it rather than raising the limit.
- **`commands.smoke_e2e` is unset** — it is optional, so `keel smoke` runs the shell checks and reports the Playwright part as skipped rather than passing silently.
- **Two fix rounds is the cap.** If it still fails, stop and report rather than grinding.
