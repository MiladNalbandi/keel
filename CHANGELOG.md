# Changelog

Design §22 lists this file and it never existed — which is why the version sat at `0.4.0`
across nine commits and four whole stages, until the only way to tell one build from another
was to grep the source for a function name.

## 0.59.0

**One dashboard for every project on the machine.** Each session starts its own MCP server, and
each server used to open its own dashboard on the next free port, blind to the others: four
projects meant four tabs and nowhere that said which one was waiting on you. Now the first server
to take the port is the hub. It serves every keel project on the machine's list, and every other
session hands back the same URL. The page opens on "all projects", with one card per project
showing its flow, phase, AC progress and a red mark for a blocking question. A tab per project
leads to that project's full view. When the hub's session ends, another session that has opened
the dashboard takes the port over, and the list brings every project back.

**`~/.keel/projects.json`** (or `KEEL_HOME`) is that list. The session-start hook and the MCP server
add their project. Writes are read-merge-write under a lock file and land by rename, so eight
sessions starting together lose no entry. A project drops off when its `.keel/config.yml` is gone,
when it has not been seen for 14 days, or with `keel projects forget <name>`. The hub only reads the
list, so no page can point it at a directory, and it refuses a foreign `Host` header.

**`keel projects` and the `keel_projects` tool** list the same projects in text. Every other `keel_*`
tool takes `project: "<name>"`, so one session can ask how another is doing.

**The MCP server starts when keel is opened as a project.** `.mcp.json` pointed at
`${CLAUDE_PLUGIN_ROOT}/mcp/server.js`, and only a plugin install sets that variable. Opened as a plain
project, the path was `/mcp/server.js` and the server died with "Connection closed". It now falls
back to the working directory.

**The feed filter no longer eats events.** The page stored the *filtered* frame, so picking
`failures` and going back to `all` showed only the failures until the next update.

**`/keel:review` runs a review agent on demand.** The flow's reviewers only ran at its own four
review points, and starting one by hand meant knowing the agent's name and what scope and lens it
expects. `/keel:review` with no argument runs `keel:code-reviewer` over the branch. A lens name runs
one `keel:reviewer`, `all` runs ship's lens set in parallel, and `ac AC-00n` runs `keel:ac-reviewer`
on that criterion's commits. It reports and never fixes. Its verdict does not move the phase or count
as a ship round. A scenario holds its lenses and verdict lines to the ones the agents and hooks use.

**keel has a logo.** The mark is the front view of a hull with its keel, split down the middle, in
the dashboard's accent purple. `assets/brand/` has the symbol, wordmark and lockups as SVG (the text
is converted to outlines), one-colour and dark versions, PNG icons from 16 to 512px, and a
1280×640 GitHub social preview. The dashboard header uses the mark in place of the old `▲`, the
page has a favicon that follows the system theme, and the README opens with the lockup.

246 scenarios, up from 242.

## 0.58.0

**The flow card now draws the state machine, not a straight line.** It used to render the flow
as one ordered rail — the spine only, no room to show that a gate has nine outcomes, that a wrong
spec sends you back from RED, or that ship's failures leave through review-fix or coverage-fix and
come back. `TRANSITIONS` already held the real graph; now the card draws it: the rail stays the
spine, every branch `TRANSITIONS` allows is an edge, the current phase is lit and its legal moves
are outlined.

**`CLAUDE.md`** now tells Claude how to explain things in this project: simple English, a diagram
when it helps, written for a junior developer. Applies to explanations only — code and commit
messages stay normal.

242 scenarios, up from 241.

## 0.57.0

The background lane was built and never wired to the thing that decides which tests run, so it
worked only by coincidence — and one of its parts was actively wrong.

**A `[WEB]` criterion now runs the web tests.** `currentLane` read `state.lane`, which a default
flow never moves off `'api'`, so every criterion — layer `[WEB]` included — was verified with the
backend build. The same read sat in `guards.laneMismatch`, which meant a `[WEB]` criterion was
*also* refused permission to edit its own test file, and told it was a lane violation. Both now
ask the criterion's own layer through `state.acLaneOf`. `laneOf` keeps its old meaning — which
worktree is this — and still keys the Compose project, the port offset and the gate-skip
bookkeeping, because those are a different question.

**A lane worktree reads its own state.** Every command resolved its root from
`CLAUDE_PROJECT_DIR` before the working directory, so a keel command run inside a lane found the
*main* checkout's state file. `findRepoRoot` now prefers the directory it is standing in when
that directory is a configured keel project — which a lane worktree always is, and an unrelated
directory is not.

**`lane start` hands the lane a seeded state**: its criteria, its branch, its lane name, and
`gates.skipped` already set for a background lane. It refuses without an active flow, without
criteria of its own, and — this one bit in testing — when `.keel/state.json` is not ignored,
because the lane would otherwise commit its state and collide with the parent's copy on the way
back. It rolls the worktree and branch back when it refuses.

**`lane merge` folds the lane's work in** rather than dropping it. `verify.trace` recomputes red
and green by grepping commit subjects, so before the merge a lane's criteria are invisible from
the parent and `keel pr` blocks on them; after it they are simply done. Merge refuses while
criteria are unfinished unless forced, deletes the merged branch so the lane name can be reused,
and prefixes the lane's gate log rather than losing it. Approving the last criterion in this
session now holds at the gate instead of declaring the flow ready for integration with a lane
still out.

**`keel:lane-runner` no longer asks for its own worktree.** `isolation: worktree` gave it a
throwaway checkout that was not the lane's — so its commits landed on a branch `keel lane merge`
never looks at.

**`keel upgrade [--write]`** brings an older repo forward: it adds config keys this version reads
but the file predates, migrates state, and syncs the ignore lines. It edits the config as lines
rather than parsing and re-emitting it, so comments, ordering and every value already set survive
— a dry run by default, idempotent, and refusing a config newer than the plugin. `version` in the
config has been an unread field since the beginning; it is now the migration counter, and a
config behind this build says so at session start.

**`loops.red_author`** exists. The feature skill has documented it since the RED step gained a
subagent, but it was in neither the defaults nor the template, so `keel:test-author` — a finished
agent with a hook contract and a model setting — could never be reached.

The simulator's fixture repo now writes the real ignore lines, as `keel init --write` does.
Without them keel's own per-machine state rode along in commits, which is exactly the failure
`lane start` now refuses to set up. 241 scenarios, up from 229.

## 0.56.0

A new hunt lens — **`reachability`** — on by default and in `fast_lenses`, default lane `[api,
web]` (two hunters, each half the target list, which is most of what keeps it fast).

It is the cheapest live check in the hunt: one happy-path call per frontend route and backend
endpoint, once, no edge cases, no retries. That is deliberate and narrow — `exploration` already
owns the edge-case matrix (empty, boundary, malformed, someone else's value, sent twice, each
recipe proven with a 3/3 count), and duplicating it here would just be a slower `exploration`.
`contract-drift` is the nearest existing neighbor and the clearest contrast: it diffs the contract,
the routes and the client statically and never makes a call; `reachability` is live and catches
what a static diff cannot — a route that agrees on both sides and still 500s the moment something
actually calls it.

**`skills/hunt/references/reachability-probe.sh`** is the whole technique, and the brief loads
nothing else — same rule every live lens in `lenses.md` follows: technique freely, implementation
source never. `METHOD URL` per line in, one line of `ok`/`FAIL` per target out, non-zero exit if
anything 5xx'd or timed out. No wall-clock enforcement in code — keel sets no timer on a hunter —
so the 30-second-class budget some hunts want is a property of the target list and the `--max-time`
you hand it (N targets × T seconds is the worst case), stated as such in the brief rather than
promised as something the script guarantees on its own.

`hunt.lenses`, `hunt.lens_lanes` and `hunt.fast_lenses` all gained the entry, in `lib/config.js`
`DEFAULTS` and `templates/config.yml` alike — a project with no local override of any of the three
picks it up automatically on upgrade, verified against a real project's merged config rather than
assumed.

Two new scenarios: every lens in `DEFAULTS.hunt.lenses` has a `## <name>` section in `lenses.md`
and, for this one, an executable script behind it; the script itself, run for real — `ok` on a 200,
`FAIL` and a non-zero exit on a target that times out.

## 0.55.0

A full-diff review before E2E, and two more human gates around it — none of it changes what was
there: `security -> e2e` is still legal in one step when there is nothing to review, and every new
gate defaults to the same "ask, don't decide for them" shape the rest of the flow already uses.

**`keel:code-reviewer` — one pass over the whole branch, phase 6.6.** Every review before this
point sees at most two commits (`ac-reviewer`) or the security lens alone
(`security-auditor`); nothing had looked at every AC together until now. Deliberately narrow scope
— correctness across ACs, consistency with the codebase, cross-AC duplication, behaviour outside
the spec — and explicitly not security, architecture, performance or assertions, which stay owned
by `security-auditor` one phase back and `keel:reviewer` at ship. Findings route to `review-fix`
and back, same as everywhere else; `review-fix -> security` is a new legal transition so the loop
can return to code-reviewer without a new phase.

**Two new blocking gates: before E2E, before smoke.** E2E is the first phase that needs the app
running and the last cheap point to stop; smoke is the last check before ship. Both offer proceed /
show me the diff / stop here, the same shape as the phase-9 ship gate.

**E2E tool check.** `commands.e2e` / `commands.smoke_e2e` blank used to fail inside
`keel:e2e-author` as an unexplained shell error. Now it's asked up front — set one up, or decline
and let `keel:e2e-author` still write and commit the `[E2E]` specs, untagged as run, so an unrun
`@e2e` test never quietly reads as a passing one downstream.

`code-reviewer` registered in `AGENT_DEFAULTS`/`AGENT_EFFORTS` (opus/high, matching `reviewer`) and
its own `CODE-REVIEW: pass|findings` result line, never `BLOCKING` or `AC-REVIEW` — the same reason
`ac-reviewer` has its own label: a scoped verdict must never be misread as a different gate's.

215 scenarios still pass, plus two new ones: the `review-fix <-> security` round trip, and
`code-reviewer`'s result-line contract.

## 0.54.0

Two loop choices, both additive — the paired loop and ship's sequence are unchanged defaults, and
all 211 existing scenarios pass untouched.

**`loops.commit_style: single` — one commit per criterion.** The test and the code written
together, `keel state ac-done`, one `feat(AC-n)` commit, no `red-done`. The `feat(` prefix is
deliberate: `keel trace` finds each AC by it, so trace needs no change at all. The new `ac` phase
permits tests and source together, which `review-fix` and `trivial` already did.

Its cost, recorded once: nothing verifies the test ever failed. A test written beside its code
passes the moment it exists, so a tautological assertion has only ship's assertions lens left to
catch it. `paired` stays the default and every RED/GREEN guarantee holds there.

`keel audit` is the one existing check that had to learn about the mode — it flags a `feat(` commit
carrying tests, which is exactly what single mode produces. Verified both ways on identical
history: flagged under `paired`, clean under `single`.

**Ship's steps are asked, in three bands.** The middle band is the point: skipping `release`,
`coverage` or `deps` **defers** the work — `keel pr` still refuses without a fresh verdict for
HEAD. Only `security`, the reviewers and the reverse-trace walk are genuinely optional; merge,
audit, trace and the final review are not offered at all. `keel state ship-skip <step> --reason`
records each one, and it appears at the final review and in the PR body, like an unlock.

**And a real defect, found while disabling coverage on a live project.** `coverage.gate_commands`
looked like the off switch and is not: `matchesAnyCommand` (`lib/hooks.js`) reads
`phrases && phrases.length ? phrases : DEFAULT_GATE_COMMANDS`, so an **empty list falls back to the
defaults**. Setting `gate_commands: []` leaves the gate fully armed while reading as "gate
nothing" — a check you believe is off and isn't, which is worse than one that is on.

There is now a real switch, `coverage.enabled: false`, and a scenario asserting both halves: that
it drops the gate, and that `gate_commands: []` still does not.

## 0.53.0

**Design references for both lanes** — `references/design.md` under
`keel:kotlin-spring-implementation` and `keel:web-implementation`. References rather than new
skills, so they cost nothing per turn and load when the work calls for them, which is the pattern
every other reference here follows.

**Both are written against the minimum-code rule rather than around it**, because that is the
tension anyone applying SOLID inside keel hits first. GREEN forbids an abstraction no test drives;
a principle applied before a second caller exists is speculation with a respectable name. So the
refactor phase now loads them, and the AC loop says why: there, the duplication is already real and
the tests hold the behaviour still while it moves. Both open with the same test — **name the second
caller** — which settles most of these arguments before they start.

