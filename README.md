<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/keel-lockup-dark.svg">
    <img alt="keel" src="assets/brand/keel-lockup.svg" width="300">
  </picture>
</p>

# keel

<!-- No version number here on purpose: .claude-plugin/plugin.json holds it and CHANGELOG.md is the history. -->

A Claude Code plugin that keeps an AI coding agent on a strict, test-first workflow.
**Hooks and a small CLI enforce the rules, so the model does not have to remember them.**

Kotlin + Spring Boot and TypeScript React are built in; Symfony, Django and plain-JS React ship in
[`packs/`](packs/README.md), and a new stack is one YAML file plus a testing skill — nothing in the
workflow is written in terms of Gradle, Composer, pytest or Vitest.

## What it enforces

- **RED, then GREEN, one acceptance criterion at a time.** Production code is blocked while the failing test is written; tests are frozen while the code is made to pass.
- **Real red tests.** A compile error, a Spring context failure or a Docker problem is refused as a setup problem, not accepted as a failing test.
- **Clean commits.** `test(AC-003)` may not contain production code and `feat(AC-003)` may not contain tests.
- **Phase order.** An illegal move (say, `spec` straight to `green`) is refused, and the legal ones are named.
- **No disabled tests, no secrets in reads or commits, no push without a coverage verdict** for the current commit.
- **Human gates.** Spec approval and the final review before the PR cannot be skipped.

## Stacks

`keel packs list` shows what is available. The two built-ins need no install; anything else is
opt-in, so a stack you do not use costs you nothing.

```
keel packs add packs              # Symfony, Django and plain-JS React, this machine
keel packs add packs --project    # or just this project, which wins over the machine copy
```

An installed pack brings its own testing and implementation skills, its own placement references,
its own `keel init --new` starter and the **tools** its stack needs — keel carries nothing for a
language it does not ship. [`stacks/README.md`](stacks/README.md) documents every key.

## Tools

The programs keel runs for you — formatters, analysers, CI probes — are declared, not hardcoded.

```
keel tools list                   # what is declared, and where each came from
keel tools run ci                 # the last few pipeline runs, as one compact verdict
keel tools run cs-fix
```

A tool can bind to a lifecycle point: `edit`, `batch`, or `pre-commit`, where `fail: fix` lets a
formatter repair and re-stage while `fail: block` refuses the commit. And a tool exists so the agent
does not pay for output twice — `keel tools run` hands back an exit code, a duration and a trimmed
head, with the full text on the dashboard where a person reads it for free.

## Install

```
/plugin marketplace add MiladNalbandi/keel
/plugin install keel@keel-marketplace
```

From a local clone, add the absolute path instead and run `/reload-plugins`. For one session only:
`claude --plugin-dir /path/to/keel`. Check it loaded with `/keel:status`, then run `/keel:init` in
your project.

## Use it

| Command | For |
|---|---|
| `/keel:feature` | a specced feature, with the full acceptance-criteria loop |
| `/keel:change` | a small change, no spec |
| `/keel:fix` / `/keel:diagnose` | a bug you can reproduce / one you cannot yet |
| `/keel:hunt` / `/keel:hunt-next` | a read-only sweep for proven bugs, and draining its backlog |
| `/keel:review` | a review agent on demand: the whole branch, one lens, or one criterion |
| `/keel:ship` | verify, coverage, reviewers, final human review, PR |
| `/keel:status` | where you are and the next command |

**The dashboard** — `keel dashboard`, or the `keel_dashboard` MCP tool — is one live local page for
every keel project on your machine: the flow as a state machine, criteria, agents, a tool feed and
what blocks a push. `keel map build` adds a **map** view drawn from what the project actually
exposes: the system, the business flow, the modules, the classes in one module, and the database
schema. Every derivation states what it could not read, because a map that quietly under-reports is
worse than one that says so. `keel dashboard --demo` shows it without a project to point at.

## Try it without a project

```bash
node bin/keel simulate            # drive the real hooks and CLI through every scenario
node bin/keel simulate --sandbox  # keep a throwaway repo to poke at
```

## Honest limits

The simulator runs the real hooks and CLI against fake build tools, which proves the wiring and not
Gradle, Vitest, Docker or `gh` themselves. The coverage commands are sensible defaults, not verified
ones. Everything known to be missing is in [`docs/BACKLOG.md`](docs/BACKLOG.md).

## More

- [`docs/REFERENCE.md`](docs/REFERENCE.md): every command, phase, gate, hook and subagent
- [Wiki](https://github.com/MiladNalbandi/keel/wiki): guides to the flows, code review and the dashboard
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each version
- [`assets/brand/`](assets/brand): the logo and colours

[MIT licensed](LICENSE).
