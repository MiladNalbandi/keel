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

<p align="center"><a href="assets/demo/dashboard.mp4"><img alt="The keel dashboard: every project, its flow, its map and its database" src="assets/demo/dashboard.gif" width="800"></a></p>

## What it enforces

- **RED, then GREEN, one acceptance criterion at a time.** Production code is frozen while the failing test is written; tests are frozen while the code is made to pass.
- **Real red tests.** A compile error or a broken test context is a setup problem, not a failing test.
- **Clean commits.** `test(AC-003)` may not contain production code; `feat(AC-003)` may not contain tests.
- **Phase order and human gates.** Illegal moves are refused; spec approval and the final review cannot be skipped.
- **No disabled tests, no secrets, no push without a coverage verdict.**

Kotlin + Spring Boot and TypeScript React are built in; Symfony, Django and plain-JS React ship as
[packs](packs/README.md).

## Install

```
/plugin marketplace add MiladNalbandi/keel
/plugin install keel@keel-marketplace
```

Then run `/keel:init` in your project.

## Use it

| Command | For |
|---|---|
| `/keel:feature` | a specced feature, with the full acceptance-criteria loop |
| `/keel:change` | a small change, no spec |
| `/keel:fix` / `/keel:diagnose` | a bug you can reproduce / one you cannot yet |
| `/keel:hunt` | a read-only sweep for proven bugs |
| `/keel:review` | a review agent on demand |
| `/keel:review-ticket` | review someone's PR or branch against a ticket and your definition of done |
| `/keel:ship` | verify, coverage, reviewers, final human review, PR |
| `keel dashboard` | the live page above, for every project on your machine (`--demo` to try it) |

## More

- [Wiki](https://github.com/MiladNalbandi/keel/wiki): guides to the flows, review, stacks and the dashboard
- [`docs/REFERENCE.md`](docs/REFERENCE.md): every command, phase, gate and hook
- [`docs/BACKLOG.md`](docs/BACKLOG.md): what is known to be missing
- [`CHANGELOG.md`](CHANGELOG.md)

[MIT licensed](LICENSE).
