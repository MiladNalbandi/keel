# Phase 6 — integration

Both lanes are done; now the real client talks to the real API instead of a mock.

```
keel lane merge web        # if a web lane ran
keel state phase integration
keel verify module api
keel verify module web
```

## What changes here

Production code in both apps is writable (`api-main` and `web-src` allow, tests deny). This is where the frontend stops using MSW handlers for the paths under test and calls the generated client against the running API — wiring, not new behaviour.

If you find yourself needing new behaviour, that is a missed AC. Go back to the loop rather than writing untested code here; tests are frozen in this phase precisely to stop that.

```
keel commit fix SPEC-NNN "integrate"    # only if there are changes
```

## Before moving on

`keel verify full` is the honest check at this point — both module suites plus static checks. It is also where an unconfigured `static_checks` surfaces as `MISSING`, because that tier requires it.

Bring the dev stack up if it is not already, since phase 7 needs it:

```
keel stack up
keel stack migrate        # if a new migration landed in this feature
```

## Failure modes

- **The client sends a field the API does not accept** — the contract is the arbiter. Whichever side disagrees with `openapi.yaml` is the wrong one.
- **A test fails that passed in its lane** — the two lanes each passed against their own assumptions. This is the phase that exists to catch it; fix the production code, not the test.
- **`verify module web` passes but the app is broken in a browser** — component tests mock the network. That gap is E2E's job, next phase.
- **Migration drift** — `keel stack migrate` applies pending migrations to the long-running dev database. `keel stack reset` drops the volume when the data has drifted too far to be worth keeping.
