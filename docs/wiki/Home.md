<p align="center"><img alt="keel" src="https://raw.githubusercontent.com/MiladNalbandi/keel/main/assets/brand/keel-lockup.svg" width="300"></p>

**keel** is a Claude Code plugin that keeps an AI coding agent on a strict, test-first workflow for
Kotlin + Spring Boot backends with a TypeScript frontend. Hooks and a small CLI enforce the rules,
so the model does not have to remember them.

> Hooks and a CLI decide the rules, rather than the model remembering them.

## What it enforces

- **RED, then GREEN, one acceptance criterion at a time.** Production code is blocked while the failing test is written. Tests are frozen while the code is made to pass.
- **Real red tests.** A compile error, a Spring context failure or a Docker problem is refused as a setup problem, not accepted as a failing test.
- **Clean commits.** A `test(AC-003)` commit may not contain production code, and `feat(AC-003)` may not contain tests.
- **No disabled tests, no leaked secrets, no push without a coverage verdict.**
- **Phase order.** `spec` cannot jump straight to `green`. Every illegal move is refused and the legal ones are named.
- **Human gates.** Spec approval and the final review before the PR cannot be skipped.

## Pages

- [[Installation]]: install the plugin and set up a project
- [[The Flows]]: feature, change, fix, hunt, diagnose and ship
- [[Code Review]]: the four review points and `/keel:review`
- [[Dashboard]]: the live dashboard for every project on your machine
- [[Brand]]: the logo, colours and type

The full command reference lives in the repo: [`docs/REFERENCE.md`](https://github.com/MiladNalbandi/keel/blob/main/docs/REFERENCE.md).