They are also willing to say which principles do not pay here. Dependency inversion is the one most
often cargo-culted in a Spring codebase: an interface with one implementation adds a file, a jump in
every trace, and a mock free to assert a contract the real adapter never produces — which is
`test-integrity`'s first finding. In React, props *are* the injected dependency and most of it is
already done for you.

The Kotlin reference covers value classes for identifiers (a swapped `userId`/`accountId` becomes a
compile error), why a `data class` must never be a JPA entity, `require`/`check` over an unreachable
validation branch, and a table of patterns with the cost keel will charge for each. The TypeScript
one covers making illegal states unrepresentable instead of three booleans and an optional payload,
branded ids, deriving types from the contract rather than restating them, and the hook rules that
are correctness rather than style — a missing dependency array entry is a stale closure, which is
the hardest class here to reproduce.

## 0.52.0

**"Say it as you write it" — the rule against silent compliance, in all four places it was
missing.** The failure: writing code you would report as a finding in someone else's review and
saying nothing, because a decision of the user's explains it. A constraint explains a choice; it
does not make the choice good. Treating "that was ruled out" as closing the question collapses two
separate things — complying, and staying quiet.

It is close to unauditable from the outside, which is why it needs encoding rather than good
intentions. The diff looks deliberate. The only person who knows it would have been written
differently is the one who wrote it, and **nobody can review an absence of objection.**

The trigger, applied at the moment of writing: *would I file this in someone else's PR?* If yes,
one sentence naming the cost — then write it anyway, because it was decided. Three signals that
always trip it: **duplication about to be repeated again** (the third copy, not the tenth), **a
branch no test can reach** (which will also miss the coverage floor later), and **a constraint
older than the code it shapes** (the further a decision is from its consequences, the more it
needs restating).

Now in four places, because the report that prompted this named three of them as having each
failed independently:

- `keel:implementer` — says it while writing, as step 3 of GREEN.
- `keel:ac-reviewer` — hunts for it at the gate, with "would you file this in someone else's PR"
  as the explicit test for its code-quality question.
- `skills/feature/references/ac-loop.md` — the rule in GREEN, so it holds whether or not a
  subagent writes the code, and the flag lands in the gate summary where the person who made the
  decision can see what it cost.
- `spec-authoring/references/clarify.md` and the spec template — **record what a constraint will
  cost, beside the constraint.** A constraint with its cost written down is a decision a reviewer
  can see; one without becomes invisible the moment it reaches code.

None of this is relitigation. No stays no. It is flagged once, when it bites, with the cost named.

## 0.51.0

**`keel:ac-reviewer` — the AC gate gets its own reviewer.** `keel:reviewer` opens with *"the
prompt names the lens and the scope"*, and ship honours it: one agent per lens from
`review.lenses`, over the branch. The four AC-scoped dispatch sites named **no lens at all** —
`ac-loop.md:129` and `:133`, and the two strings the CLI prints at `cli.js:322` and `:646`. So
reviewing one criterion swept all five lenses, each loading its own reading list, and cost about
what ship's entire review round costs. A review that expensive stops being run, and since
`approve` skips it the cost fell on whoever was being careful.

The new agent is `opus / medium / 12 turns` and asks three questions and no others: is the
criterion met, does the test prove it, and is the code good and consistent with the files it
touches. Security, architecture and performance stay out — ship re-runs all three over the branch,
which is where they belong. Its scope is the two commits, and it may open a touched file to see
the surrounding conventions but may not read past them or reach for `main...HEAD`.

It ends `AC-REVIEW: pass|findings` rather than `BLOCKING: yes|no`, so an AC-scoped verdict can
never be read as ship's. **`keel:reviewer` is untouched** — ship and the coverage loop still use
it exactly as before, and a scenario asserts both halves of that.

**And a real defect found while verifying it: `keel models reset` was destructive.** Running it as
a round-trip check reverted `test-author` and `implementer` from the opus/high set in 0.36.0 — plus
`explorer` and `librarian` — because 0.36.0 wrote the agent *files* and never `AGENT_DEFAULTS`.
Four agents had been silently disagreeing with the map they are reset to, so any reset threw away
a deliberate choice. The maps now carry the intended values, the files match, and a scenario fails
if any agent ever drifts from them again.

## 0.50.0

**The spec freezes at the plan gate, not the spec gate.** 0.49.0 stamped `frozen` in phase 1 —
and phase 2 then appends the AC order, the files per AC and the test layer to that same document.
The guards agreed with phase 2, not with the stamp: `plan` has always been allowed to write
`specs/`, and only `red`, `green` and `gate` deny it. So the file said frozen for a whole phase
while it was still growing.

Two dates now, because they certify different things. **`approved`** is the spec gate: the
criteria were agreed *before* anyone read the implementation, which is the entire reason phase 1
works from the interview and the contract rather than from the code — a spec written with the
codebase open describes what is convenient, and nothing afterwards shows that happened.
**`frozen`** is the plan gate: nothing more will be appended, and from here a change is a dated
amendment.

It also gives the explorers' exposures somewhere to land. Concurrency, idempotency, authorization
and data-shape findings arrive in phase 2, and against a spec frozen one phase earlier each of
them needed an amendment to a document minutes old. They are criteria added before the freeze now,
which is what the ordering was for.

Nothing moved in the guards — they already encoded this. Only the document had it wrong.

## 0.49.0

**The spec template carries its own identity.** It had `id`, `title` and `status: draft` and
nothing that told a reader six months later which of three things they were holding. Now:
`slug`, `created`, `frozen`, `superseded_by` and `contract` — taken from
`ai-coding-toolkit:spec-driven-development`, which had all of them.

`frozen` is the one that earns its place. keel's freeze is enforced by *phase* — `specs/` denied
in red, green and gate — which is invisible to anyone reading the file, so a frozen spec and a
draft looked identical on disk. The gate now stamps `status: frozen` and the date rather than
writing a footer line, and `superseded_by` means an archived spec says whether it was replaced or
abandoned.

**User stories, and a definition of done.** Criteria with no stated actor are behaviours nobody
asked for; the template says one per distinct actor, and that a story with no *so that* is a task
with a role bolted on. The definition of done is mostly things keel enforces, and is worth writing
because the two or three lines it cannot — no behaviour outside the spec, a migration strategy
chosen against real numbers, a dependency that was a criterion — are exactly the ones that get
skipped.

Both are checked: `keel spec check` warns on either left empty, alongside validation, data and
out of scope.

**And `filled()` now catches a placeholder inside a line.** It only stripped lines *starting* with
`<`, so `- As a <role>, I want <capability>` read as content and said nothing — the one shape a
placeholder takes inside a list. A `<token>` anywhere now marks the line as template, while a
comparison like `len < 3` is left alone because the token must start with a letter.

Writing that found the same bug in my own draft: explanatory prose *inside* a section counts as
content and silences the check for it. The guidance is an HTML comment now, which is what the
other sections already did.

## 0.48.1

**A fast init reported five defects for a question nobody had been asked.** `keel memory check`
read an unanswered section gate as *"5 problems — architecture.md is missing, domain.md is
missing…"*, so `/keel:feature` after `/keel:init --fast` looked broken when the state was exactly
the one 0.13.0 designed for: a partial knowledge base is legal and the rest can be built later.

One line: `const chosen = sel === null ? SECTIONS : sel`. Null means *nobody has answered*, and
treating it as *all five were chosen* sent every absent section through `checkSection`, which
duly reported each as missing. Three states existed and only two were handled.

Null now reads **"not chosen yet"** and passes, with the two commands that answer it printed
underneath. The gate keeps its teeth where they belong — `keel memory update` still refuses while
the selection is null — and a section that *was* chosen and is absent is still a problem, which is
the case this must not weaken. A scenario covers all three.

## 0.48.0

**The dependency rule finally covers the path Kotlin actually uses.** The shell guard refuses
`npm install <pkg>`, and for a Gradle project that is not how a dependency is added at all — you
edit `build.gradle.kts`, which is `api-main` and writable in GREEN, then run a bare `./gradlew
build` that names no package. The rule was strongest against the path nobody uses and absent from
the one everybody does.

Caught on the staged diff at `keel commit` rather than on the edit, and that choice is the whole
design: these files also carry source sets, compiler flags and plugin config, so a bucket that
denied the file to stop a dependency line would fail closed on every legitimate build change. The
commit is the last boundary before history and the only one that can read *what* changed. Gradle,
`libs.versions.toml`, `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml` and
`go.mod`; the `keel state dep` allowlist lifts it, matching either the full coordinate or the
artifact name.

**Eight scenarios for everything since 0.35.** `lib/sim.js` had been byte-identical across thirteen
releases — which is how a routing bug introduced in 0.16 survived until a review found it in 0.45.
There are now scenarios for the dependency guard in both forms, its allowlist, the flag-before-
subcommand bypass, the `fix` commit keeping `green` and staying in its repair phase, the `refactor`
phase allowing production code while freezing tests and refusing `red`, the spec being frozen in
the loop and reachable from it, and a secret refused at commit.

Writing them found two things worth naming. keel's own `postTool` hook **blocked the file
containing the fake AWS key fixture**, which is the rule working on its own source. And the release
gate broke four existing scenarios plus a fifth whose assertion was hardcoded to `(coverage|deps)`
— the board and the hook never disagreed, the test simply could not see a third gate. All four
needed a release verdict written *after* their last commit, since a verdict is per sha. **208/208.**

## 0.47.0

**A REFACTOR phase, so GREEN's rule has somewhere to discharge.** `keel commit refactor` had been
defined and unreachable since the beginning — there was no `refactor` phase at all, only the commit
type. GREEN's "minimum code that passes" is correct and accumulates duplication: three criteria each
add the smallest thing that worked and none was allowed to tidy. `green → refactor → gate` now
exists, optional, skipped when there is nothing to do.

Two rules, both enforced rather than asked for: **tests stay frozen** — a refactor that may edit its
own tests can change behaviour and still be green, which is the only thing separating a refactor
from a rewrite — and **it cannot reach `red`**, so nothing new is built under cover of cleaning up.

**`keel:kotlin-spring-implementation`.** The frontend had `keel:web-implementation`;
`kotlin-spring.yml` had no `implementation:` key at all, so a backend GREEN got placement advice
and nothing about controllers, validation, error mapping, transactions or the persistence edge. It
leads with the `@Valid`-on-a-`@RequestParam` trap that `keel:librarian` already uses as its example
of a citation proving code *says* something without proving it *does* — and with where a
persistence failure actually surfaces, which is why a typed-error `catch` at the port is so often
dead code the caller never sees.

**A layered placement guide for the frontend.** `ts-react.yml` offered `layered` with real boundary
rules and no `layered-web.md` to explain them. It now covers the one rule keel enforces —
`components/**` may not import `pages/**` — and the two cases where that bites, neither of which
wants an exception.

**A hook test example.** `web-testing/examples/` had a component test and nothing at the layer most
`[WEB]` criteria actually hit. `useBookmarks.test.ts` covers the loading state as a criterion in
its own right, and the assertion that a failed load stays distinguishable from a successful empty
one — `data` undefined rather than `[]` is what lets a screen show an error at all.

**The loop subagents load their own skills.** `test-author` said "see the Kotlin/Spring or web
testing reference skill" and relied on a hook to route it; `implementer` named none. Both now say
which skill, for which lane, and to load it themselves — and `implementer` carries the bottom-up
build order rather than leaving it in a reference it was never told to read.

## 0.46.0

**Nothing verified the whole stack after the last change.** Ship never ran `keel verify release`,
no release verdict was stored, and `pushBlockers` did not ask for one — while steps 1 and 6 can
change code *after* phase 7's E2E already ran. A branch could be pushed on the strength of a suite
that never saw its final commit. Ship step 1b runs it, the verdict is stored per sha in
`.keel/release.json`, the push is refused unless it matches HEAD, and it is shown at the final
review.

**With an exit for projects that have no browser.** `verify release` hard-failed without
`commands.e2e`, so the gate above would have stopped every backend-only project from shipping at
all. `--skip "<reason>"` records it in the verdict and prints it in the PR body, the way an unlock
is — the gap stays visible instead of being assumed away.

**`tests.module_suite_at: gate` is the default and ran nothing.** Only `every-ac` was implemented;
`gate` and `lane-end` were read nowhere. On the default setting a cross-AC regression first
appeared at phase 6, several criteria later, with nothing to say which one caused it. The lane
suite now runs at `keel gate ac approve`, and a break refuses the approval and says the AC passes
on its own — which is the sentence that points at a regression rather than at this criterion.

