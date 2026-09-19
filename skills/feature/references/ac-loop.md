# The acceptance-criteria loop

One AC at a time, in plan order. Two commits per AC, one gate. Runs for `[API]` ACs in phase 4 and `[WEB]` ACs in phase 5.

```
keel state phase red
# write only this AC's tests
keel state red-done
keel commit red AC-00n "<what it asserts>"
# write the minimum production code
keel state green-done
keel commit green AC-00n "<what it does>"
keel gate ac approve|review|reject|skip
```

## RED

Write tests **only** for the current AC, at the lowest layer that can express it. Name and tag every test with the AC ID — `keel verify ac` filters on it and `keel trace` finds the test by it.

Edits are **lane-scoped**: in the `api` lane you may write `api-test` files, in the `web` lane `web-test` files. Crossing over is refused with the lane named. Switch deliberately with `keel state lane web` if that is really the work.

`keel state red-done` runs this AC's tests plus the tests in changed packages, then decides:

| Outcome | What keel does |
|---|---|
| Tests **pass** | Refuses. Either the behaviour already exists — record it with `keel state ac AC-00n --status already-met` and the evidence — or the test asserts nothing. |
| Fails on an **assertion** | Accepted. Phase becomes `red`, AC status `red`. |
| Fails on **setup** | Refused, with the matched pattern. Fix the setup; a compile error, a Spring context failure or a Docker error is not a red test. |

Classification is substring matching over the trimmed output, `red_accept` checked **before** `red_reject` — an assertion signal wins, because a genuine failure can also print alarming words.

| Accepted (`loops.red_accept`) | Refused (`loops.red_reject`) |
|---|---|
| `assertionfailederror`, `assertionerror`, `comparisonfailure` | `compilation error`, `cannot find symbol`, `unresolved reference` |
| `expected:`, `expected <`, `expected but was`, `but was:` | `applicationcontext`, `no qualifying bean` |
| `received:`, `tobe(`, `toequal(` | `could not connect to docker`, `docker environment` |
| `status expected` | `initializationerror`, `no tests found`, `classnotfoundexception`, `noclassdeffounderror`, `syntax error` |

Note: the design doc describes these as category names (`assertion`, `compile`); the implementation uses these literal substrings. Override with the substrings, not the categories.

## GREEN

Production code only — test files for every AC are frozen, and the lane still applies. Write the **minimum** code that makes the test pass: no field, endpoint, abstraction or branch no current test drives. New migrations may be added; existing ones are immutable.

`keel state green-done` runs this AC's tests with **one flake rerun** — a failure that passes on an unchanged rerun is recorded in `state.flaky` and does not count. Then, when `tests.module_suite_at` is `every-ac`, the whole lane suite. It reports per-AC coverage when `coverage.per_ac` is `warn` (default) or `enforce`; `enforce` fails the transition.

Its last line tells you whether a human gate is due for this AC and what to do when it is not. **Do not decide that yourself** — `gateDue` resolves the gate mode, an at-gate skip and its scope, a `[gate: skip]` tag and a background lane in one place.

## The gate

`keel gate ac <decision>` prints the board first, then:

| Decision | Effect |
|---|---|
| `approve` | AC marked done; moves to the next todo AC in `red`, or to `integration` when none remain |
| `review` | Run `keel:reviewer` on this AC's diff, then return to the gate |
| `reject --note "…"` | AC back to `todo`, phase back to `red` |
| `skip [--scope lane\|flow]` | Records the skip; `flow` also sets gate mode to `end`. Automatic checks still run and the final review lists it |

With `gates.ai_review_on_skip: true`, a skipped gate gets a `keel:reviewer` pass instead; a blocking finding means the gate applies after all.

## When it stalls

Every failure is fingerprinted. The same fingerprint `loops.stall_repeats` times (default 3) is a stall, and a new fingerprint resets the count. One ladder step per stall:

1. Re-read the trimmed failure and the AC; do not guess.
2. Ask `keel:investigator` for a fresh-context diagnosis before the next attempt.
3. Step the model up for the next attempt.
4. Stop and ask the user: the failure, what you tried, the two options you see.

`caps.red_turns` (8) and `caps.green_turns` (15) are backstops, not the primary signal. `keel stall reset` clears the counter after a real change of approach.
