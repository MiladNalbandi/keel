# The lenses

One brief per lens. Give a `keel:hunter` **exactly one** of these and nothing about the others.

The section that matters in each is **what a provable candidate looks like**. A hunter's output
is judged by whether a verifier can reproduce it, so a lens that produces well-written unease
is worse than one that produces three concrete, checkable claims.

Adding a lens is a line in `hunt.lenses`, an entry in `hunt.lens_lanes` saying which side of the
tree it reads, and a section here. The
flow, the guards, the agents and the CLI do not change.

---

## security

**Looks for:** what an actor can reach that they should not. Missing or bypassable
authorization, a tenancy boundary that is a filter rather than a rule, client-controlled
ownership, unvalidated input reaching a query or the filesystem, credentials or PII in a
response or a log, secrets in the repo, fixed identifiers that make guessing unnecessary.

**Look first at:** every controller and route, in full — this is the one lens where the
endpoint list is the work list. Then anything under `change.auth_paths`, then the migrations
for what is unique and what is nullable.

**Load:** `keel:security`, and follow its routing table — `references/api-kotlin.md` plus
`logic.md` for an endpoint, `data.md` for a migration, `web.md` for frontend source.

**A provable candidate:** names the actor, the request, and what comes back. *"An
unauthenticated `GET /api/websites` with no `userId` returns every tenant's websites, each with
its owner id."* Provable with one `curl`.

Not a candidate: "authorization could be stronger". Also not a candidate: a CVE with no call
path into it — that is `keel:dependency-triager`'s job and it needs scanner output, not
prose.

**Note:** absence of authentication is a design decision in some projects, not a finding.
Report what its absence *enables*, concretely, rather than reporting its absence.

---

## behavioral

**Looks for:** the gap between what the interface promises and what it does. A control that
looks live and is inert — a filter that never filters, a sort header bound to nothing, a button
with no handler, a form that reports the wrong error. Error text that leaks internals to a
user. State that survives when it should be cleared, and an action that reports failure after
succeeding.

**Look first at:** the frontend components with the most controls, then the error paths on both
sides of the wire, then anything a double-click could hit twice.

**Load:** `keel:web-implementation` if the project has a frontend.

**A provable candidate:** describes a user action and what is on screen afterwards. *"Typing in
the email filter re-renders the list but never narrows it: the input is bound to state that the
render path does not read."* Provable with Playwright, or by reading the render path and
showing the state is unused.

Not a candidate: a styling preference, a missing feature nobody specified — that one is
`kind: "unspecified"` and goes to `/keel:feature`, not a defect.

**This lens is the one most often missing from a test suite**, which is why it finds things
nothing else does: a unit test asserts the handler, not that the handler is wired to a button.

---

## technical

**Looks for:** correctness in the code paths a test never took. Exceptions raised outside the
block that catches them, transaction boundaries that defer a failure past its handler, an
upsert where an insert was meant, `existsById` followed by `deleteById` with no lock,
read-modify-write with no version, unbounded queries, N+1s on a request path.

**Look first at:** persistence adapters, then anything `@Transactional`, then every `catch`
that returns a typed error — and ask when it can actually fire.

**Load:** `keel:architecture` for where a boundary is supposed to be, and `keel:debugging`
(`references/data-forensics.md`) for reading state without changing it.

**A provable candidate:** names the call and the observable wrong result. *"Deleting a user who
owns a website returns 500 with a raw framework body instead of 409: the constraint violation
is raised at commit, after the port's catch has already returned."* Provable with one request.

Not a candidate: "this could be refactored". If you cannot say what a caller observes, it is
not this lens's finding.

---

## concurrency

**Looks for:** what breaks when two callers arrive at once. Read-modify-write with no lock and no
version column. Check-then-act that is not atomic — `existsById` then `deleteById`, `findByEmail`
then `save`. A `max + 1` computed in memory and written under a unique constraint. An upsert that is
really a blind `save()` on an assigned id. Shared mutable state on a request path. A transaction whose
isolation level cannot hold the invariant the code assumes.

**Look first at:** every `@Transactional` method that reads then writes the same row; every unique
constraint in the migrations, then who computes the value that fills it; any counter, sequence or
version number the application maintains itself.

**Load:** `keel:debugging` `references/reproduce-race.md` — the technique for making a race fail on
demand, and the reason a single sequential request can never show one.

