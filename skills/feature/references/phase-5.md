# Phase 5 — the frontend AC loop

Every `[WEB]` acceptance criterion. The loop is in **`references/ac-loop.md`** — RED and GREEN rules, failure classification, gates, stall ladder. This file covers the web lane only.

```
keel state lane web
keel state phase red
```

## Lane scoping

In the `web` lane, RED writes `web-test` files (`*.test.tsx`) and GREEN writes `web-src` files. An `api-main`, `api-test` or migration edit is refused and names the lane.

## Running as a separate lane

Only after the contract commit — both lanes need the generated client. Either:

```
keel lane start web                  # a second terminal in the worktree
keel lane start web --background     # keel:lane-runner drives it
```

Each lane gets its own worktree, branch (`lane/web-<repo>`), Compose project name and port offset, so two lanes never share a database or a port. In a background lane that lane's human gates are skipped by definition; every automatic check still runs, and it ends `LANE-RESULT: done` or `stopped`.

`keel lane merge web` brings it back — do that before phase 6. A conflict stops and reports the files.

## Choosing the layer

Load the `web-testing` skill. Component tests with Vitest, Testing Library and MSW handlers generated from the contract — so a contract change breaks the test rather than passing silently. Parse at least one response per endpoint with the generated zod schema.

| AC is about | Assert |
|---|---|
| Rendering | Roles, labels and text, never class names |
| Validation | The message the user sees, **and** that no request was sent |
| An error state | The message for a 4xx or 5xx handler |
| Loading | The intermediate state, via a delayed handler |

## Rules that bite here

- Never hand-edit the generated client folder — the `generated` bucket is denied in every phase.
- Component tests never start a real backend. Crossing the network is what phase 7 is for.
- `.skip(`, `.only(`, `xit(` and `test.fixme` are rejected at the edit by the test-integrity hook, not at commit.
- `web_test_ac` is `vitest run -t {AC}`, so the AC ID must appear in the test **name**, not just a comment.

## Failure modes

- **A test passes because MSW returned a stub the real API would not** — the handler drifted from the contract. Regenerate it rather than adjusting the assertion.
- **`vitest -t AC-004` matches nothing** — `red-done` sees `no tests found`, which is in `red_reject`, so it is refused as a setup problem. The AC ID is missing from the test name.
- **A component needs a test id for E2E** — that is a `[WEB]` AC change made here, not an edit during phase 7.
