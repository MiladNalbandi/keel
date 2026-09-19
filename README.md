# keel 0.6.0

An enforced spec-and-acceptance-criteria workflow for a Kotlin + Spring Boot backend with a TypeScript frontend, as a Claude Code plugin. Hooks and a small CLI enforce the loop instead of asking the model to remember it.

## What it enforces

- **RED then GREEN, one acceptance criterion at a time.** Production code is blocked while you write the failing test; test files are frozen while you make it pass.
- **Commit composition.** A `test(AC-003)` commit may not contain production code, and `feat(AC-003)` may not contain tests.
- **Real red tests.** A failure from a compile error, a Spring context failure or Docker is refused as a setup problem, not accepted as a red test.
- **No disabled tests.** Adding `@Disabled`, `.skip(`, `.only(`, `xit(` or `assumeTrue(false)` is rejected at the edit.
- **Secrets stay out.** Reading or printing `.env` is blocked; `keel env` shows variable names and whether they are set.
- **No push without a coverage verdict** for the current commit.
- **Stall detection.** The same failure three times in a row stops the loop instead of burning turns.
- **Gates you control.** The acceptance-criteria gate can be skipped per lane or per flow; spec approval and the final review before the PR cannot.
- **Phase order.** `keel state phase` refuses an illegal transition and names the legal ones, so `spec` cannot jump straight to `green` and skip RED. `--force` is allowed and recorded.
- **Lane scope.** In RED and GREEN an `[API]` criterion cannot edit frontend code, and vice versa.
- **No unconfigured checks passing quietly.** A required command that is not set fails its tier and says so; an optional one is reported as skipped. `keel doctor` lists every command key and which tiers need it.
- **Secrets never reach a commit.** A hardcoded credential is blocked at the *edit*, because removing one from history is a much worse conversation.
- **Architecture, once you have chosen one.** Import boundaries are checked on changed files inside `verify fast`, and an architecture reviewer lens runs at ship.
- **No push with a known vulnerable dependency**, when a manifest or lockfile changed on the branch.

## Beyond enforcement

- **`keel arch detect`** works out whether a repo is hexagonal, DDD, layered, MVC or feature-sliced from weighted evidence — declared dependencies, package shape, and measurements like domain purity — and records a hybrid rather than collapsing it. For a greenfield project it recommends one, defaulting to layered and arguing against DDD unless the case is real.
- **Per-phase, per-layer skills.** RED on an `[API]` criterion loads Kotlin/Spring test patterns; on a `[WEB]` one, frontend patterns. Stacks are data files in `stacks/`, so another stack is one file plus one testing skill.
- **A project knowledge base** under `docs/knowledge/`, built at init and read back with `/keel:memory` one section at a time.
- **`/keel:cover`** turns "coverage is low" into a loop with a decision per uncovered group — test it, delete it as unreachable, or accept it with a recorded reason — and reviews each test for assertions that mean something.
- **`/keel:diagnose`** is the read-only entry point for a bug you cannot yet reproduce, which the bug flow alone has no room for.

## Install

This repo is its own marketplace (`.claude-plugin/marketplace.json`), so there are three ways in.

**1. Local, for trying it out (loads in place, so your edits apply):**

```
/plugin marketplace add /absolute/path/to/keel-pkg
/plugin install keel@keel-marketplace
/reload-plugins
```

**2. From GitHub, once you push this repo:**

```
/plugin marketplace add MiladNalbandi/keel
/plugin install keel@keel-marketplace
```

**3. One session only, no install:**

```bash
claude --plugin-dir /absolute/path/to/keel-pkg
```

Check it loaded: `/plugin` lists keel, and `/keel:status` answers. Then, in your project:

```
/keel:init
```

## Try it without a project

The plugin ships a simulator that builds a throwaway repo with fake build tools and drives the real hooks and CLI through 128 scenarios:

```bash
node bin/keel simulate            # run every scenario (128)
node bin/keel simulate RED:       # only the RED-phase scenarios
node bin/keel simulate --sandbox  # keep a sandbox repo and print how to poke at it
node bin/keel doctor --hooks      # the always-on guard rules only
```

