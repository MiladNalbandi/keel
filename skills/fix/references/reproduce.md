# Bug flow — report and reproduce

## 0 — report

Write down the symptom, the exact error text, the steps, and the expected behaviour. Then:

```
keel state start fix --phase bug-report
keel state ac BUG-<n> --layer API --current
```

For a UI-only bug with Claude in Chrome enabled, look at it in the browser first — page, console, network — before theorising.

Only the `other` bucket is writable in `bug-report`: no production code, no tests. This phase is for understanding what you are chasing.

## 1 — reproduce

The smallest failing test at the **lowest** layer that shows the bug. A unit test if the cause is a rule; a slice test if it is a status code; Testcontainers if it is data; Playwright only if nothing lower can express it.

```
keel state phase bug-repro
# write the failing test
keel state repro-done
keel commit red BUG-<n> "reproduce <symptom>"
```

`bug-repro` allows `api-test`, `web-test` and `e2e` — tests only. Production code stays locked until Gate F, which is the point.

## What `repro-done` checks

| Outcome | Result |
|---|---|
| The test **passes** | Refused: it does not reproduce the bug yet |
| Fails on an **assertion** | Accepted; phase stays `bug-repro` |
| Fails on **setup** | Refused, with the matched pattern — fix the setup first |

Same classifier as the AC loop: `red_accept` is checked before `red_reject`, so an assertion signal wins over alarming-looking words.

## Gate R

Ask the user whether this failing test shows the bug they meant.

```
keel gate R approve                    # -> phase bug-investigate, code still locked
keel gate R reject --note "<why>"      # -> back to bug-repro
```

Options are: yes this is the bug; no, reproduce differently; or stop — the reproducing test stays on the branch for later. `gates.bug_gates: false` or `--no-gates` records an automatic approval for small obvious bugs.

## Failure modes

- **You cannot reproduce it.** Do not weaken the test until it fails. An unreproducible bug needs investigation first — that is what the diagnose flow is for, and grinding at Gate R will not find it.
- **The test reproduces something, but not the reported symptom.** Gate R exists to catch exactly this. Reject it yourself.
- **The bug only appears with production data.** Find the smallest data shape that triggers it and put that in a fixture; "needs prod" usually means the trigger is not understood yet.
