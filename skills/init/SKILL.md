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

## 2. Three questions

Ask with `AskUserQuestion`:

1. **Where does the app run while developing?** On my machine (recommended) / In a dev container / Decide later.
2. Shaped by discovery:
   - A Compose file exists: "Use `<file>` for services?" — **Use it (recommended)** / I run these services myself.
   - No Compose file but services are detected: Generate one / Use services I run / No services (reduced mode).
   - Docker missing: I will install it / Use services I run / Reduced mode.
3. **Which knowledge sections?** Run `keel memory sections` first — it prints the five, what each
   is for, and which already exist. Put it to the user in your own words: all five, a subset, or
   none for now. Record the answer before anything runs:

   ```
   keel memory sections --confirm conventions,data --by user
   ```

   This is the gate described in step 6, asked here rather than there. It is the one question whose
   answer decides the most expensive thing init does, and it depends on nothing but the repo — so
   asking it now lets the knowledge build start alongside the ladder instead of queueing behind it,
   and the user answers every prompt in one sitting instead of being interrupted eight minutes in.
   `--by user` matters: answered by the model it prints, and reports, as a self-answer.

## 3. Setup plan, then approval

Show one table: every service, port, environment variable name, every command the ladder will run, everything that will be downloaded, and every unknown. Never include deploy, publish or delete commands. Ask for approval before anything runs.

## 3b. Write the config — before the ladder, not after

```
keel init --write
```

`.keel/config.yml` is what the ladder reads to learn this repo's package manager and Compose file.
Without it keel falls back to defaults, and the ladder fails on rung 1 with `pnpm: command not
found` and `compose.yml: no such file` — on a repo where step 1 already reported `npm` and
`docker-compose.yml`. That is not a real failure; it is the ladder being run against a repo
description that has not been written down yet.

So write it here, while discovery is fresh and approved, and read it back before running anything.
The fields that decide whether rung 1 passes are the package manager, the Compose file path, and
the service names — if any of them disagrees with step 1's table, fix the config, not the ladder.

This used to sit in step 7, which is why the first ladder run reliably failed on a correctly
configured machine.

**`keel init --write` overwrites the config** — so it runs once, here. Step 7 does not repeat it.
The ladder does not write into `config.yml` either; it records what worked to `.keel/proven.json`,
merged beneath the config, so nothing you write now is lost by running the ladder.

## 4. Run the ladder — and the knowledge build alongside it

**Start step 6 now, before the first rung.** Nothing in the knowledge build touches a running
service: `keel arch detect` reads file paths and imports, the explorer walks the tree, and the
librarians read source and cite `file:line`. It is static analysis from end to end, so it has no
reason to wait for a ladder that proves the stack builds and boots.

Run them concurrently. The ladder is the CPU-heavy half — Gradle, npm, Testcontainers, a boot —
while the librarians spend most of their wall-clock blocked on inference, so the two contend far
less than their runtimes suggest. On a measured 14-minute run the knowledge build was 8m48s of it
against a ladder of about five; overlapped, the knowledge build becomes the critical path and init
lands near ten.

A ladder failure does not waste the knowledge build. The librarians read source that a failing
compile did not change, so `docs/knowledge/` is just as valid — it is work you would owe anyway,
not work thrown away.

One interaction to respect: `keel:setup-doctor` may edit repo files with the user's approval while
librarians are writing. It never edits application code, so source citations are safe; a build file
it rewrites can shift a line out from under a citation. `keel memory check` resolves every citation,
so this surfaces as a failed check rather than a silent lie — run it once the ladder has settled.

**Run `keel ladder` once. Do not walk the rungs by hand first.** With the config written in step 3b
the ladder has everything it needs, and it records the exact command that worked for each rung as it
goes — which is the artefact you are actually after. Running the sequence manually and then running
the ladder executes `npm install`, `compileKotlin`, `./gradlew test` and the whole boot twice, for
nothing: the hand run proves the same thing the ladder is about to prove, and records none of it.
That was the single largest waste on a measured run, three to four minutes of it.

Hand-run a rung only to investigate one the ladder has already failed.

**While a rung runs, say what you are doing — do not stop to say it.** Long rungs (dependency
resolution, `compileKotlin`, the boot) are the natural place to explain what comes next, report what
the doctor found, or write the closing summary. A measured run lost four minutes to exactly this
inversion: the doctor came back green and the window was spent writing the explanation *instead of*
starting `bootRun`. Start the command, then narrate.

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