**Every `@SpringBootTest` could sit unrun.** `kotlin-spring.yml` declares an `integration` layer at
`src/integrationTest/kotlin` and set `api_test_module` to `{BUILD} -q test`, which does not include
that source set. The module suite reported green over tests it never ran. Now `test integrationTest`
— Gradle skips a task it does not have, so it is safe on projects without one.

**Secrets are scanned at commit, not only at the edit.** The edit-time scan runs in `postTool`, so
the file is already written, and the Bash path returns before it — a shell write was never scanned
at all, while the README claimed credentials were "blocked at the edit". The staged diff is checked
in `keel commit` now, the index is reset on a hit, and the README says what actually happens.

**Also:** a cross-cutting fix can take the spec id (`keel commit fix SPEC-NNN`) instead of being
pinned to whichever of three ACs was named first; and ship step 6 carries the AC gate's rule about
showing dismissed blocking findings, with those listed again at step 7.

## 0.45.0

**A `fix` commit no longer rewinds the flow or overwrites the commit it fixed.** One line did both:
`if ((type === 'green' || type === 'fix') && s.acs[id]) { s.acs[id].green = sha; }`, followed by
`s.phase = 'gate'`. So a fix during ship wrote itself over the AC's original GREEN sha — the one
the trace table points at, making an AC's own implementation unfindable the first time a reviewer
asked for a change — and then sent the flow to the AC gate, where approving moves on to
`integration`, past E2E, smoke and the final review. Every repair route documented in 0.43 landed
there.

Fixes are recorded in `acs[id].fixes[]` now, `green` is left alone, and a fix committed from a
repair phase (`review-fix`, `coverage-fix`, `security`, `ship`) leaves the phase where it is and
says so: *"still in ship — return by the route that sent you here."* It used to print
`gate: run keel gate ac …`, which was the instruction that did the damage.

**`keel state dep <name> --by user` — the 0.40 dependency rule had no exit.** The guard refused
every install while a flow was open, and nothing lifted it, so a dependency could be specified,
gated, approved and committed and still not be installable. The allowlist is per package and per
flow: approving `zod` does not approve `lodash` and does not carry to the next feature, a version
suffix is stripped so `zod@3.22` matches, and `--by user` is recorded because a model approving its
own dependency is the failure the rule exists to prevent.

**The dependency detector had two bypasses and four false positives.** It refused
`npm install --prefix web` (reading "web" as a package), `pip install -r requirements.txt`
(installing exactly what is pinned), `npm install ./packages/shared` (a workspace already in the
repo), and any command whose *quoted message* mentioned an install — including a `keel commit`.
Meanwhile `npm --prefix web install zod` and `uv add httpx` walked straight through. It now strips
quoted text, understands flags that take a value, ignores paths and lockfiles, finds the subcommand
behind flags, and knows `uv`. Fourteen cases checked.

## 0.44.0

Six fixes from a review of 0.43, all of them wrong guidance rather than missing guidance — the
kind an agent copies before anyone notices.

**The dependency route in 0.43's repair table pointed at a read-only phase.** It sent a 2b finding
to `security`, which writes nothing but `other`. Now `review-fix`, like the rest.

**A coverage pass returns to step 1, not step 2.** `/keel:cover` can delete unreachable production
code, so returning to the coverage check alone would skip the verify it just invalidated.
`/keel:cover` said step 1 and the ship table said step 2; step 1 wins.

**`web-testing` contradicted its own 0.41 table**, still saying "RED: only `*.test.tsx` files"
two sections below a table listing four suffixes and two directory forms. It points at the table
now.

**The `BookmarkForm` example could never pass.** `expect(() => bookmarkSchema.parse(res.json()))
.not.toThrow()` parses a *Promise* — `res.json()` is not awaited — so it always throws and the
assertion always fails. It also used a raw `fetch`, which the same skill forbids one section
earlier, and so only checked an MSW handler against the schema it was written from. Now it goes
through the generated client and asserts on the parsed value, since `parse` returning *is* the
assertion.

**The hunt skill still described the old fast set** — "security, technical and contract-drift,
five hunters" — against a template that has named five lenses and nine hunters since 0.22.

**The README claimed 0.13.0 and 196 scenarios.** Thirty releases and four scenarios stale. The
version is gone from the title rather than corrected, and the scenario count now says how to get
it: both were hardcoded numbers with no reason to stay true, the same failure as the CLI banner in
0.19.0.

## 0.43.0

**Ship said to fix what it finds and never said how — and following it literally hits a guard.**
The `ship` phase writes nothing but `other`, which is correct: ship is a sequence of checks, and a
phase that could edit production code between them would be checking a moving target. But step 1
said "at most 2 fix rounds" and step 6 said "fix blocking findings, one commit each", and both of
those edit production code. The skill named a phase exactly once in the whole file, at step 8, for
`memory`.

The same shape as 0.38.0's AC-gate hole, and worse here because ship has five kinds of finding.
Every route already existed in the transition table — `ship → review-fix`, `coverage-fix`,
`security`, `red`, and back — and none were written down. `/keel:cover` was the only one that
handled its own phase, which is why coverage was the one that worked.

There is now a table at the top of the skill: what found it, which phase to move to, what to commit
it as, and which step to return to. `review-fix` is the general-purpose one — it allows production
code *and* test files, because a finding is sometimes that the test is wrong.

Two things stated with it. **Two rounds, then ask**: a third means the check and the change
disagree about something repetition will not settle, and that is the user's decision rather than
another attempt. And **some findings are not fixes** — a trace gap can mean the AC was never really
done, a reviewer can be describing a wrong criterion rather than wrong code, and 6b routinely
surfaces scope that should have been an amendment. Those go back to the AC loop or the spec, and
shipping does not resume until they do.

## 0.42.0

**The amendment gate is a menu, and it comes before the commit.** `spec-amended` was a blocking
question with two answers in practice — approve, or say what is wrong — and it sat next to the
commit in a way that read as a formality. It now runs the same way the spec gate has since 0.31.0:
write the dated block first so there is something concrete to judge, **stop before
`keel commit docs`**, and show the block as it reads, what it changes, and which ACs it touches
including any already green.

Four answers. Approve commits it and returns to the loop. **"Let me give you context"** is the one
worth naming separately and the reason to ask before committing rather than after: the user knows
something the amendment is missing, and the block gets rewritten with it and shown again. Change
the amendment revises and returns here. Both loop as many times as it takes, and only Approve
reaches a commit — nothing is committed while a question is open, which is what makes it a gate
rather than a notification.

**And rebuilding the spec is now one of the four.** Sometimes an amendment is the third patch on a
document that was wrong from the interview. `keel state close` archives the flow to
`.keel/archive/` and clears state, and the skill is explicit that this is a legitimate outcome
rather than a failure — a model that treats starting over as defeat will argue for a patch nobody
wants.

Two things it makes you say out loud before that choice: it **archives, it does not delete**, so
the failed spec stays readable and is evidence about the interview that produced it; and **the
commits stay** — `keel state close` does not touch git, so every red and green commit is still on
the branch and what happens to them is the user's call. Then phase 0 again, carrying what the last
attempt taught: the question not asked, the identity probe skipped, the criterion that was never
testable. Starting over without that is how the second spec fails the same way.

## 0.41.0

**Where a frontend test file goes, for a project that has none yet — and why it is not a style
question.** keel decides whether a file is a test from its *path*, and the phase guards act on that
answer. A file it reads as source cannot be written in RED, and can be written in GREEN, where
tests are supposed to be frozen. A misplaced test does not fail loudly; it stops being a test as
far as the flow is concerned.

The trap has a name: **`src/__tests__/Button.tsx` classifies as `web-src`.** `__tests__` is not
`tests` — underscores are not stripped — so one of the most common React layouts lands a test file
in the production bucket. `src/__tests__/Button.test.tsx` is fine, because the suffix is doing the
work. The rule to carry: **always use `.test.`/`.spec.`**, and the directory stops mattering.

`keel:web-testing` now opens with the classification table and a starting layout for a repo with no
tests at all — colocated beside the component, shared setup under `test/`, which is a test path by
directory and needs no suffix. Colocation rather than a mirrored tree: the test moves with the
component, a renamed folder cannot orphan it, and `keel verify ac` filters by AC tag rather than
location.

And the line between the two rules that now meet here: `vitest.config.ts` and `test/setup.ts` are
new **files** and RED may write them. Needing Vitest, Testing Library or MSW **installed** is a
dependency, which 0.40.0 made spec work.

## 0.40.0

**Adding a dependency is spec work, and the hook now enforces it.** 0.39.0 said to build the test
harness when it does not exist, and left a hole big enough to drive a supply chain through: if the
harness needs a *package*, building it means installing one. Nothing stopped that, and it is not a
build step — a new dependency outlives the branch, somebody maintains it, it carries a licence, and
it ships to everyone who runs the code. Getting one test to compile is not a mandate to decide it.

`guards.checkBash` refuses `npm|pnpm|yarn|bun install|add`, `pip install`, `poetry add`,
`cargo add`, `go get` and `brew install` **during a flow**, and says what to do instead: put it in
the spec as a criterion, take it through the gate, then install it — or amend, if the spec is
already frozen.

**The distinction the rule turns on is a package name.** A bare `npm install`, `npm ci` or
`./gradlew build` restores what a lockfile already names and is left alone — the run ladder itself
does `npm install --frozen-lockfile || npm install`, so a rule that blocked those would break the
setup it exists to protect. Twelve cases checked, including that one.

It applies **during a flow only**. `/keel:init` and the ladder install what a project needs before
any flow is open, and are untouched.

Stated in the AC loop as well as enforced, because a guard that only refuses teaches nothing about
what to do next.

## 0.39.0

**What to do when the test harness does not exist yet.** The first AC in a package often has
nothing to build on — no fixture, no factory, no container setup, no MSW handlers — and keel said
nothing about it while behaving in a way that reads as a wall: writing the harness is allowed
(anything under the test path is `api-test` or `web-test`), but the first run fails on
`cannot find symbol` or a Spring context error, and `red-done` refuses those as setup failures.
Correct refusal, no documented recovery, so the obvious reading was that RED forbids the thing RED
in fact permits.

Written down now: build it, keep going until the test *runs* and fails on its **assertion**, then
`red-done`. The refusal is the difference between "my test fails" and "the behaviour is missing",
and only the second is a RED.

With three limits. Build only what this AC's test needs — a factory with fields nothing asserts on
is the test-side version of code no test drives, and easier to get wrong because scaffolding feels
free. It rides in the `red` commit, which already allows test files; say so in the message so a
large first commit reads as deliberate. And the first AC pays for what the rest reuse — worth
saying at the gate, since the diff will look disproportionate beside the criterion it proves.

**If the harness is large, that is a planning finding, not a RED step.** `keel:explorer` now has to
say explicitly when nothing comparable exists, the same way it must say "no exposures found" —
because silence reads as *there is something there*. Discovered in RED instead, an entire test
platform ends up buried inside a commit that claims to be about one criterion.

## 0.38.0

**The AC gate could ask for a review and had nowhere to put the answer.** `review` ran
`keel:reviewer` on that AC's diff and "returned to the gate" — and the gate phase writes nothing
but `other`, so acting on a finding there is refused. Every piece needed already existed and none
of them were connected: `gate → review-fix` was a legal transition, `review-fix` allowed production
code *and* test files, and `keel commit fix <AC>` took both. Nothing said so, so the obvious move —
edit at the gate — hit a guard with no documented recovery.

The loop is written down now: `keel state phase review-fix`, fix, `keel commit fix AC-00n
"review — …"`, back to the gate. Two rounds, the same cap ship uses; a third means the review and
the implementation disagree about something neither will settle, and that goes to the user.

**Why that phase allows tests as well as code** is worth saying, because it looks like a hole in
the RED freeze and is not. A review finding is sometimes *"this test asserts the wrong thing"*, and
a fix loop that could only touch production code would force the code to match a bad test. The
freeze exists to stop a test being quietly weakened to get green — not to stop one being fixed
after a reviewer showed it was wrong.

And the sort before fixing: the code is wrong (fix it), the test is wrong (also fix it, here), the
*criterion* is wrong (`reject --note` — back to `todo` and `red`, not a fix), or the *spec* is
wrong (the amendment path). Two of the four are not fixes at all.

