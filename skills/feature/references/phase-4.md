# Phase 4 — the backend AC loop

Every `[API]` acceptance criterion, in plan order. The loop itself is in **`references/ac-loop.md`** — read that for the RED and GREEN rules, the failure classification, the gate options and the stall ladder. This file covers only what is specific to the backend lane.

```
keel state lane api        # if a web lane ran last
keel state phase red
```

## Lane scoping

In the `api` lane, RED may write `api-test` files and GREEN may write `api-main` files plus **new** migrations. A `web-src` or `web-test` edit is refused and names the lane. That is deliberate: an `[API]` criterion that touches the frontend is either mis-tagged or two ACs.

## Choosing the layer

Load the `kotlin-spring-testing` skill for the patterns. Lowest layer that can express the AC:

| AC is about | Layer |
|---|---|
| A pure rule, no framework | unit, JUnit 5 + MockK + AssertJ |
| A status code, validation, an auth rule | `@WebMvcTest` slice |
| A request or response body matching the contract | body test, MockMvc + the swagger validator |
| A query, a constraint, a migration | `@DataJpaTest` + Testcontainers |
| A cross-layer flow or a transaction | `@SpringBootTest` + `@ServiceConnection` |

Every endpoint an AC touches should get a body test, because that is what makes a contract mismatch fail on this side.

## Migrations

New Flyway files are allowed in GREEN. Existing migration files are immutable in every phase — the guard refuses the edit and tells you to add a new file. A new migration applies automatically to the fresh Testcontainers database but **not** to the long-running dev stack; `keel stack migrate` does that, and the E2E phase checks for drift.

## Test scope per AC

`tests.per_ac_scope` defaults to `changed-packages`: `red-done` and `green-done` run this AC's tagged tests **plus** the tests in every package this change touched, so breaking a neighbour shows up now rather than at the gate. The full module suite runs at the gate (`tests.module_suite_at: gate`).

## Delegation

With `loops.green_author: subagent`, hand GREEN to `keel:implementer` — a fresh context per AC, useful on long features. It ends `GREEN-RESULT: pass` or `stalled`. RED can go to `keel:test-author` the same way. The hooks enforce the phase either way, so delegation changes who writes, not what is allowed.

## Failure modes

- **`red-done` says the tests already pass** — the behaviour exists. Mark it `--status already-met` with the evidence, or fix a test that asserts nothing.
- **A Spring context failure in RED** — refused as a setup problem. Fix the test's configuration; do not commit it as red.
- **Testcontainers cannot find Docker** — same refusal. Check `docker info`; on Colima or Podman the socket needs configuring.
- **The module suite breaks at `green-done`** — an earlier AC's behaviour changed. Fix it in this GREEN rather than moving on, or the gate will not open.