What a fast init *does* skip is **step 6**: no knowledge base. That is an answer to step 2's third
question, not a silence around it — so ask it as usual and record what comes back —

```
keel memory sections --none --by user
```

— which is a real answer and not a silence: the five sections then read `not selected`, which is a
fact and not a problem, so nothing blocks a push.

This used to be all-or-nothing because `keel memory check` read every absent section as *missing*
and a failing knowledge verdict blocks every push, so two-of-five cost you the push gate. It no
longer does. A fast init may now offer a **subset** instead of nothing — `conventions` and `data`
are the two that most change what an agent writes — and the rest can be added by re-running init.

Say in the closing message that `keel memory sections` adds more when they want them, and that until
a section exists every flow starts without that piece of project context.

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

### The section gate was answered in step 2

Five librarians is the single most expensive thing init does — on a measured 14-minute run the
knowledge build was 8m48s of it, 62% — which is why it is gated on an answer rather than assumed.
That question is asked in **step 2**, with the other two, and recorded with
`keel memory sections --confirm <sections> --by user`.

`keel memory update` **refuses** until it is answered, which is what makes it a gate rather than a
courtesy. So if you reach this step without an answer on record, you skipped step 2 — go ask it
before spawning anything, not after.

**Then spawn one `keel:librarian` per chosen section and no others** — in parallel, each with the
map and its own section. Each writes its own file and ends
`SECTION: <name> claims:<n> cited:<n> unverified:<n>`.

Put one line in every brief: **keep each claim on a single line — `keel memory check` is per-line,
so an `unverified:` marker does not reach a wrapped continuation.** It is in the librarian's own
instructions, and it is still worth repeating here, because omitting it is what turns one check into
three. A run that came back with eighteen problems had almost none that were real — the claims were
marked correctly and the paragraphs were soft-wrapped.

A section nobody chose reads `not selected` in `keel memory check` — a fact, not a problem — so a
partial knowledge base is legal and blocks nothing. **Re-running `/keel:init` later offers the ones
still missing**, and confirming them adds to the selection: what is already written is kept and is
not rebuilt. That is the intended way to finish a knowledge base in more than one sitting.

One thing the selection does *not* do: it never decides what gets **checked**. A section that exists
is read back as project authority whether or not it was chosen, so an unsourced one is still a
problem. Selection decides what must exist, never what may be wrong.

Two rules make the result worth keeping, and `keel memory check` enforces both:

- **Every claim carries a backticked `path:line`.** If it cannot be cited, it is not written.
- **A rule about validation, transactions, error mapping or authorization needs a proof** — a
  citation into a test or a `.keel/hunt/repro/` recipe — or the literal prefix `unverified:`.
  A citation proves the code *says* something; only a test proves it *does*.

Then `keel memory check`, and `keel memory update` to record the verdict. Do not skip the check: a
knowledge base is read back as project authority, and a wrong entry is followed rather than
looked up.

## 7. Write it down

**The config was written in step 3b — do not run `keel init --write` again.** It overwrites, so a
second run here discards anything the config gained since. If a field turned out wrong during the
ladder, edit `.keel/config.yml` directly.

`keel ladder` writes `docs/RUNNING.md` itself — do not hand-write it, and do not edit it; rerun the
ladder. Add the keel block to CLAUDE.md. Ask before applying test-speed changes (Testcontainers
reuse, one shared Spring test context).

## 7b. Commit what the init wrote

```
keel commit setup "verified <stack> scaffold, ladder green, knowledge base written"
```

An init writes the config the ladder reads, the runbook it wrote, the knowledge base and the
CLAUDE.md block, and then — until this step existed — left every one of it sitting unstaged. The
next session starts by rediscovering what this one just proved.

`setup` takes no ID: it belongs to no acceptance criterion. It carries `.keel/`, `docs/RUNNING.md`,
`docs/knowledge/`, `CLAUDE.md` and `.gitignore`, and refuses everything else, so it cannot quietly
absorb production code that happened to be in the tree.

Commit it through keel rather than by hand. A `git commit` here reaches the same result and skips
every guard, and the habit is what puts an unrelated source file in the middle of a setup commit.

If `docs/knowledge/` landed in the same run, it can ride along here; a knowledge base rebuilt later,
on its own, is `keel commit memory "<msg>"`.

**Check what is staged before committing.** `keel commit` runs `git add -A`, so anything else left
in the tree is caught by the path guard rather than committed — read what it refuses. Tool
directories like `.claude/` or `.claude-flow/` belong in `.gitignore`, not in this commit.

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