**Then show them the review and the fix before the gate is decided again.** A human asked for that
review; coming back with "reviewed and fixed, approve?" answers it on their behalf and hides the
two things they wanted — what the reviewer actually said, and what was decided about it. So: each
finding in the reviewer's own words, what changed per finding with its commit sha, anything that
turned out to be a criterion or spec problem rather than a fix, and **what was not changed and
why** — the part that gets dropped, and the one that is a judgment made on their behalf if it goes
unsaid. They may still reject after reading it, which is the point: the review is evidence for the
decision, not a replacement for it.

## 0.37.0

**Clarification is bundled, not borrowed.** 0.30.0 had phase 1 say *"if
`ai-coding-toolkit:clarify-loop` is available, load it"* — a soft dependency on another plugin
being installed, which meant the interview quietly got worse wherever it was not. It now lives in
`keel:spec-authoring` at `references/clarify.md`, read first, before anything is asked.

Scoped to a keel feature rather than copied whole: the stack, the test commands, the gate mode and
the review lenses are answered once at init and sit in `.keel/config.yml`, so the bundled version
does not ask them again. What it keeps is the part a feature interview forgets.

**The identity probe is the piece worth having.** If the task mentions users, accounts, roles,
login or permissions, three very different things are being called the same word — a named entity
with a foreign key, full authentication with sessions and tokens, or authorization over an auth
layer that already exists. They differ by an order of magnitude in scope, and a spec written before
that is settled is a spec whose criteria are the wrong size. The answer goes *into* the spec, since
the next reader will otherwise assume whichever one their last project used. And if the answer is
authentication, phase 1 stops: that is a design decision with real alternatives, not a criterion to
write.

Also bundled: the five questions a spec must answer, the per-task-type blocks adapted for fix and
performance work, and the stop-and-clarify conditions — which now point at phase 1's migration
section for the schema case rather than just saying stop.

## 0.36.0

**The RED and GREEN authors run on Opus at high effort.** `keel:test-author` was sonnet/medium and
`keel:implementer` sonnet/high. They write the two commits every acceptance criterion is made of,
under constraints that are easy to satisfy badly: RED must fail on an assertion rather than on
setup — `red-done` refuses the difference — and GREEN must be the minimum code that passes, built
bottom-up, stopping the moment it goes green. Both are judgment under a rule, which is where the
model choice shows.

Note this is also where the gate mode decides how much review the output gets: with gates skipped,
or in a background lane where they are skipped by definition, these two agents are the only thing
standing between an AC and the diff a reviewer sees at ship.

Set with `keel models set opus test-author --effort high --yes` — which writes the agent files
under the plugin source, so it survives a release rather than being clobbered by the next one.

## 0.35.0

**The contract is shown before it is committed.** It is the only artifact in the flow with
consumers outside this branch, and phase 3 edited it, regenerated both sides and committed with
nobody asked. A contract change can be entirely valid and still wrong — a renamed field, a narrowed
enum, a response that became nullable, a required request field added where old callers send
nothing. `keel verify fast` proves the shape compiles and the two sides agree; it cannot know who
else is calling. The delta goes up as a diff, endpoint by endpoint, marking what is new, what
changed shape, and what was **removed or narrowed** — the half that breaks callers. It is also the
cheapest possible moment: after this commit, generated code exists on both sides, every AC is
written against it, and the lanes may fork.

**Security findings are settled by a person, and only when there are any.** Phase 6.5 said "fix
what is real", which left the model deciding which findings were real — the one judgment it should
not make alone, because dismissing a finding is invisible and permanent: nothing downstream
re-checks it and the branch ships as though it was never raised. Each finding now goes up with what
it claims and what is proposed — fix, accept with a recorded reason that reappears at the final
review, not a finding and why, or the spec was wrong and this is an amendment.

Deliberately conditional. A clean run says so in one line and moves on: a gate that fires when
there is nothing to decide is how gates stop being read.

## 0.34.0

**A gate before ship.** Phases 6 through 8 run without stopping — integration, security, E2E,
smoke — so `/keel:ship` used to begin without anyone having been asked anything since the last AC
gate. Ship is the most expensive sequence in the flow: two verify rounds, coverage, audit, trace,
four reviewers in parallel, up to two fix rounds. Stopping here costs a question; stopping in the
middle of that costs the run. The state goes in front of them first — ACs done, what 6.5 found,
what E2E and smoke cover, anything still open — with ship it, show me the diff, something is not
right, or stop here.

## 0.33.0

**Phase 6.5 exists in the flow now.** It has been in the state machine all along — the transition
table allows `integration → security → e2e`, `state.js` carries a comment explaining that security
sits there *"so a finding is fixed before any E2E, smoke or ship time is spent on the change"*, and
`keel:security-auditor` and `keel:dependency-triager` both name it as the phase they belong to.
`/keel:feature` never mentioned it. A run straight from the skill went 6 → 7 → 8 → 9 and skipped it
silently, leaving security to one of four parallel lenses at ship — after the E2E and smoke time
the phase was placed to protect, and where a dependency finding blocks the push instead of being
fixed cheaply.

Two pipelines in parallel: the auditor over the branch diff against the spec, and `keel verify deps
--force` feeding the triager, which judges reachability. A finding meaning the *spec* was wrong —
an authorization rule nobody specified — is an amendment, not a fix.

**The final review shows the whole picture, including the parts that make it look worse.** It
listed what to show; it did not say that omission is the failure mode. A summary is not a case for
the change: every exception left out makes the decision worse while making the summary read better.
So the list is now explicit about the uncomfortable half — every amendment with its `Was:` line,
every coverage line accepted rather than covered, the non-blocking findings nobody fixed, every
skipped gate *and its scope* including a background lane where no one chose per-AC, every unlock
with its stated reason, and anything in `state.flaky`.

And: do not lead with the summary and bury the exceptions. Three skipped gates and an accepted
coverage block are the headline, not a footnote after the green checkmarks — a reviewer who learns
afterwards that a gate was skipped was handed a decision they did not know they were making.

## 0.32.0

**GREEN says what order to build in.** It said "the minimum code that makes the test pass" and left
the route to instinct — which is to start at the controller and work inward, so nothing executes
until the last piece lands and a failure at the end could have come from any of six files. Taken
from `ai-coding-toolkit:spec-driven-development`, which had this and keel did not:

```
migration → entity → test fixture → authorization rule → use case
          → input validation → response mapping → controller → route
```

Bottom-up, each layer is exercised as it arrives and the thing that broke is the thing you just
wrote. **Stop at green** — the order is a route, not a checklist: a layer written past green is
code no test drives, which is the one thing GREEN forbids. Most ACs touch three or four of these;
one that seems to need all nine is usually two criteria wearing one number.

Nothing else in the loop changed. The RED classification, the flake rerun and the stall ladder
stay as they are.

**The parallel lane is the user's decision, not the model's.** It read as an option to take when
convenient. It changes how many terminals they are watching, and a background lane skips that
lane's human gates *by definition* — so the choice is now an explicit question after the contract
commit, with that consequence stated before they choose rather than discovered at ship. Sequential
is the default when they have no preference: the background lane trades a category of review for
wall-clock, and only they can price that.

## 0.31.0

Three things taken from `ai-coding-toolkit:spec-driven-development`, which had all of them and keel
did not.

**The spec gate offers ways of not approving.** It was approve, or describe the problem in prose. A
bare yes/no makes disagreement expensive to express, and expensive disagreement gets skipped — so
the gate now offers editing named ACs, rewriting a named section, an adversarial review before
deciding, or rejecting back to the interview. Every path but Approve returns to the gate.

**A freeze is dated in the document, and an amendment is appended.** keel's freeze is enforced by
phase — `specs/` denied in red, green and gate — which is invisible to anyone reading the file. A
`Frozen: <date>` footer says what happened and when. And an amendment is a dated block that keeps
the original criterion in a `Was:` line, rather than an edit in place: a criterion rewritten
silently leaves a document reading as though it always said that, and the reviewer at ship cannot
tell what was agreed in phase 1 from what was agreed on Thursday.

**Ship walks the diff the other way.** Every check in the flow runs spec → code: each AC has a
test, each test has a commit, coverage holds, the lenses read the change. Nothing ran code → spec,
so a behaviour nobody asked for passed all of them — `keel trace --strict` only walks the direction
where every AC is accounted for. New step 6b names anything implementing no criterion and forces it
to be one of three things: it belongs to an AC and the trace table is wrong, it is scope that should
have been an amendment, or it comes out before the PR. Step 7 gained the full mergeable checklist,
ending where it should: no behaviour outside the spec was added.

## 0.30.0

**A schema change gets its own section, and the questions that decide it.** It was a bullet under
"data and migration notes" — for the one part of a feature that is hard to undo, runs against data
nobody in the room created, and fails in production rather than in a test. Phase 1 now asks the
sizing questions first, because they are the whole difference between a formality and an outage:
row count and growth, whether there is a quiet window, whether the app must stay up, replica lag,
and whether existing data already violates the rule being added.

Then it says to **check rather than assume** — count the rows, run the query that finds the rows a
new constraint would reject, against a copy or a disposable database. A migration written against
an imagined table is the common way this phase fails. And it names the strategy per change: add
nullable and backfill in batches before NOT NULL, `CREATE INDEX CONCURRENTLY` (which cannot run in
a transaction), expand-contract across two releases for a drop, rename or type change, violating
rows found *before* a unique constraint. Reversibility is part of the strategy — what a rollback
does, and what happens to rows written in between. The strategy becomes acceptance criteria: a
migration whose only test is "the app started" has not been tested.

**`keel:explorer` now reports exposures.** It mapped files and patterns, which is what a spec asks
for, and stayed silent about what the code it lands in is already exposed to — concurrency,
idempotency, transaction boundaries, authorization, data shape. It is the only step that reads that
code before the criteria are fixed. It names them with a `file:line` and stops there; deciding is
the spec's job. It must say "no exposures found" explicitly, because silence reads as none and the
criteria then get written as though there are none.

**Before concluding the spec is wrong, read it properly.** Most things that look missing are
already there in different words, covered by an AC not started yet, deliberately out of scope, or a
criterion being read as an implementation spec. Only when none of those hold is something absent.

**And an amendment is announced, not reported.** Tell the user before touching the spec: what it
says, what the code shows, why they cannot both be true, and which ACs change — including any
already green. Then stop. They approved the document; changing it is theirs to decide.

Phase 1 also borrows from `ai-coding-toolkit:clarify-loop` where it is available: the five
questions a spec must answer before it is written, and the conditions that mean stop and clarify
rather than proceed.

## 0.29.0

**A spec that turns out to be wrong can now be amended.** It could not be. The guards deny writes
to `specs/` in `red`, `green` and `gate` — correctly, so nobody quietly edits the spec to match
what got built — but the transition table had no route back to the `spec` phase from any of them.
Both halves were right on their own and together they left one exit: `keel state phase none`,
abandoning the flow. A spec meeting reality and losing is ordinary, and the only sanctioned
response was to throw the flow away.

`spec` is reachable from `red`, `green` and `gate` now. It costs no ordering guarantee: `spec`
itself leads only to plan, contract, red or none, so there is still no way to reach `green` without
passing through RED — which is what the transition table exists to enforce.

**And the flow says how to use it**, because a legal transition nobody documents is still a hole.
Phase 4/5 gained *When the spec turns out to be wrong*: return to `spec`, amend the file and record
why, register any new criterion, raise a blocking `spec-amended`, and commit it as its own
`docs` commit — so a reviewer at ship can see the spec moved, when, and why. The failure that
prevents is editing a spec to describe what was already built, which turns it from a contract into
a transcript while everything the flow claims about traceability still looks true.

Two things it makes you decide out loud: an AC already green under the old wording (reopen it, or
say why it may stand), and a changed API shape (back through phase 3 — an amended spec whose
contract never moved is the same drift in a different file).

## 0.28.0

**The spec is written a piece at a time, in front of the user.** 0.27.0 put a blocking question at
the end of phase 1, which was still one gate over a finished document — and a spec presented
finished gets read as finished. The user skims a page they did not watch being built, and the
criterion that is subtly wrong is the one nobody stops on.

So each piece is shown and confirmed as it is written: the four-state mockup, the request path with
its `+`/`~` marks, the numbered ACs, the data and security rules, and out of scope — which is the
cheapest thing to agree and prevents the most argument later. The table says what each piece is
really asking, because *"is this right"* over an ASCII drawing is not the same question as *"is
each criterion testable"*.

**A revision is a change too** — show the revised piece and confirm it, never apply it silently.
Silent application is how a spec drifts from what was agreed while every individual step looks
reasonable.

