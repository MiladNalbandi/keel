---
name: init
description: Set up keel in this repository: detect the layout, ask the two runtime questions, prove the project runs, write the runbook and config. Use before the first keel flow.
disable-model-invocation: true
argument-hint: "[--write] [--new] [--fast]"
---

# keel:init

## 1. Discover (read only)

Run `keel init` and read its output. Then read, in this order: CI workflows, the build files, Compose files, application config, `.env.example`, README. CI is the most reliable source: those commands are known to pass.

Report what you found in one table: backend, frontend, build tool, contract file, Compose file, services, required environment variable names (names only, never values).

## 2. Two questions

Ask with `AskUserQuestion`:

1. **Where does the app run while developing?** On my machine (recommended) / In a dev container / Decide later.
2. Shaped by discovery:
   - A Compose file exists: "Use `<file>` for services?" — **Use it (recommended)** / I run these services myself.
   - No Compose file but services are detected: Generate one / Use services I run / No services (reduced mode).
   - Docker missing: I will install it / Use services I run / Reduced mode.

## 3. Setup plan, then approval

Show one table: every service, port, environment variable name, every command the ladder will run, everything that will be downloaded, and every unknown. Never include deploy, publish or delete commands. Ask for approval before anything runs.

## 4. Run the ladder

Stop at the first rung that fails:

1. Toolchain: JDK, Node, Docker reachable, ports free
2. Dependencies resolve
3. Both apps compile
4. Unit tests
5. One container-backed test
6. Services up and healthy
7. API boots, health endpoint OK
8. Frontend serves
9. One smoke check
10. `keel doctor --hooks`

After each rung, record the exact command that worked.

## 5. When a rung fails

Send one `keel:setup-doctor` **per failing rung, in parallel** — a level can fail several at once,
and the ladder reports all of them precisely so you do not fix one and rediscover the next. Each
ends `DIAGNOSIS: fixable|needs-you|unknown`.

Retries that change nothing may run. Anything that changes the machine or repo files needs the
user's approval. Never edit application code.

After `setup.fix_attempts_per_rung` failures keel raises a blocking question for that rung — fix it,
exclude it in `setup.ladder`, or accept it as not-checked. You cannot run the ladder again until it
is answered, which is the point: a rung that has failed three times is a decision, not a retry.

## 5b. `--fast`, when you want the machine proven and nothing else

A fast init checks **every rung** — `keel ladder --fast` drops no step. It re-uses whatever already
passed on this machine, and skips the build-tool probe because `compile` resolves the same graph and
proves more. The runbook says it was a fast run and still lists every rung with its verdict.

What a fast init *does* skip is **step 6 entirely**: no knowledge base. That is all-or-nothing on
purpose — a half-written `docs/knowledge/` fails `keel memory check`, and a failing knowledge verdict
blocks every push until the rest arrives. An absent one blocks nothing.

Record the choice rather than leaving it implied:

```
keel ask knowledge-deferred --question "Build the knowledge base now?" \
  --because "a fast init skips it, so agents have no project context here until it exists"
keel ask knowledge-deferred --answer "deferred with --fast" --by user
```

Then say in the closing message that `keel memory update` builds it when they want it — and that
until then every flow starts without project context, which is the thing they traded away.

**One trap to name out loud:** a fast init does not bring the stack up. A hunt started straight after
one has nothing to prove against — `keel hunt start` will record `api: down`, every prover will come
back `unproven`, and a page of `unproven` reads like "no bugs found". Run `keel stack up` first.

## 6. Build the knowledge base

Everything an agent needs to work here, under `docs/knowledge/`: architecture and its
boundaries, the domain's vocabulary, conventions, data and fixtures, integrations and their
test stand-ins. Detect the architecture first (`keel arch detect`, then `keel arch set`), so
the architecture and conventions sections describe the style the code actually uses.

**Send one `keel:explorer` first, and keep its map.** It returns the file layout, where each kind
of thing lives, and the patterns worth copying, capped at 60 lines and ending `MAP-END`. Hand that
same map to every librarian.

This is the difference between a knowledge build that takes four minutes and one that takes nine.
Without it each of the five librarians walks the whole tree to find its own slice, and they run in
parallel — so you pay the slowest of five full reads rather than one read plus five focused ones.
The hunt has always done this for its hunters, for exactly this reason.

Then send one **`keel:librarian`** per section, **in parallel** — architecture, domain, conventions,
data, integrations — each with the map and its own section. Each writes its own file and ends
`SECTION: <name> claims:<n> cited:<n> unverified:<n>`.

Two rules make the result worth keeping, and `keel memory check` enforces both:

- **Every claim carries a backticked `path:line`.** If it cannot be cited, it is not written.
- **A rule about validation, transactions, error mapping or authorization needs a proof** — a
  citation into a test or a `.keel/hunt/repro/` recipe — or the literal prefix `unverified:`.
  A citation proves the code *says* something; only a test proves it *does*.

Then `keel memory check`, and `keel memory update` to record the verdict. Do not skip the check: a
knowledge base is read back as project authority, and a wrong entry is followed rather than
looked up.

## 7. Write it down

Run `keel init --write`. `keel ladder` writes `docs/RUNNING.md` itself — do not hand-write it, and
do not edit it; rerun the ladder. Add the keel block to CLAUDE.md. Ask before applying test-speed
changes (Testcontainers reuse, one shared Spring test context).

## 8. Say what you did not check, then hand over

**Do not tell the user the project is healthy.** Every rung is a liveness check: it builds, it
boots, its own suite passes. Not one of them asks whether an endpoint *behaves correctly*, and a
repository can pass the whole ladder while returning the wrong status code, exposing another
tenant's data, or ignoring a validation annotation that was never wired up.

Raise the question before you write the closing message, so the counts are in front of you:

```
keel ask audit-now --blocking --by init \
  --question "The ladder checked liveness only. Run /keel:hunt now to check behaviour?" \
  --because "<n> of <n> steps passed; none of them exercised an endpoint for correctness"
```

It is blocking on purpose. A question the model may quietly answer for itself is how "no git
repository" became a footnote instead of a decision.

### What to show

Give them what a decision needs: what was checked, what a hunt would cost, and **both** answers as
real options. Showing the command only for *skip* is a thumb on the scale.

> One thing left, and it is yours to decide.
>
> > The ladder checked liveness only. Run `/keel:hunt` now to check behaviour?
> > because 13 of 13 steps passed, and none of them exercised an endpoint for correctness
>
> It builds, it boots, its own suite is green. Nothing so far has asked whether an endpoint
> returns the right thing.
>
> **Run it** — six read-only lenses in parallel, then one verifier per candidate. Nothing is
> reported until it reproduces against the running stack, and it changes no code. Ten to twenty
> minutes, mostly waiting on the provers.
> `keel ask audit-now --answer "yes, run it" --by user`
>
> **Skip it** — the backlog stays empty and the runbook records that behaviour was never checked.
> `keel ask audit-now --answer "skip for now" --by user`

Both are real answers. Say plainly that you cannot answer it for them — once, without repeating
it — and stop. Do not list the ways to start work yet; that is the *next* message, and only if
they skip.

### After they answer

- **Yes** → run `/keel:hunt`.
- **Skip** → now give them the three ways to start: `/keel:change` for small work,
  `/keel:feature` for spec work, `/keel:fix` for bugs — and `/keel:memory` to read the knowledge
  base back in a later session.
