# Stacks

keel's workflow is not written in terms of Gradle, Composer or Vitest. Which build tool runs, which
test layers exist and which skills teach them all come from a **stack pack** — one YAML file the CLI
reads as data.

| Pack | Lane | Where |
|---|---|---|
| `kotlin-spring` | api | built in |
| `ts-react` | web | built in |
| `symfony` | api | `packs/`, install on demand |
| `django` | api | `packs/`, install on demand |
| `react-js` | web | `packs/`, install on demand |

The two built-ins need no install, so keel works out of the box. Everything else is opt-in — a stack
you do not use costs you nothing.

## Installing a pack

```
keel packs list                   # what keel can see, and where each came from
keel packs add packs              # this machine  -> ~/.keel/stacks/
keel packs add packs --project    # this project  -> .keel/stacks/
keel packs remove <name>
```

`add` takes a git URL or a local path. Three roots are searched, most specific first:

```
.keel/stacks/     this project   ─┐
~/.keel/stacks/   this machine   ─┼── first one holding a pack of that name wins
<keel>/stacks/    built in       ─┘
```

So a project can pin or override a stack without touching anything machine-wide.

**Installing a pack installs commands keel will run** — a pack's `commands:` are merged into the
project's effective config. `keel packs add` prints them at the moment of install for that reason.

## Which pack a lane uses

Nothing names a stack in code. Each pack declares how to recognise itself, and keel probes:

- **One match** — that pack.
- **No match** — falls back to the built-in for that lane, and says so rather than pretending it
  detected something.
- **More than one** — a real state when a project is mid-migration between two stacks, not
  necessarily a mistake. keel refuses to guess and names the config key that settles it:
  `architecture.backend_stack` or `architecture.frontend_stack`.

A pack keel did not ship is shape-checked first. It must declare `name`, a `lane` of `api` or `web`,
and at least one detection signal — a pack that detects nothing would otherwise match every project
and contribute its commands to it.

## What a pack brings

An installed pack is self-contained: its own testing and implementation skills, its own
`hexagonal`/`ddd`/`layered` placement references, and its own `keel init --new` starter.

```
keel init --new --stack symfony --frontend-stack react-js
```

Skills from an installed pack are loaded **by file path**, not as a `keel:` skill name. Claude Code
gives no stable way for one plugin to read another plugin's install directory, so the file is what
always works — in any harness, with no plugin install at all. A pack may additionally ship a plugin
manifest for native `/keel-stacks:<skill>` invocation in Claude Code; that is a convenience on top,
not the mechanism keel depends on.

## Tools a pack brings

A pack ships the programs its stack needs, and `keel tools` runs them:

```
keel tools list                   # what is declared, and where each came from
keel tools run cs-fix
keel tools show schema-dump
```

| Stack | Tools |
|---|---|
| `kotlin-spring` | `detekt`, `sonar` |
| `symfony` | `cs-fix`, `phpstan`, `sonar`, `schema-dump` |
| `django` | `cs-fix`, `mypy`, `sonar`, `schema-dump` |

`prettier` and `ktlint` are keel defaults rather than pack tools, because they format `.md` and
`.json` in any project — including one with no frontend. A project overrides any of them under
`tools:` in its own config, or turns one off with `<name>: false`.

## When the migrations are not SQL

`keel map` reads the database out of migration files, and it reads **SQL**. Doctrine writes PHP that
wraps `$this->addSql(...)`; Django writes Python that declares models and never mentions SQL at all.
Parsing either means interpreting a framework, and interpreting Django's means reimplementing its
ORM — so keel does neither.

Instead the stack's own tooling dumps the schema once, and keel parses that with the same parser it
uses for real migrations:

```
keel tools run schema-dump        # writes docs/schema.sql
keel map build                    # the database appears on the map
```

Commit the snapshot. The map then works on a clean checkout with no PHP, no Python and no database
anywhere. keel notices when it falls behind — *"docs/schema.sql is older than 0001_initial.py"* —
and a project with no snapshot yet is told which framework it has and what to run.

## Adding your own

Copy `packs/stacks/symfony.yml` and follow it. A pack declares its lane, how to detect itself, its
test layers, its commands, the skills that teach it, and the architecture styles that make sense for
it. [`stacks/README.md`](https://github.com/MiladNalbandi/keel/blob/main/stacks/README.md) documents
every key.

The six flow skills, the hooks, the guard matrix and the AC loop never change.