**And nothing is committed during any of it.** The spec file is written and rewritten freely;
`keel commit docs` happens once, after the gate, and never as a way to save progress mid-interview.
The criteria are registered with `keel state ac` only once the AC list itself has settled.

The end gate stays, with its job narrowed: it is the seam between agreeing the spec and building on
it, not the user's first look at it.

## 0.27.0

**The spec and plan gates are blocking questions now, not "get approval".** Phases 1 and 2 ended
with a sentence — *ask for approval*, *get approval* — while the AC loop next door has had
`keel gate ac` enforcing its gate all along. The two softest gates in the flow were the two that
decide everything after them: a criterion wrong in the spec is wrong in a test, in the code and in
the review, and a plan decides AC order, the files each AC may touch and the layer that proves it.

Both now raise a question keel will not proceed past — `spec-approved` and `plan-approved` — with
the decision put in front of the user first: the AC list and each gap `keel spec check` named for
the spec, the AC order and per-AC files for the plan. Answered `--by user`, which is the whole
point: a spec the model approved on the user's behalf is the failure the gate exists to prevent,
and keel already prints a model-answered question as a self-answer.

Phase 2 also says what plan mode's own approval is not. Accepting a plan in the harness confirms
what you are about to do; it records nothing in keel, `keel ask list` does not know it happened,
and the ship report cannot say a human saw the plan.

Phase 1 also stops rolling into planning. It says to hand over and start a fresh session — the
spec is the whole context phase 2 needs, and carrying an interview transcript into it crowds out
the code the explorers are about to read.

## 0.26.0

**The sweep now says what a hunter prompt must contain.** It said "give each one exactly one brief,
its lane, and nothing about what the others are looking at" and stopped there — so repo root, scope,
the candidate cap, the output contract, the scratchpad path and the base URLs were left to whoever
was dispatching. They were being supplied, well, from memory. A field left out is one a hunter
guesses at or works without.

**And it says to name the environment, and whose it is.** This is the part that could cost
somebody real data. Several briefs say *provable against a disposable database* — `data-migration`
in as many words — and a hunter cannot tell a disposable database from a shared one by looking. Say
nothing and it takes the brief at its word and acts as though nothing else depends on what it
drops. So the skill now carries the caution verbatim: insert probe rows freely, never truncate a
table or delete a row you did not create, and create your own database if you need a disposable one.

keel cannot enforce this. The guards stop writes to the *repository*; nothing stops a hunter
reaching whatever connection string it was handed. That warning existed, buried in the notes,
phrased as advice to the operator about provers — the people it needed to reach were the hunters,
in the prompt.

Also: the sweep said "eight lenses become thirteen hunters". It is ten and seventeen.

## 0.25.0

**The three acting lenses now load a technique skill.** Eight of the eleven always did —
`concurrency` takes `reproduce-race.md`, `test-integrity` takes the testing skill for its stack.
`exploration`, `messaging` and `observability` loaded nothing, which was an over-correction on my
part: their briefs say never to read implementation source, and I let that swallow a second,
unrelated thing.

Those are different. **Technique** — how to drive a browser, how to get three useful lines out of a
log — says nothing about what this code intends, so there is no tautology to avoid. **Implementation
source** does, and that is the prohibition worth keeping. Each brief now draws the line explicitly
rather than leaving it to be inferred from a flat "nothing".

- `exploration` loads `keel:playwright` on the web lane, for stable locators and trimmed output.
- `messaging` loads `reproduce-flaky.md`: its findings are statistical, and repeat-until-it-breaks
  is exactly the method for making one show up on demand.
- `observability` loads `logs-and-traces.md`, which is most of that lens's actual work — and its
  example now says `keel stack logs api` rather than reaching for `docker compose` by hand, which
  is what the brief was telling hunters to do while a skill documenting the better way sat unread.

## 0.24.0

**Finishes what 0.23.0 started.** That release fixed the instances I already knew about; this one
comes from reading all eleven candidate examples instead of grepping for the names I had seen.
Three more were carrying identifiers from someone else's codebase: `technical` deleted a user who
owned a website, `test-integrity` named a `CreateUserUseCaseTest` asserting a `PERSISTENCE_ERROR`,
and `data-migration` named an `app_user.email` column. All three now describe the behaviour — a row
another table still references, a use-case test mocking a typed persistence error, an email column
unique case-sensitively.

The hunter's output template also stopped naming a real class in its `where` field, where it read
as an example of a file to cite rather than a placeholder.

**What is deliberately left alone:** the `Bookmark*` domain in the testing, Playwright and web
skills, and `Seat*`/`Subscription*` in the debugging references. Those are runnable code examples
teaching how to write something, where a concrete name is what makes the code readable and nothing
suggests the endpoint exists in your repo. The rule is about prose that tells an agent *what to
look for* — a named endpoint there points it at a place instead of teaching it a method.

## 0.23.0

**The hunt briefs no longer borrow another repository's endpoints.** Four lens examples and the
hunter's own brief described one particular application — `/api/websites`, `version_number`,
`client.ts`, `DomainPortImpl` — as though a hunter would find them. keel is a generic tool for
Kotlin and TypeScript projects, and those names are in none of them.

This was not cosmetic. The header of `lenses.md` says the example is the section that matters, and
a hunter pattern-matches an example harder than it obeys the prose around it: a concrete endpoint
points it at a place instead of teaching it a method, and on a repo with something merely adjacent
it points at the wrong place confidently. It is the same anchoring that got the `PERSISTENCE_ERROR`
clause cut from `exploration`.

All five now describe behaviour — *a creating request sent twice produces two rows*, *the generated
client calls a nested collection route no controller serves* — which is what they were illustrating
in the first place.

The `bookmarks` domain in the skills is deliberately untouched: those are runnable code examples
teaching a pattern, where a concrete name is what makes the code readable and nothing implies the
endpoint exists in your repo.

## 0.22.0

**`observability` joins `fast_lenses`.** A fast sweep is nine hunters now rather than seven. It
belongs there for the same reason `exploration` does: both arrive with proof attached, so the prove
step that follows is nearly free. Where it has no log access it says so and stops — which costs one
hunter and not the sweep, and is the right outcome rather than a silent pass.

**`fast_lenses` is in the config template.** It was only ever a default in `config.js`, so it did
not appear in a project's own `.keel/config.yml` and could not be found, let alone tuned, by
reading the file you are meant to edit.

## 0.21.0

**A tenth lens: `observability`.** Nothing until now asked whether a failure leaves a trail. An
exception swallowed into a log nobody emits, a 500 recorded nowhere, a log line naming the symptom
but not the input, a request with no correlation id, an error logged below the level any alert
watches. It is the gap that compounds every other lens: a proven 5xx you cannot trace costs a week
instead of an hour.

The method is what keeps it honest. **Cause a failure you already understand, then ask what the
system recorded about it** — you are the oracle, because you did it. Expected is a record good
enough for someone who was not in the room to reconstruct the failure; Actual is what is there.

That framing is load-bearing, because the obvious version of this lens is a checklist, and a
checklist version would be worse than not having it. So: *"there is no log line here"* about a path
you did not make fail is explicitly not a candidate. An absence counts only when you caused the
failure that needed it.

**Load: nothing but the logs** — never a controller, and never the logging config either. Reading
the logging setup tells you what the code intends to record, and you would then confirm it intends
it: the same tautology `exploration` sidesteps.

On by default, both lanes, and **not** in `fast_lenses` — it needs log access and has to cause its
own failures first, and it is worth most against a backlog that already holds proven findings whose
logging it can check for free. The brief also says where it stops and `technical` and `security`
start: secrets found in a log are a `security` finding, not this one.

## 0.20.0

**Two new lenses: `exploration` and `messaging`.** Every lens until now reasoned from source.
These act: they drive the running system and report what it did, then hold that against what it
promised. A finding is a mismatch in three parts — Expected and its source, Actual as observed,
and the Action that produced it — which is an e2e test with its parts named: Expected is the
assertion, Action is the `repro_hint`, Actual is what fails today.

The load rule is the whole design. **The contract, and never implementation source.** A contract
is a promise written separately from the code that answers it, so behaviour can disagree with it.
Implementation source cannot: a hunter that reads a controller learns what the code intends and
then confirms it does what it intends, which is true by construction and finds nothing — and it
stops looking, reporting what it expected instead of what it saw.

`exploration` is on by default and in `fast_lenses`, where it earns its place by arriving with
proof attached: its candidates are already-reproduced commands, so the prove step that follows is
nearly free.

**`messaging` ships a brief but stays off.** Most projects have no broker, and a configured lens
with nothing to act on spends a hunter every sweep. It is a separate lens rather than a lane of
`exploration` because four things diverge: you act and observe in different places, "nothing
happened" needs an explicit settle bound, a finding is repeat-N-and-count rather than one pass, and
it uses disruption. It carries one precondition the HTTP lenses do not — a dedicated broker, never
a shared environment, because a committed offset does not roll back when the hunt ends.

Both briefs name where they stop and `behavioral` and `contract-drift` start, since all three can
reach the same bug from different directions.

## 0.19.0

**`keel commit` can carry a body.** The message was passed as `git commit -m ${JSON.stringify(...)}`
— quoting for JSON, not for a shell — so a real newline became a literal backslash-n and any
message with a body or a trailer arrived as one long subject line with `\n` printed in the middle
of it. It now goes through a file with `-F`, written to the temp directory so a crash between write
and unlink cannot dirty the tree. Found by writing a `Co-Authored-By:` trailer and reading it back.

**`keel --help` reports the real version.** It was hardcoded and said `0.13.0` across five
releases; it reads `plugin.json` now, because a version repeated in two places is only ever wrong
later.

## 0.18.0

**A single-lens run is documented as a mode.** `--lenses` already overrode the selection outright,
`--fast` included, so `keel hunt start --auto --lenses exploration --scope all` worked and nothing
said so. Named in step 0 now, for when the question is narrow enough to state rather than worth
sweeping wide and reading a long page to answer.

With one warning attached: **pass `--scope` explicitly.** `--fast` defaults scope to `diff`, which
is the wrong instrument for a lens that reads no source — a behavioural lens acts on endpoints, so
a diff scope narrows nothing and risks pointing a hunter at files its own brief forbids it to read.

Also: step 0 no longer states the default `fast_lenses` set as though it were fixed. It is config.

## 0.17.0

**A project can keep its own lens in `.keel/lenses/<name>.md`.** The hunt skill now looks there
first for every lens and falls back to `references/lenses.md`, so a project can override a stock
brief as well as add one of its own.

This closes a quiet failure. `references/lenses.md` lives under a version-pinned plugin path and is
replaced wholesale on upgrade, so a lens written into it vanished the next time keel updated — and
vanished silently, because the `hunt.lenses` line and the `lens_lanes` entry survive in the
project's config and only the prose goes. The lens stayed configured and lost its brief.

No CLI or flow change: lens names were already validated against config rather than a fixed list,
so this only ever needed saying in the right place.

## 0.16.0

**`keel commit setup` — an init now has a commit type.** Every rule in the table was built around
an acceptance criterion, and an init has none: `memory` was the closest fit and its path guard
refuses `docs/RUNNING.md` and `CLAUDE.md`, which an init also writes. So the output of an init
either sat unstaged or was committed by hand, around keel and around every guard that makes
`keel commit` worth using. It carries `.keel/`, `docs/RUNNING.md`, `docs/knowledge/`, `CLAUDE.md`
and `.gitignore`, refuses everything else, and commits as `chore(setup): <msg>`.

**The ID-less types accept a two-argument form.** `setup`, `memory`, `smoke` and `coverage` all
build a prefix that ignores the ID, but the parser demanded one anyway, so the only way through was
to invent a placeholder. `keel commit memory "<msg>"` now works; `keel commit memory init "<msg>"`
still does, so nothing that already runs has to change.

**A commit with no ID no longer trails a broken spec anchor.** The `Spec: <path>#<id>` line is
written only when there is an ID to anchor to — it used to emit `Spec: <path>#` on any commit
without one.

Init gained **step 7b**, which runs the commit, and says out loud that tool directories like
`.claude/` belong in `.gitignore` rather than in it.

## 0.15.0

Four fixes from a measured init run, all of them the skill working against itself rather than
anything being broken.

**`keel init --write` moved to step 3b, before the ladder.** `.keel/config.yml` is what the ladder
reads to learn the package manager and the Compose file, and it was being written at step 7 —
*after* the ladder had already run against defaults. So the first run failed on rung 1 with
`pnpm: command not found` and `compose.yml: no such file`, on a repo where step 1 had already
reported `npm` and `docker-compose.yml`. Step 7 no longer re-runs it: `--write` overwrites, and the
ladder records to `.keel/proven.json` merged beneath the config, so nothing is lost.