**A provable candidate:** names the two callers and what one of them loses. *"Two concurrent
`POST /api/websites/{id}/versions` both read `max(version_number)` as 3 and both write 4; the unique
constraint rejects the loser, which surfaces as a 500 and a lost write."* Provable with eight parallel
requests — and only with parallel requests, which is why this lens exists separately from `technical`.

Not a candidate: "this isn't thread-safe" with no path where two callers meet.

**Note for whoever proves it:** a recipe here must itself be concurrent. `seq 8 | xargs -P8 -I{} curl
…` run twice. A sequential probe that passes proves nothing about this class.

---

## idempotency

**Looks for:** what breaks when the *same* caller arrives twice. A `POST` that creates a second row
on retry. A missing idempotency key where the client may legitimately re-send. A handler on an
at-least-once queue that is not replay-safe. A double-submitted form that produces two of something.
A migration that fails or duplicates when run a second time. A `DELETE` whose second call reports an
error rather than the same success.

**Look first at:** every create endpoint, and ask what a client with a dropped response does next;
every message handler; the frontend controls that fire a mutation with no in-flight guard.

**Load:** `keel:debugging` `references/reproduce-race.md` for the repeat-until-it-breaks technique.

**A provable candidate:** names the repeat and the divergence. *"`POST /api/users` with an identical
body twice creates two users; nothing keys on the request, so a client that retries a timed-out call
silently doubles the row."* Provable by sending the same request twice and counting.

Not a candidate: a naturally idempotent `PUT` you merely dislike. And note that a *correct* 409 on the
second call is not a bug — the finding is a second **effect**, not a second error.

---

## contract-drift

**Looks for:** the three-way disagreement between the contract, the server and the client. An
endpoint the client calls that no controller serves. A controller with no contract entry. A
response shape the contract promises and the code does not return. Generated client code that
has drifted from the spec it was generated from. A documented error code that is unreachable.

**Look first at:** the contract file, then every route registration, then every call site in
the generated client. This lens is close to mechanical — walk all three lists and diff them.

**Load:** nothing. Read the contract.

**A provable candidate:** names both sides. *"`client.ts` calls
`GET /api/websites/{id}/versions`, which no controller serves; the request 404s and the panel
renders the error body."* Provable with one request.

This lens finds things fast and cheaply. Run it even on a narrow hunt.

---

## test-integrity

**Looks for:** tests that pass while production is broken. A mock asserting a contract the real
adapter never produces. A test whose assertions restate the implementation. A `verify` that
only proves a mock was called. A disabled or skipped test. A suite whose branch coverage is
zero, meaning no error path was ever taken. Dead test infrastructure nothing uses.

**Look first at:** the coverage report, lowest branches first, then the tests for the code the
other lenses are flagging — *especially* where a test exists and the bug is real anyway. That
combination is the signal.

**Load:** `keel:kotlin-spring-testing` or `keel:web-testing`, whichever matches the file.

**A provable candidate:** names the test and the production behaviour it fails to catch.
*"`CreateUserUseCaseTest` mocks the port to return `PERSISTENCE_ERROR` and asserts it — a value
the real adapter never returns, because the constraint violation is raised at commit. The test
passes while the endpoint 500s."* Provable by running the real path.

**Why this lens exists:** a passing test for a broken behaviour is worse than no test, because
it reads as coverage and stops anyone looking. It is also the lens that explains why the other
lenses found so much.

---

## data-migration

**Looks for:** what the schema permits that the domain does not. Missing CHECK constraints,
nullable columns that are required in practice, uniqueness that is case-sensitive when the
domain is not, foreign keys with no `ON DELETE` behaviour and no application-side cascade,
missing indexes on a query path, pagination with no stable sort, seed data with fixed
identifiers or a different clock from the application's.

**Look first at:** every migration in order, then the entity mappings against them, then the
queries that sort or page.

**Load:** `keel:security` `references/data.md` for the exposure angle.

**A provable candidate:** names a row you can insert, or a query that returns the wrong thing.
*"`app_user.email` is unique case-sensitively, so `Alice@example.com` and `alice@example.com`
are two accounts."* Provable with one insert against a disposable database.

Not a candidate: a naming preference, or an index you think might help without a query that
needs it.
