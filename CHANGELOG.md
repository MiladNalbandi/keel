# Changelog

Design §22 lists this file and it never existed — which is why the version sat at `0.4.0`
across nine commits and four whole stages, until the only way to tell one build from another
was to grep the source for a function name.

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
