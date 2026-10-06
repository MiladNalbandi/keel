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

| I want to… | Type |
|---|---|
| set up a repo (once) | `/keel:init` |
| build a feature that touches the API, data or auth | `/keel:feature <idea>` |
| make a small change | `/keel:change <description>` |
| fix a bug I can reproduce / cannot reproduce yet | `/keel:fix <symptom>` / `/keel:diagnose <symptom>` |
| find bugs I do not know about, then take the next one | `/keel:hunt` · `/keel:hunt-next` |
| review my own branch | `/keel:review [lens \| all \| ac AC-3]` |
| review someone else's PR against a ticket | `/keel:review-pr <ticket> <PR# \| branch>` |
| close coverage gaps, then finish and open the PR | `/keel:cover` · `/keel:ship` |
| see where I am, or what keel knows about the project | `/keel:status` · `/keel:memory` |
| watch every project live | `keel dashboard` (`--demo` to try it) |

## More

- [Wiki](https://github.com/MiladNalbandi/keel/wiki): guides to the flows, review, stacks and the dashboard
- [`docs/REFERENCE.md`](docs/REFERENCE.md): every command, phase, gate and hook
- [`docs/BACKLOG.md`](docs/BACKLOG.md): what is known to be missing
- [`CHANGELOG.md`](CHANGELOG.md)

[MIT licensed](LICENSE).
