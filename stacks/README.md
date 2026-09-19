# Stack packs

One file per stack. Adding a stack is this file plus one testing skill — the six flow
skills, the hooks, the guard matrix and the AC loop never change. That is the whole point
of the split: keel v0.x targets Kotlin/Spring and TypeScript, but nothing in the workflow
is written in terms of Gradle or Vitest.

A pack declares:

| Key | What it is for |
|---|---|
| `lane` | Which lane this stack belongs to (`api` or `web`), which drives the lane-scoped edit rules in RED and GREEN |
| `detect` | Cheap signals for recognising the stack in a repo, used by `keel init` |
| `layers` | Test layers, lowest first. The AC loop picks the lowest layer that can express the acceptance criterion |
| `commands` | Command defaults, with `{BUILD}`, `{DIR}`, `{AC}`, `{PKG}` and `{PATHS}` substituted |
| `coverage_report` | Where the coverage report lands, relative to the module directory |
| `skills` | Which skill teaches tests for this stack, and which teaches placement |
| `architecture_styles` | The styles that make sense here — there is no `feature-sliced` backend |
| `boundary_defaults` | Import rules per style, merged into `boundaries.rules` by `keel arch set` |

Read one with `keel skills for <phase> --layer <API\|WEB\|E2E>`, which merges the pack's
defaults with `architecture.style` and any project override, and prints the skills to load
plus the exact reference file inside each.

Nothing here is loaded into context wholesale. A pack is data the CLI reads; the skills it
names are loaded one reference at a time.