**Run the ladder once; do not walk the rungs by hand first.** With the config written, the ladder
has what it needs and records the command that worked for each rung — which is the artefact. Doing
the sequence manually and then running the ladder executed `npm install`, `compileKotlin`,
`./gradlew test` and the whole boot twice, and recorded nothing from the first pass. Three to four
minutes.

**Narrate while a rung runs, not instead of starting it.** Four minutes went to explaining what the
doctor had found in the window where `bootRun` should already have been going. Long rungs are where
the explaining belongs.

**One claim, one line — `keel memory check` is per-line.** `memory.js` tests each line for a
proof-required term and looks for `unverified:` or a proof citation *on that same line*, so a
soft-wrapped claim fails on its continuation even when marked correctly. Eighteen problems on a
first check were almost all this. Now in `keel:librarian`'s brief and repeated in init's spawn
instructions.

## 0.14.0

**The knowledge build runs alongside the ladder instead of behind it.** Nothing in it touches a
running service — `keel arch detect` reads paths and imports, the explorer walks the tree, the
librarians read source and cite `file:line` — so there was never a reason for static analysis to
queue behind ten rungs that prove the stack builds and boots. It was 8m48s of a measured 14-minute
init against a ladder of about five; overlapped, it becomes the critical path and init lands near
ten.

The old ordering was defended on fail-fast grounds: prove the repo compiles before spending the
expensive step. That argument does not survive contact with what a librarian actually produces. A
failing compile does not change the source they read, so `docs/knowledge/` is just as valid after a
rung-3 failure — the work is owed either way, not thrown away.

**The section gate moved to step 2**, asked with the two runtime questions rather than eight minutes
later. It gates the most expensive thing init does and depends on nothing but the repo, so asking it
up front is what lets the build start early — and the user answers every prompt in one sitting.

Named in step 4: `keel:setup-doctor` may rewrite a build file while librarians are writing, shifting
a line out from under a citation. It never edits application code, so source citations are safe, and
`keel memory check` resolves every one — a break surfaces as a failed check, not a silent lie.

## 0.13.0

**A human gate on the knowledge build.** `keel memory sections` prints the five sections and what
each is for; `--confirm a,b`, `--all` or `--none` records the answer, and `keel memory update`
refuses until it has one. Init spawns one `keel:librarian` per chosen section and no others — five
librarians was 62% of a measured 14-minute init, and nothing used to ask which of them you wanted.

**`keel memory check` is scoped to the selection**, which is what made the gate possible. *Missing*
now means chosen-but-absent; an unchosen section reads `not selected`, contributes no problems, and
does not block a push. A two-of-five knowledge base is legal.

Confirming again **adds**, so re-running `/keel:init` finishes a knowledge base over several
sittings: what exists is kept and is not rebuilt, and `--none` refuses while any section is on disk.
Selection decides what must exist, never what gets checked — a section present but unchosen is still
refused if its claims are unsourced.

Also: init's three agents moved to Opus 5 — `keel:explorer` low, `keel:setup-doctor` medium,
`keel:librarian` medium.

## 0.12.0

### Added

- **`keel hunt start` requires `--auto` or `--semi`.** A hunt had one real gate — the lens
  confirmation — and everything after it ran without asking. That is right for letting it run and
  wrong for watching it work, and there was no way to ask for the second. The refusal to start *is*
  the gate: nothing proceeds because no run exists. Deliberately not a `keel ask` blocking question,
  since those also block `ladder`, `init --write`, `memory update` and `preflight`, and how closely
  you supervise a hunt should not stop unrelated work.
- **`--semi` gates each phase**, each releasing exactly one thing: `hunt candidates` and `hunt prove`
  wait on `gate sweep`, `hunt report` on `gate prove`, `hunt next` on `gate report`.
  `hunt report --candidates` is never gated — it is what you read *in order to* decide the sweep
  gate, so gating it would deadlock.
- **`--auto` is the old behaviour, named**, and pre-approves all three gates as `by: model`, so the
  record has the same shape either way and the difference is who is named in it.
- **Both reports say what nobody checked.** In `--auto` the lens set is confirmed by the model, which
  is a self-answer; `lenses --confirm` takes `--by`, the run records `confirmed_by`, and the banner
  reads "everything reported was still proved; what no one checked is whether the right things were
  looked for". An unattributed self-answer is how "this is not a git repository" became a footnote.
- **`docs/BACKLOG.md`** — what is known to be missing, in four sections whose distinction is the
  point: a defect behaves wrongly today, a design is worked out and unwritten, a kept limit is a
  trade somebody chose, and an untested inference has not been run. Every entry names the file it
  came from.

### Unchanged on purpose

Neither mode touches the proof bar, and neither fixes anything. The output is a report and a
backlog; findings drain one at a time into `/keel:fix`, where the normal approval flow applies. That
is why `--auto` is safe to let run: the worst case is time spent and a thin report.

192 -> 196 simulation scenarios.

## 0.11.0

A lower gear for the two slowest flows, and the map that should have landed in 0.10.

### Added

- **`keel ladder --fast` keeps every rung.** "All the rungs, but do not break anything, and make it
  fast" is the right shape for this, so a fast run removes duplicated work rather than coverage. The
  rung list is byte-identical either way and a scenario asserts it.
  - The `dependencies` rung's default is `./gradlew -q help`, which proves the build tool starts —
    and `compile` then resolves the same graph and proves strictly more. The probe was paying a whole
    cold-daemon start for a subset of the next rung. Dropped under `--fast` **only** while it is that
    default; a project that pointed `commands.deps_api` at a real resolution task keeps it, because
    that one checks something `compile` does not.
  - `--fast` implies `--resume`, so nothing already proven on this machine is proven again.
  - The skipped probe reports as `not-checked` with its reason, and the runbook says it was a fast
    run — a fast ladder cannot read as a full one.
- **`keel hunt start --fast`** sweeps `hunt.fast_lenses` — security, technical, contract-drift — as
  five hunters rather than thirteen, against the diff, with half the candidate cap. Concurrency and
  idempotency are excluded precisely because they are the most expensive to *prove*.
- **`/keel:init --fast`** runs the fast ladder and defers the knowledge base **entirely**. That is
  mechanical, not stylistic: a half-written `docs/knowledge/` fails `keel memory check`, and a failing
  verdict blocks every push, while an absent one blocks nothing. The deferral is recorded through
  `keel ask` with `--by user` so it lands in the runbook rather than being silent.

### Unbroken

- **The five librarians each walked the whole tree.** The shared explorer map was planned in 0.10 and
  never implemented, and because the librarians run in parallel the cost was the slowest of five full
  reads instead of one read plus five focused ones — most of the knowledge build's eight minutes. One
  `keel:explorer` builds the map and every librarian receives it, which is what the hunt has always
  done for its hunters. Unconditional, not a fast-mode option: it removes reading, not checking.

### The rule fast mode does not bend

`--fast` narrows **what is looked at**, never **whether a finding is verified**. A fast hunt's report
still refuses to render while any candidate lacks a verdict, and both the report and the candidate
page carry a banner naming the lenses that never ran, ending "a short report is not a clean bill of
health". A hunt that reported unproven findings quickly would be the exact thing 0.8 was built to
prevent, and worse than no hunt at all, because it would read like one.

### Still not enforced

- **A fast init does not bring the stack up**, so a hunt started straight afterwards has nothing to
  prove against: `keel hunt start` records `api: down`, every prover returns `unproven`, and a page of
  `unproven` reads like "no bugs found". The skill says to run `keel stack up` first; nothing makes
  you.

189 -> 192 simulation scenarios.

## 0.10.0

0.9.0 went into the field and was watched working. What came back was a list of things a person
wanted from it, and underneath the first request was a defect that had been live since the flow
shipped.

### Unbroken

- **A second hunt overwrote the first hunt's proofs.** `repro/` and `incoming/` were shared across
  runs while finding ids restart at `F-001` every run, so run 2's `F-001.sh` landed exactly where
  run 1's proof had been. Every run now owns a directory named for the day and its number —
  `.keel/hunt/2026-09-20-01/` — and the sha moves out of the id into a field, because an id is for
  people and a sha is for freshness.
- **The committed report cited files the reader did not have.** It pointed at
  `.keel/hunt/repro/F-001.sh`, which is gitignored. `keel hunt report` copies each proven recipe in
  beside `report.md` and cites it relatively, so "proved by execution" is something the recipient can
  actually execute.
- **A severity was whatever the prover felt.** `hunt.severity_rubric` says what each level means, and
  the one clause a program can check is enforced: a proven finding whose own evidence or recipe shows
  a 5xx is refused below `high`, quoting the rubric row back.

### Added

- **Two lenses that were missing.** `concurrency` — read-modify-write with no lock or version,
  check-then-act, `max + 1` under a unique constraint, shared state on a request path.
  `idempotency` — a POST unsafe to retry, a missing idempotency key, a handler that is not
  replay-safe, a migration that breaks the second time. Neither is visible to one sequential request,
  so the prover is told to write a recipe that races and to run it twice; `keel:debugging` already
  carried `references/reproduce-race.md`.
- **The sweep splits by lane.** Each lens declares which side of the tree it reads; eight lenses
  become thirteen hunters, each given half. `contract-drift` is `both` and never split — its subject
  is the disagreement *between* client and server, so each half of a split would see one side of the
  thing it exists to find.
- **Scope forced at the ingest.** `keel hunt add --lane api` classifies every cited path through the
  same `guards.classify` the write guard uses and refuses a batch containing a file from the other
  lane. This is where it had to go: `PreToolUse` sees only `tool_name` and `tool_input`, and the
  subagent payload carries no instance id — so no hook can bind *this* hunter to *these* paths. The
  `SubagentStart` brief states the rule; the ingest holds anyone to it.
- **Duplicates merge instead of re-filing.** A candidate landing on the same file within ten lines of
  an existing finding appends to `also_found_by`. Thirteen hunters find the same defect repeatedly,
  and two lenses agreeing is worth more than two entries.
- **A candidate report** — `docs/hunts/<run>/candidates.md`, stamped UNVERIFIED throughout, which
  renders *while* candidates exist: the one thing the real report refuses to do. It is the page to
  read when deciding what is worth proving, and it says how much of the sweep it covers.
- **One fixed block per finding** — Where, What, Impact, Proof, Evidence, Severity, Also by — in both
  reports, so eight findings are scanned as columns rather than read as eight paragraphs.
- **Findings no end-to-end spec covers are flagged** and raise the blocking `e2e-cover` question;
  `keel hunt next` then makes phase 4 of the fix flow mandatory for them. The hunt still writes no
  test — `keel:e2e-author` does, in the flow where writing one is legal and where the recipe, not the
  theory, is what it works from.
- **`keel hunt resume`** — which lens/lane pairs are still owed, how many candidates have no verdict,
  whether the report is rendered and committed, and the one next command.

### Still not enforced

- **A hook cannot bind a subagent to a path subset.** Stated plainly because the alternative is a
  scope rule that only sometimes fires. Scope is enforced where keel enforces everything: the write.
- **Coverage detection answers "no spec references this"**, not "this is untested". It matches an id
  or a source basename, and a spec that exercises the path without naming it reads as uncovered.
- **The severity rubric is judged by a model** apart from the 5xx clause. keel cannot weigh impact.

186 -> 189 simulation scenarios.

## 0.9.0

A field report on `/keel:init`. It reported ten green rungs and a healthy project, then wrote a
knowledge base recording `@Valid @Min(0) @Max(100)` on a `@RequestParam` as the house pagination
pattern — on a controller with no `@Validated` on the class, so Spring ignored the annotation
entirely. The annotation really was on that line. It had never worked, and it was written down as a
pattern for every future agent to copy.

The same run had no git repository. keel noticed, recorded it in three places, and carried on.

Neither of those is a lapse of attention. There was nothing in keel that could turn a fact into a
question, and nothing that could check a claim.

### Added

- **`keel ask`** — a question keel will not proceed past. `keel ask <id> --question "…" --blocking`
  raises one; unanswered, it refuses `keel ladder`, `keel init --write`, `keel memory update` and
  `keel preflight`, each naming the question, its consequences and the command that clears it.
  **keel cannot verify that a human answered** — every approval in the system is a token the model
  can write itself, and this is no different. What it buys is that the question becomes a recorded
  artifact with consequences rather than a footnote. `--by` defaults to `model` and the output says
  "recorded as a self-answer", so skipping a question is visible in the artifact instead of
  invisible in a transcript.
