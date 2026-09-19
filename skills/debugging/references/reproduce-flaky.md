# Reproducing a flake

A flake is not random. It depends on something the test does not declare: order, shared
state, a clock, a port, or leftover rows. The job is to find the hidden dependency and
make it explicit — then the test either fails every time or passes every time.

## First, is it already recorded?

keel reruns a failing test once. A pass on the unchanged rerun is recorded rather than
counted as a failure:

```
keel status          # "N flaky" in the summary line
keel state show      # state.flaky carries the label, timestamp and fingerprint
```

That history tells you which test and how often, which is usually enough to guess the
cause.

## Find the hidden dependency

Work through these in order; each is cheap and rules out a whole class.

**Order dependence.** Run the suspect test alone, then with the class before it.

```
keel verify ac BUG-014                     # the tagged test alone
./gradlew -q test --tests '*SeatServiceTest*'
```

Passes alone, fails in the suite → shared state. Passes in the suite, fails alone →
it depends on setup another test performs, which is the more dangerous of the two.

**Shared state.** Look for `companion object` holding mutable data, a static cache, a
singleton container reused without truncation, `@TestInstance(PER_CLASS)` with mutated
fields. In the frontend: a module-level `let`, an unreset MSW handler, a persisted store.

**Clock and randomness.** `Instant.now()`, `LocalDate.now()`, `Math.random()`,
`UUID.randomUUID()` in an assertion. A test that fails around midnight or month end is a
clock bug. Inject a fixed clock rather than widening the tolerance.

**Leftover rows.** A test that passes on a fresh database and fails on the second run is
not cleaning up. `keel stack reset` drops the dev volume; a Testcontainers test should not
be touching the dev database at all.

## Make it fail every time

Once the dependency is named, pin it so the failure is deterministic:

```kotlin
@Tag("BUG-021")
@Test
fun `BUG-021 expiry is computed in UTC, not the host zone`() {
  val clock = Clock.fixed(Instant.parse("2026-03-01T23:30:00Z"), ZoneId.of("Pacific/Auckland"))
  val svc = SubscriptionService(clock)
  assertThat(svc.expiresOn(subscription)).isEqualTo(LocalDate.parse("2026-03-31"))
}
```

That is a reproduction: it fails on every run, on every machine, and the assertion states
the rule. The original intermittent test was a symptom, not a reproduction.

## Traps

- Do not "fix" a flake by adding a retry, a sleep or a wider tolerance. That hides the
  hidden dependency instead of removing it, and the guard hooks will reject `@Disabled` or
  `.skip(` if you try to park it.
- A flake caused by shared state often is not in the test that fails — it is in the one
  that ran before. Fix the polluter.
- If the flake only appears in CI, compare the environment, not the code: parallelism,
  timezone, locale, available cores.
