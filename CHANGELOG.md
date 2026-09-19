# Changelog

Design §22 lists this file and it never existed — which is why the version sat at `0.4.0`
across nine commits and four whole stages, until the only way to tell one build from another
was to grep the source for a function name.

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