- **`keel memory check`** — resolves every `path:line` citation in `docs/knowledge/` and refuses a
  path that is missing or a line past the end of a file; refuses a section with no citations at all;
  refuses a template placeholder nobody replaced; and refuses a line mentioning
  `memory.proof_required_terms` unless it cites a test or a `.keel/hunt/repro/` recipe, or carries
  the prefix `unverified:`. A citation proves the code *says* something; only a test proves it
  *does*. That is the distinction the field case turned on.
- **`agents/librarian.md`** (sonnet, high effort) writes one knowledge section with a citation
  behind every claim; the skill sends five in parallel. One reader trying to hold a whole codebase
  is how a guess became a rule.
- **A `git` rung**, first in the ladder, raising the blocking `git-repo` question when there is none.
- **`keel models --effort`.** Effort was write-once frontmatter: no command read it, no default
  declared it, no scenario checked it. `show` reports `model/effort`, `set`/`set-all` take
  `--effort`, `reset` restores both, and a scenario asserts every agent declares a literal one.
- **`keel hunt candidates [--batch]`**, which makes `hunt.prove_concurrency` a limit the CLI applies
  rather than a number the skill asked the model to respect. It shipped in 0.8 read by nothing.

### Unbroken — the ladder claimed more than it checked

- **Ten rungs were probably seven.** `optional: !c.<command>` marked a rung optional exactly when it
  had no command, and the list was then filtered to rungs that had one — so `testcontainers`,
  `api-boot`, `web-boot` and `smoke` were deleted from the run *and* from the runbook. A seven-row
  table and a twelve-row table were indistinguishable. Every rung stays now, and an unconfigured one
  is a `not-checked` row naming the config key that is missing.
- **The one rung that can see correctness passed on a repository with no tests.** A suite that finds
  nothing exits 0. keel already carried the phrases — `loops.red_reject` contains `'no tests found'`,
  which the RED loop consults and the ladder never did.
- **Lockfile drift passed as a pass.** `frozen-install || loose-install` on one shell line exits 0
  when the lockfile is stale. The two runs are separate, and the fallback is `needs-you`.
- **"Dependencies resolve" ran `./gradlew -q help`**, which proves the build tool starts. It is
  labelled for what it does unless `commands.deps_api` points somewhere stronger.
- **The runbook asserted a verification it had not performed** — "Verified by keel on <date> at
  commit <sha>" under a "Verified steps" heading, written precisely when the ladder did not stop,
  with no row for anything unchecked. It says "Checked by keel", counts what ran against what
  exists, lists every not-checked rung with its reason, and carries a fixed **"What this does not
  tell you"** pointing at `/keel:hunt`.
- **Three config keys were declared and read by nothing.** `setup.ladder` now selects which rungs
  run and reports the excluded ones; `fix_attempts_per_rung` turns a rung that keeps failing into a
  blocking question; `max_parallel` had been read by `setup.js` since 0.6 while being declared in no
  defaults, so it was effectively hardcoded. All three are in the config template now.

### Unbroken — git

- **`preflight` blamed a dirty tree for a missing repository.** `git()` folds stderr into `out`, so
  `status --porcelain` returned "fatal: not a git repository…" — truthy, one line — and preflight
  reported "the tree is not clean (1 file(s))". It asks `hasGit` first now and reads through
  `gitOut`. Three sites that stored that fatal string as a branch name record `null`.
- **`verify fast` passed vacuously in the words of a real pass.** `changedFiles()` is empty outside a
  repository for want of git, not because nothing changed. It now says nothing was compared. The
  comment above `hasGit` has made this exact point since it was written and nothing acted on it.

### Unbroken — the knowledge base

- **`keel memory update` regenerated nothing.** It scaffolded only when the directory was absent,
  checked that each file existed, and wrote a timestamp. `write()` skips existing files, so
  "Regenerates the affected sections" was aspirational on any real repository.
- **It then re-stamped an unread knowledge base as `current`**, because freshness was
  `verdict.sha === HEAD` and nothing else. The verdict carries a content hash now.
- **Template placeholders were never substituted.** The knowledge scaffold is a raw byte copy —
  alone among the template paths in `setup.js`, which all substitute — so `{{ARCH_STYLE}}`,
  `{{COMMIT}}` and `{{TESTING_SKILL}}` landed in the files literally and stayed.
- **`keel pr` was not refused on a stale verdict**, though `skills/memory/SKILL.md` had said so
  since 0.6; `gates.pushBlockers` read coverage and security only.
- `.keel/setup.json` was written by keel, tracked nowhere and ignored nowhere, so it dirtied
  `git status` and `preflight` refused — the defect 0.8 fixed for `security.json` and missed here,
  though `references/runbook.md` already documented the file as uncommitted.
- Three skills claimed the `SubagentStop` hook **blocks** a missing result line. It deliberately does
  not: 0.7.0 made it advice because a reply containing only the marker replaces the agent's result.

### Still not enforced

- **keel cannot tell whether a knowledge-base claim is true.** It refuses the claims that are not
  checkable — a dangling citation, an unfilled placeholder, an unsourced section, an unproven rule
  about validation or transactions. A well-cited, well-proven, wrong sentence will pass.
- **Nothing proves a human answered a question.** See `keel ask` above; the honest version of that
  is attribution, not verification.
- **The ladder still checks liveness only, by design.** Behaviour is `/keel:hunt`'s job, and 0.9's
  contribution is that init says so instead of implying otherwise.

### Found by the dry run, not by a scenario

Both of these came out of running 0.9 against a real repository before tagging it, which is the
same way 0.7's thirteen issues were found.

- **`preflight` read `not-checked` as a failure.** Renaming the `skipped` verdict to `not-checked`
  left preflight's allowlist naming the old one, so every unconfigured rung reported as "run ladder
  rungs still failing" and no flow could start.
- **The ladder did not repair the ignore block**, so `.keel/setup.json` — which the ladder itself
  writes — still dirtied the tree. `ensureGitignore` was called by `init --write` and `keel hunt
  start` and not by the command that creates the file.

A file that is already *tracked* stays tracked: gitignore does not apply retroactively, so a repo
that committed `.keel/setup.json` under an earlier version still needs one `git rm --cached`. keel
does not do that silently.

158 -> 178 simulation scenarios.

## 0.8.0

0.7.0 was the answer to a field report: `/keel:init` plus a **manual** bug hunt on a
Kotlin/Spring + React repo. That hunt found twenty-five bugs and drove thirteen fixes, and it
was run entirely by hand — review agents dispatched ad hoc, findings proven one at a time with
`curl` and live SQL, the inventory living in a chat message that did not survive the session.
Nothing in keel knew how to do it again.

`/keel:hunt` is that hunt as a flow. It is read-only from end to end: its output is a backlog
and a report, and every fix happens in a flow started from it.

### Added — the hunt

- **Five phases and a closed flow.** `hunt-scope`, `hunt-sweep`, `hunt-prove`, `hunt-report`,
  `hunt-triage`, all with the read-only guard row `bug-investigate` already used. No hunt phase
  is reachable from a non-hunt phase and none leads anywhere but `none` or another hunt phase:
  the handoff into `/keel:fix` is `keel state start fix`, which resets state wholesale, and
  that reset is exactly why the backlog is a file of its own rather than a field in state.
- **Two stages, because reading code produces plausible prose.** A `keel:hunter` per lens
  proposes candidates; a `keel:prover` then has to reproduce each one against the running
  stack. A lens-supplied severity is dropped on ingest, loudly — a severity is a measurement,
  and at that point nothing has measured anything.
- **A proven verdict needs a recipe file, not an evidence paragraph.** `--repro` must exist, be
  non-empty and live under `.keel/hunt/repro/`. That file, not a summary a model re-renders, is
  what travels into `keel:reproducer`. `unproven` is kept as *suspected* with no severity: a
  verifier looked and failed, which is neither a confirmed bug nor a dismissed one.
- **The report refuses to render while any finding is still a candidate.** Determinism makes a
  report reproducible, not true. Every line is derived from the backlog and the only timestamp
  printed is the run's own, so a second render of an unchanged backlog is byte-identical — a
  scenario compares bytes, because otherwise "deterministic" is a claim a `Date.now()` in the
  header would satisfy.
