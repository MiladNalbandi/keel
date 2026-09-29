# Stack packs

One file per stack. Adding a stack is this file plus one testing skill — the six flow
skills, the hooks, the guard matrix and the AC loop never change. Today's packs: `kotlin-spring`
and `symfony` (lane `api`), `ts-react` and `react-js` (lane `web`) — but nothing in the workflow
itself is written in terms of Gradle, Composer or Vitest.

A pack declares:

| Key | What it is for |
|---|---|
| `lane` | Which lane this stack belongs to (`api` or `web`), which drives the lane-scoped edit rules in RED and GREEN |
| `detect` | How to recognise the stack in a repo — `files` (any one is enough), `extensions` (any file found by walking the directory), `package_deps` (a name present in `package.json`'s dependencies or devDependencies), `exclude_files` (checked first: any of these present rules the pack *out*, however else it matches) |
| `arch_ref_suffix` | Which `skills/architecture/references/<style>-<suffix>.md` file this stack reads |
| `layers` | Test layers, lowest first. The AC loop picks the lowest layer that can express the acceptance criterion |
| `commands` | Command defaults, with `{BUILD}`, `{DIR}`, `{AC}`, `{PKG}` and `{PATHS}` substituted |
| `coverage_report` | Where the coverage report lands, relative to the module directory |
| `dependency_files` | Which manifest(s) declare a dependency for this stack — read by the dependency guard alongside `build.gradle.kts`/`package.json` |
| `skills` | Which skill teaches tests for this stack, and which teaches placement |
| `architecture_styles` | The styles that make sense here — there is no `feature-sliced` backend |
| `boundary_defaults` | Import rules per style, merged into `boundaries.rules` by `keel arch set` |

Read one with `keel skills for <phase> --layer <API\|WEB\|E2E>`, which merges the pack's
defaults with `architecture.style` and any project override, and prints the skills to load
plus the exact reference file inside each.

Nothing here is loaded into context wholesale. A pack is data the CLI reads; the skills it
names are loaded one reference at a time.

## Which pack a lane actually uses

Nothing names a stack anywhere in code. `lib/skills.js#resolvePackForLane` probes every pack's
`detect:` block against the lane's directory (`backend.dir` or `frontend.dir`) and picks the one
that matches:

- **One match** — that pack. This is the ordinary case, and it is why dropping in a new
  `stacks/*.yml` file plus its testing/implementation skill is genuinely enough: nothing keys a
  layer's skill resolution to a pack's name.
- **No match** — falls back to `kotlin-spring` (api) / `ts-react` (web), so an empty or
  unconfigured repo does not resolve to nothing. `keel discover` says so plainly rather than
  reporting it as if it were detected.
- **More than one match** — this is a real state, not necessarily a mistake: a repo can be
  mid-migration from one stack to another, with both still present. Set
  `architecture.backend_stack` (or `frontend_stack`) to the pack name you want to use, and keel
  stops guessing. Until you do, `keel skills for` names every candidate and the config key that
  resolves it, rather than silently picking one.

## Two packs that intentionally overlap the same directory

`ts-react` and `react-js` can both plausibly claim a directory with `react` in `package.json`.
`react-js` declares `exclude_files: [tsconfig.json]` specifically so the two never both match a
TypeScript project — a positive-only `detect:` block cannot express "React, but not TypeScript"
any other way. A future pack that needs the same kind of exclusion should reach for
`exclude_files` rather than trying to make its positive signals narrower than the thing they
actually mean.
