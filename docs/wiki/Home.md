<p align="center"><img alt="keel" src="https://raw.githubusercontent.com/MiladNalbandi/keel/main/assets/brand/keel-lockup.svg" width="300"></p>

**keel** is a Claude Code plugin that keeps an AI coding agent on a strict, test-first workflow.
Hooks and a small CLI enforce the rules, so the model does not have to remember them.

<a href="https://github.com/MiladNalbandi/keel/blob/main/assets/demo/dashboard.mp4"><img alt="The keel dashboard" src="https://raw.githubusercontent.com/MiladNalbandi/keel/main/assets/demo/dashboard.gif" width="800"></a>

## What it enforces

- **RED, then GREEN**, one acceptance criterion at a time: code is frozen while the test is written, tests while the code is.
- **Real red tests**: a compile or setup error is not a failing test.
- **Clean commits, legal phase order, human gates** that cannot be skipped.
- **No disabled tests, no secrets, no push without a coverage verdict.**

## Pages

[[Installation]] · [[The Flows]] · [[Code Review]] · [[Stacks]] · [[Dashboard]] · [[Brand]]

Every command in detail: [`docs/REFERENCE.md`](https://github.com/MiladNalbandi/keel/blob/main/docs/REFERENCE.md).
