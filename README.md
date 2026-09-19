# keel 0.3.1

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

The plugin ships a simulator that builds a throwaway repo with fake build tools and drives the real hooks and CLI through 86 scenarios:

```bash
node bin/keel simulate            # run every scenario (86)
node bin/keel simulate RED:       # only the RED-phase scenarios
node bin/keel simulate --sandbox  # keep a sandbox repo and print how to poke at it
node bin/keel doctor --hooks      # the always-on guard rules only
```

## Commands

```
keel init [--write]                  detect the layout, write .keel/config.yml
keel discover                        what the repo says about how it runs
keel ladder [--plan|--resume]        prove every run step, write docs/RUNNING.md
keel scaffold <what>                 compose, dev-container, playwright, smoke, spec, claude-md
keel stack up|down|status|logs|migrate|reset [--lane web]
keel lane start|status|merge <name> [--background]
keel smoke | keel pr [--dry-run] | keel triage "<desc>" | keel check-size
keel stall [reset] | keel models show|set-all <model> [--yes]
keel state start|phase|ac|show       flow state
keel state red-done|green-done       guarded transitions
keel gate <ac|R|F|final> <decision>  record a human gate
keel escalate [--override "why"]     small change -> spec flow
keel verify fast|ac|module|contract|full|e2e|release|coverage
keel commit <type> <ID> "<msg>"      commit with phase rules enforced
keel trace [--strict] | keel audit   AC traceability and commit audit
keel status | keel env | keel doctor
keel simulate [name] [--sandbox]
```

## Skills

`/keel:init`, `/keel:change`, `/keel:feature`, `/keel:fix`, `/keel:ship`, `/keel:status`, plus three reference skills that Claude loads on demand: Kotlin/Spring testing, frontend testing, Playwright.

## Subagents

`keel:reviewer`, `keel:explorer`, `keel:investigator`, `keel:e2e-author`, `keel:implementer`, `keel:lane-runner`, `keel:setup-doctor`, `keel:bulk-reader`. Each model is a plugin setting, so you can put them all on Opus from `/config`.

## Status

v0.2 implements the design end to end:

- enforcement: hooks, phase matrix, guarded commits, stall detection, flake reruns
- setup: `keel discover`, the run ladder, `docs/RUNNING.md`, scaffolding (compose, dev container, Playwright, smoke, spec, CLAUDE block)
- checks: `fast`, `ac`, `module`, `contract`, `full`, `e2e`, `release`, and real coverage from Kover/JaCoCo XML and LCOV with changed-line, branch and ratchet rules
- ops: `keel stack` (per-lane Compose project and port offset, migrate, reset), `keel lane` (worktrees), `keel smoke`, `keel pr` with a generated body
- change flow: `keel triage`, `keel check-size`, `keel escalate`
- 69 simulation scenarios, run by `node bin/keel simulate`

v0.3 closes the remaining gaps: FileChanged and Notification hooks, the large-file read guard with the bulk-reader redirect, Serena edit tools routed through the phase matrix, per-AC coverage, changed-package test scope, the four-step stall ladder with `keel stall`, `keel models` for subagent models, and `keel init --new|--refresh|--dev-container` with a starter template.

Known gaps: the run ladder's optional rungs need per-project commands (`api_health_check`, `testcontainers_test`, `smoke`); the three reviewer lenses and the background lane are driven by the skills rather than the CLI; nothing here has run against a real Gradle, Vitest, Docker or gh yet.
