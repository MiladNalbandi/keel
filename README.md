<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/keel-lockup-dark.svg">
    <img alt="keel" src="assets/brand/keel-lockup.svg" width="300">
  </picture>
</p>

# keel

<!-- No version number here on purpose: .claude-plugin/plugin.json holds it and CHANGELOG.md is the history. -->

A Claude Code plugin that keeps an AI coding agent on a strict, test-first workflow for a
Kotlin + Spring Boot backend with a TypeScript frontend. **Hooks and a small CLI enforce the rules,
so the model does not have to remember them.**

## What it enforces

- **RED, then GREEN, one acceptance criterion at a time.** Production code is blocked while the failing test is written; tests are frozen while the code is made to pass.
- **Real red tests.** A compile error, a Spring context failure or a Docker problem is refused as a setup problem, not accepted as a failing test.
- **Clean commits.** `test(AC-003)` may not contain production code and `feat(AC-003)` may not contain tests.
- **Phase order.** An illegal move (say, `spec` straight to `green`) is refused, and the legal ones are named.
- **No disabled tests, no secrets in reads or commits, no push without a coverage verdict** for the current commit.
- **Human gates.** Spec approval and the final review before the PR cannot be skipped.

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

**The dashboard** (the `keel_dashboard` MCP tool) is one live local page for every keel project on
your machine: the flow as a state machine, criteria, agents, a tool feed and what blocks a push.

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