- **One cause, many symptoms.** Grouping happens at the report, never at ingest: a lens agent
  cannot see the other lenses' findings, so it cannot know it is looking at a symptom. `keel
  hunt next` hands over the group as one unit, the lead's recipe as the reproduction and the
  symptoms as regression criteria. On the manual hunt, one defect surfaced as four separate
  findings; dispatched separately they would have been four conflicting fixes to one line.
- **The lens set is confirmed by the user before anything fans out**, enforced three ways
  rather than asked for in prose: `confirmed` is null until it is set, `hunt add` refuses while
  it is, and the only command that writes it is the one that opens the sweep. A model that fans
  out early gets six result sets it cannot ingest.
- `keel hunt start|lenses|add|prove|group|report|next|close|list|status`, `agents/hunter.md`
  and `agents/prover.md`, `/keel:hunt` and `/keel:hunt-next`, six lens briefs, and a `hunt:`
  config block in both the defaults and the template — a seventh lens is a config line and a
  brief, not a code change.

### Unbroken — what a fifth flow would have inherited

Each of these was found while building on top of it, and each was silent.

- **Three agents declared a result line that no hook ever asked for.** The contract lived in
  two objects that had to agree — a label table for the brief, an inline regex map inside
  `subagentStop` — with nothing asserting they did. `keel:security-auditor`,
  `keel:dependency-triager` and `keel:reproducer` were in the first and missing from the
  second, so `SECURITY:`, `DEPS:` and `REPRO:` were unenforced. There is one `CONTRACTS` table
  now, and a scenario checks it against the agent files. `keel:reproducer` is the agent a hunt
  hands off to, so this one was load-bearing before it was tidy.
- **`state start` sent every flow it did not name to the spec phase.** The ternary chain ended
  `: 'spec'`, so a typo — or a flow registered in `PHASES` and nowhere else — started in a
  phase whose guard row allows writing specs and whose rail renders as a feature. It is a
  `FLOW_START` table now, an unknown flow is refused by name, and `--phase` is validated, which
  it was not.
- **The step checklist answered an unregistered flow with the setup ladder**, confidently and
  about the wrong thing, because `RAILS[flow] || []` fell through to the init ladder. It now
  falls through only when there is no flow at all. A wrong checklist is worse than none.
- **Verdict files keel writes itself could block the branch forever.** The ignore list was a
  literal seven-element array, so `.keel/security.json` and `.keel/architecture.json` — both
  written by keel, neither tracked nor ignored — sat in `git status --porcelain`, and
  `keel preflight` refuses a tree that is not clean. Reproduced in the field: a repo that had
  run `keel verify deps` once could not start another flow. The list is now
  `util.PER_MACHINE_IGNORES` with an idempotent repair that `keel hunt start` calls, because
  `init --write` cannot be re-run to pick up new entries.
- **`gates.bug_gates` was read by nothing and `--no-gates` was parsed nowhere**, though both
  were documented in two skills as recording an automatic approval. What a bare `keel gate R`
  actually did was worse than failing: it recorded the empty string as a decision and moved the
  phase backwards. Both work now, the waiver is reported in the PR body through the path that
  already existed for a skipped AC gate, and a gate with no decision is a usage error.

### Still not enforced

Said plainly, in the shape of the README's own known-gaps paragraph.

- **Nothing stops a prover writing to a real database.** `checkBash` has no view of what
  `DATABASE_URL` points at, so a prover proving a data bug can write to whatever is configured.
  The mitigations are a line in the agent brief and the stack recorded in the run file, and
  neither is enforcement. Point a hunt at a disposable stack.
- **The simulator proves the wiring and the refusals, not the judgement.** It cannot show that
  six lenses find real bugs, or that a `proven` verdict is trustworthy. The refusals are the
  deterministic part — no severity without a verdict, no proof without a recipe, no report with
  an unexamined finding in it — and those are the parts that hold every time.
- **`keel init --write` still overwrites a hand-edited `.keel/config.yml`.** That is why the
  ignore-block repair lives in `keel hunt start` rather than in advice to re-run init. Fixing
  it needs a decision about what merging a commented YAML file means, and that is its own
  change.

137 -> 158 simulation scenarios.

## 0.7.0

Thirteen issues from a field report: `/keel:init` plus a full bug-hunt on a Kotlin/Spring +
React repo that is single-module at the root and has no git history. The ladder passed 12/12
there, so none of these were setup failures — they were defects in what keel reports,
generates and enforces. Every one reproduced before it was fixed.

### Unbroken — these cost work

- **A compliant subagent could be blocked forever, and lose its report doing it.**
  `lastAssistant()` returned on the first assistant entry it met even when that entry yielded
  no text — a tool-use turn maps to `''` — so it never scanned back to the turn holding the
  result line. (0.6.1 fixed the layer above this, joining `last_message` with the transcript;
  the defect was one level down.) It now keeps scanning until a turn actually has text.
- **Enforcing the result line destroyed the findings it protected.** The contract was a hard
  `decision: block` saying "Add it and finish", which an agent satisfies most cheaply by
  replying with the marker alone — and that reply *replaces* its result. A reviewer's entire
  findings list became the single line `BLOCKING: yes`. The contract is now advice, and asks
  for the findings back alongside the marker.
- **`keel doctor` could not see the failure that killed every agent.** An agent whose `model:`
  still holds `${user_config.…}` fails with `model_not_found` (HTTP 404) naming the
  placeholder, which points nowhere near the cause — and a cached install of an older version
  shadows the one keel is running from, so the symptom outlives the fix. `doctor` now reports
  both, with the remedy.

### Unbroken — output that looked right and was not

- **`verify arch` printed `architecture boundaries hold.` having inspected nothing.**
  `changedFiles()` never checked exit codes, and `git()` folds stderr into its output, so
  outside a repository `fatal: not a git repository…` was treated as a filename and then
  dropped for having no source extension. Zero files were checked and it read exactly like a
  real pass. It now reports the denominator, and says when the answer is zero.
- **Boundary rules were templated from the style name and never checked against the tree.**
  A rule could deny an import the codebase already depends on, or scope itself to a package
  that merely shares a layer's name. `arch set` now dry-runs the rules it is about to write,
  reports the existing violations per rule, and leaves `enforce` off rather than shipping a
  rule the code violates on day one.
- **Generated config asserted what discovery never proved** — a Kover task for a JaCoCo
  project, vitest and Playwright commands with neither installed, `:5173` for a Next app.
  `doctor` then counted them as set, so the failure surfaced at run time instead of at init.
  Discovery now reads the build file and `package.json`, and anything it cannot prove is left
  blank with its suggestion in a comment. Stack packs are gated on their own `detect:` block,
  which they never were — every pack applied to every repo.
- **A shell error was written verbatim into generated artifacts**, e.g. `docs/RUNNING.md`
  reading `at commit fatal: not a git repository…`. A new `gitOut()` returns a fallback unless
  the command succeeded; nine sites now use it.

### Unbroken — friction

- **A backend at the repository root was never found.** Detection probed only `apps/api` and
  friends, so init printed the self-contradictory `backend: not found   build: ./gradlew` and
  then wrote `apps/api` into the config. Root-level single-module projects are detected, and
  `.` is normalised through one `moduleDir()` helper — previously it would have silently
  skipped its own compile and typecheck while reporting a clean `verify fast`.
- **`keel ladder --help` ran the ladder**, starting Docker services and booting both apps.
  `--help` was matched only in first position. Every subcommand answers it now.
- **The knowledge base could not be created.** `memory show` sent you to `memory update`,
  which sent you back to `/keel:init`; nothing ever copied `templates/knowledge/`. `update`
  now scaffolds it.
- **An explicitly blank coverage path was silently overridden.** `deriveReports()` tested
  truthiness, so `''` — the way a project says "there is no coverage here" — was treated as
  unset, undoing what `deepMerge` had deliberately preserved.
- **The Playwright and smoke templates were copied raw**, carrying another project's pnpm
  workspace, `apps/api`, `:5173` and actuator path into every repo. They are now filled from
  the config init just wrote.
- **Nothing said which directory a command runs in.** `api_*` run from `backend.dir`, `web_*`
  from `frontend.dir`, `e2e` from `e2e.dir`, and the cross-cutting ones from the repo root.
  Documented per key; `e2e` now runs where `scaffold playwright` writes its config, rather
  than at the root where it could not find it; and a missing module directory is reported
  instead of silently becoming the repo root.

## 0.6.4

### Unbroken

- **`keel ladder --plan` destroyed the ladder's memory.** A plan run marks every rung
  `planned` and then persisted that over the recorded verdicts, so a dry run that changed
  nothing made `--resume` lose its cache and re-run everything, and left the new setup
  checklist reading 0/n on a project whose ladder was fully green. A plan proves nothing, so
  it no longer writes `setup.json` or the proven-commands file.

## 0.6.3

### Unbroken

- **The step checklist was invisible during setup.** It only rendered inside an active flow,
  so `keel:init` worked through a dozen ladder rungs showing no progress at all — the one
  place a newcomer most needs to see where they are. `todos.build` now falls back to a setup
  rail read from `.keel/setup.json`, so a passed rung is ticked, a failed one is the step in
  progress, and the rest are pending. Nothing new is tracked: the ladder already recorded
  every verdict.
- **The checklist ordered the model to use a tool it may not have.** The injected line was
  "Mirror this into your todo list", but a hook cannot call the todo tool and some sessions
  have no todo tool at all — leaving an instruction that cannot be followed. The rendered
  list now stands on its own and mirroring is offered rather than commanded.

## 0.6.2

### Unbroken

- **None of the 13 subagents could run.** Every agent declared
  `model: ${user_config.model_<name>}`, which is only interpolated once the user has written
  `pluginConfigs.keel` into `settings.json`. The `default` in `plugin.json` is not used as a
  fallback, so on any fresh install the literal placeholder was sent to the API and every
  agent failed with `model_not_found` (HTTP 404) on first use — including the
  `keel:setup-doctor` delegation that `keel:init` itself prescribes. Each agent now names its
  model literally, `keel models show|set|set-all|reset` reads and rewrites those frontmatter
  lines instead of a settings file that never resolved, and a scenario fails the build if a
  placeholder ever returns. `KEEL_AGENT_DIR` overrides the directory so the scenarios rewrite
  a throwaway copy.
- **`plugin.json` no longer declares `userConfig`.** With the model in frontmatter those
  thirteen entries controlled nothing, and leaving them would have shown settings in
  `/config` that silently did nothing.

## 0.6.1

Three bugs found the first time keel was run against a real Kotlin/Spring Boot + Next.js
project rather than the simulator.

### Unbroken

- **A blocked subagent could never unblock itself.** `subagent-stop` read
  `last_message || transcript`, so when `last_message` was a tool-use turn or a truncated
  value it short-circuited there and never looked at the transcript holding the contract
  line. The agent wrote `DIAGNOSIS: fixable` on every turn, was blocked on every turn, and
  gave up after burning its budget. It reads both sources now. The block message made it
  worse: it ran the regex through a lossy replace and demanded
  `DIAGNOSIS:s*(fixable|needs-you|unknown)i`, a pattern that cannot match anything, so the
  agent kept reformatting a line that was already correct. It quotes the real contract now.
- **`keel models` knew 8 of the 13 agents.** `lane-runner`, `arch-surveyor`,
  `security-auditor`, `dependency-triager` and `reproducer` were absent from
  `AGENT_SETTINGS`, so `show` never listed them and `set-all` never touched them. The table
  must stay in step with `userConfig` in `plugin.json`; a comment now says so.
- **The coverage push gate could not be satisfied on the base branch.** Coverage is measured
  on lines changed against `base_branch`, so on `main` itself the diff is empty, every app is
  skipped, and the empty result set was reported as `no coverage reports configured` — blaming
  a configuration that was correct. Nothing changed means nothing can regress: the verdict now
  passes and says so, and the "not configured" problem is reported only when it is true.
- **The container-backed test queued behind the unit suite.** Both are the same build tool
  in the same project directory, so sharing level 3 meant blocking on the build tool's
  project lock — parallel in name only, and running a test the unit suite had just run.
  Moved to level 4.

### Still broken

- **Every agent's `model:` is `${user_config.model_*}`, which does not resolve** unless the
  user has written `pluginConfigs.keel` into `settings.json`. The `default` in
  `plugin.json` is not used as a fallback, so the literal placeholder reaches the API and
  returns `model_not_found` (HTTP 404). On a fresh install every keel subagent fails on
  first use, including the `keel:setup-doctor` delegation that `keel:init` prescribes.
  Workaround: `keel models set-all sonnet --yes`, then `/reload-plugins`.

## 0.6.0

The release that connects what 0.1–0.3 built. An audit found the mechanisms were largely
there and largely unwired.

### Unbroken

- **Coverage could never run.** `coverage.reports` existed in no config, so `verify coverage`
  always returned "no coverage reports configured" while the push gate waited for a verdict
  that could not be produced. A fresh project could never push.
- **`verify full` reported success having run no static checks.** A family of `commands.*`
  keys were read by code and defined nowhere, and unconfigured commands were dropped
  silently. Steps now declare whether they are required: a missing required command fails its
  tier, a missing optional one is reported as skipped.
- **The state machine accepted any phase from any phase**, so `spec` could jump straight to
  `green` and skip RED entirely. It has a transition graph now, and `--force` is recorded.
- **Unknown phases failed open** in the guard matrix — allow-all — so adding a phase and
  forgetting its row disabled every edit guard for it. They fail closed.
- **The workflow gates fired in every repo**, including ones with no `.keel/config.yml` that
  had never adopted the workflow. They now require `cfg.configured`; the harm-prevention
  guards stay unconditional.
- Zero of ~20 `references/` files existed while the skills instructed the model to read them.
- `keel lane start|merge` and `lane-runner` worked and no skill called either.
- `.env.local` was blocked by keel's own guard, so setup could not write the file it is
  specified to write.
- Per-lane ports were string-concatenated, so offset 100 asked Docker for port `1005432`.
- The secret-printing guard matched the filename anywhere after a `cat`, refusing any heredoc
  whose body mentioned one.
- `claude plugin validate --strict` rejected all 13 `userConfig` settings, so the plugin could
  never have installed from its own marketplace.

### Added

- **Architecture awareness.** `keel arch detect` scores weighted evidence — declared
  dependencies, package shape, domain purity, annotation placement — and records a hybrid
  rather than collapsing it. `keel verify arch` checks import boundaries inside `verify fast`.
- **Per-phase, per-layer skills.** RED on `[API]` loads Kotlin/Spring patterns, on `[WEB]`
  frontend ones. Stacks are data files in `stacks/`, so another stack is one file plus one
  testing skill.
- **A security phase** with two pipelines: code and logic against the spec's own
  authorization rules, and supply chain via `keel verify deps`. Plus a secret scan at the
  edit and a dependency gate at the push.
- **A fix pipeline** with `keel:reproducer` and seven reproduction techniques, and
  `/keel:diagnose` for a bug you cannot yet reproduce.
- **`/keel:cover`**, the coverage loop: group the uncovered lines, decide test, delete or
  accept for each, and review every test for assertions that mean something.
- **A project knowledge base** under `docs/knowledge/`, read back selectively by
  `/keel:memory`.
- **ASCII drawings in the spec** — a four-state UI mockup and a marked request path, drawn
  before the criteria list is final, because the states you draw are the criteria you would
  otherwise miss.
- **`keel board`**, showing the phase rail, the criteria, the keel agents in flight and what
  is blocking a push.
- **A step checklist driven by a hook**, so the flow's steps reach Claude Code's own todo view
  after every transition.
- **A concurrent run ladder.** Independent rungs share a level, so the Docker pull overlaps
  Gradle and npm instead of queueing behind them. A failing level finishes and reports every
  failure in it.
- **A dev container composed from the stack packs**, with a `devcontainer.json` pointer so
  editors recognise it. The old template hardcoded a Java image for every project.
- `keel preflight`, `keel state close`, phase 10, a frontend implementation skill, an MVC
  architecture reference, and the reviewer's architecture and assertions lenses.

### Known gaps

Nothing here has run against real Gradle, Vitest, Docker or `gh`. The 128 simulator scenarios
drive the real hooks and CLI against fake build tools, which proves the wiring and not the
commands — `koverXmlReport` and `vitest run --coverage` remain sensible defaults rather than
executed ones. The run ladder's optional rungs still need per-project commands, and the
security auditor is a strong reviewer rather than a proof: the deterministic parts (the secret
scan, the dependency gate, the 100% bar on auth paths) are the parts that hold every time.

## 0.3.1

Enforcement: hooks, the phase matrix, guarded commits, the coverage engine, the stall ladder,
the run ladder, nine subagents, and 86 simulator scenarios.
