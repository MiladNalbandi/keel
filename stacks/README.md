# Stack packs

One file per stack. Adding a stack is this file plus one testing skill — the six flow
skills, the hooks, the guard matrix and the AC loop never change. Nothing in the workflow itself
is written in terms of Gradle, Composer or Vitest.

**Built in here:** `kotlin-spring` (lane `api`) and `ts-react` (lane `web`), so keel works with
nothing installed. **Everything else installs**, with `keel packs add` — Symfony and plain-JS
React live in [keel-stacks](https://github.com/MiladNalbandi/keel-stacks).

A pack declares:

| Key | What it is for |
|---|---|
| `lane` | Which lane this stack belongs to (`api` or `web`), which drives the lane-scoped edit rules in RED and GREEN |
| `detect` | How to recognise the stack in a repo — `files` (any one is enough), `extensions` (any file found by walking the directory), `package_deps` (a name present in `package.json`'s dependencies or devDependencies), `exclude_files` (checked first: any of these present rules the pack *out*, however else it matches) |
| `arch_ref_suffix` | Which `<style>-<suffix>.md` placement reference this stack reads |
| `arch_refs` | A directory inside the pack holding its own placement references, checked before keel's |
| `skill_files` | Testing/implementation skills as paths inside the pack — what keel emits for an installed pack |
| `starter` | What `keel init --new --stack <name>` writes, as `from:` (inside the pack) and `to:` (`{BACKEND}`, `{FRONTEND}`, `{CONTRACT}`) |
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

## Where packs come from

Three roots, most specific first — the first one holding a pack of that name wins:

| Root | Installed with | Beats |
|---|---|---|
| `.keel/stacks/` | `keel packs add <url\|path> --project` | everything |
| `~/.keel/stacks/` | `keel packs add <url\|path>` | the built-ins |
| keel's own `stacks/` | ships with keel | — |

So a project can pin or override a stack without touching anything machine-wide, and
`keel packs list` shows which copy of a pack is actually in force.

A root may hold a pack in any of three shapes: a flat `<name>.yml` (how the built-ins ship), a
directory `<name>/stack.yml` with its skills and templates beside it, or a cloned multi-stack
repo with `stacks/*.yml` and sibling `skills/`, `references/` and `templates/`.

**A pack keel did not ship is shape-checked before use.** `parseYaml` never throws — it skips
lines it cannot read — so a truncated or half-cloned file parses to an empty object, and a pack
with no `detect:` block would match every project and contribute its commands to it. An installed
pack must declare `name`, a `lane` of `api` or `web`, and at least one `detect:` signal; one that
does not is skipped by name rather than half-loaded.

**Installing a pack installs commands keel will run** — a pack's `commands:` are merged into the
project's effective config. `keel packs add` prints them at the moment of install for that reason.

## Skills: a `keel:` name, or a file

A built-in pack names a `keel:` skill, which Claude Code resolves. An **installed** pack names a
**file**, via `skill_files:` — because there is no way for keel to reach into another plugin's
install directory: that path is versioned and Claude Code rejects component paths outside a
plugin's own root. The file is what always works, in any harness.

An installed pack may also declare `skills:` with plugin-skill names (`keel-stacks:symfony-testing`).
That is advisory — it resolves only for someone who also installed the pack's plugin half — and
`skill_files:` is what keel actually emits. Both point at the same file, so a stack repo holds one
copy of each skill.

The same applies to placement references (`arch_refs:`) and starters (`starter:`): both are read
from the pack's own directory, so a language keel does not ship still gets its own
`hexagonal-<suffix>.md` and its own `keel init --new` scaffold.

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

The built-in `ts-react` and keel-stacks' `react-js` can both plausibly claim a directory with
`react` in `package.json`. `react-js` declares `exclude_files: [tsconfig.json]` specifically so
the two never both match a TypeScript project — a positive-only `detect:` block cannot express
"React, but not TypeScript" any other way. A pack that needs the same kind of exclusion should
reach for `exclude_files` rather than trying to make its positive signals narrower than the thing
they actually mean.

## Adding a stack

Copy a built-in and follow it, then either drop it in `.keel/stacks/` for one project or publish
it and `keel packs add` it. A pack that ships its own skills should declare `skill_files:`
(and `arch_refs:` / `starter:` if it has them) so it works without its plugin half installed;
see keel-stacks for the shape.