## Commands

```
keel init [--write]                  detect the layout, write .keel/config.yml
keel preflight <slug>                prove the machine is ready, then create the branch
keel discover                        what the repo says about how it runs
keel ladder [--plan|--resume]        prove every run step, write docs/RUNNING.md
keel scaffold <what>                 compose, dev-container, playwright, smoke, spec, claude-md
keel stack up|down|status|logs|migrate|reset [--lane web]
keel lane start|status|merge <name> [--background]
keel arch detect|show|set <style>    architecture style and its import boundaries
keel skills for <phase> [--layer]    which skills and references this phase wants
keel memory show|reload|update       the project knowledge base
keel cover [decide <key> <verdict>]  the coverage-fix loop
keel smoke | keel pr [--dry-run] | keel triage "<desc>" | keel check-size
keel stall [reset] | keel models show|set-all <model> [--yes]
keel state start|phase|advance|ac|lane|board|show
keel state red-done|green-done|repro-done    guarded transitions
keel state close                     archive a finished flow
keel gate <ac|R|F|final> <decision>  record a human gate
keel escalate [--override "why"]     small change -> spec flow
keel verify fast|ac|arch|deps|module|contract|full|e2e|release|coverage
keel commit <type> <ID> "<msg>"      commit with phase rules enforced
keel trace [--strict] | keel audit   AC traceability and commit audit
keel board [--watch] | keel status   tasks, agents in flight, what blocks a push
keel todos [--json]                  the flow's steps as a checklist
keel spec check|show [--path]         spec gaps, and its ASCII drawings
keel env | keel doctor
keel simulate [name] [--sandbox]
```

## Skills

Flows: `/keel:init`, `/keel:change`, `/keel:feature`, `/keel:fix`, `/keel:diagnose`, `/keel:cover`, `/keel:ship`, `/keel:status`, `/keel:memory`.

Loaded on demand, one reference at a time: spec authoring, Kotlin/Spring testing, frontend testing, Playwright, architecture, frontend implementation, security, debugging.

## Subagents

`keel:reviewer`, `keel:explorer`, `keel:investigator`, `keel:e2e-author`, `keel:implementer`, `keel:test-author`, `keel:reproducer`, `keel:lane-runner`, `keel:setup-doctor`, `keel:bulk-reader`, `keel:arch-surveyor`, `keel:security-auditor`, `keel:dependency-triager`. Each model is a plugin setting, so you can put them all on Opus from `/config`.

## Status

v0.1–0.3 built the enforcement layer: the hooks, the phase matrix, guarded commits, the coverage engine, the stall ladder, the run ladder, the subagents and 86 simulation scenarios.

**v0.6 connects it.** An audit found the mechanisms were built but not wired: `coverage.reports` existed in no config, so coverage could never run and the push gate blocked forever; a family of `commands.*` keys was read by code and defined nowhere, so `verify full` reported success having never run detekt, ktlint or ESLint; none of the ~20 `references/` files the skills pointed at existed; the lane commands and `lane-runner` were orphaned; and the state machine was a flat list, so any phase followed any other.

On top of that it adds architecture detection with enforced import boundaries, per-phase and per-layer skill resolution behind stack data files, a project knowledge base, a security phase with a code-and-logic pipeline and a supply-chain one, a reproducer agent and a read-only diagnose flow, the coverage-fix loop, ASCII mockups and request paths in the spec, `keel board`, a hook-driven step checklist, a concurrent run ladder, and a dev container composed from the stack packs. **128 simulation scenarios.** See `CHANGELOG.md`.

**Known gaps, honestly.** Nothing here has yet run against a real Gradle, Vitest, Docker or `gh` — the simulator drives the real hooks and CLI against fake build tools, which proves the wiring and not the commands. `koverXmlReport` and `vitest run --coverage` are sensible defaults, not verified ones. The run ladder's optional rungs still need per-project commands, and the security auditor is a strong reviewer rather than a proof: the deterministic parts (the secret scan, the dependency gate, the 100% bar on auth paths) are the parts that hold every time.
