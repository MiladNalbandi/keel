---
name: memory
description: Read back what keel knows about this project — architecture, domain vocabulary, conventions, data and integrations — and refresh it. Load when you need project context you do not have, or after /clear, rather than re-deriving it from the code.
disable-model-invocation: false
user-invocable: true
argument-hint: "[show|reload --section <name>|update]"
---

# keel:memory

`docs/knowledge/` holds what an agent needs to work in this repo: the architecture and its
boundaries, the domain's own vocabulary, the conventions that make new code match its
neighbours, the data and fixture strategy, and the integrations with their test stand-ins.
`keel init` builds it; `/keel:ship` refreshes it under a gate.

Unlike the flow skills this changes nothing in the repo, so it is safe to reach for whenever
project context is missing.

## Start here

```
keel memory show
```

Prints the index, each section's size, and **whether it is stale against HEAD** — naming the
commits since it was generated. Read that line before trusting anything you load: a reload
must never present stale architecture as current. If it is stale, say so when you use it, and
`keel memory update` if the drift matters to the work in hand.

## Load one section

```
keel memory reload --section architecture   # placement, and what may import what
keel memory reload --section domain         # entities, use cases, journeys, glossary
keel memory reload --section conventions    # naming, errors, test patterns
keel memory reload --section data           # schema, migrations, fixtures
keel memory reload --section integrations   # external services and their stand-ins
```

**Selective is the default, and that is deliberate.** The knowledge base is the largest thing
keel writes. Loading all of it would break the same rule the phase references exist to serve:
read one reference at a time, or the context you saved by splitting them is spent anyway.

Pick by the question you actually have:

| You need to know | Section |
|---|---|
| Which package this new code goes in | `architecture` |
| What a business term means, or a rule an entity must hold | `domain` |
| What to call it, how errors are raised, where the test lives | `conventions` |
| Whether a migration or fixture is involved | `data` |
| What happens when this call leaves the process | `integrations` |

## Everything, when you genuinely need it

```
keel memory reload --all
```

Opt-in, and it warns when the total is large. Reasonable when onboarding to an unfamiliar
repo; wasteful in the middle of an acceptance criterion.

## Refresh it

```
keel memory update
```

Regenerates the affected sections and writes a verdict keyed to the current commit. This is
the gated step in `/keel:ship`: `keel pr` is refused while the verdict is missing or stale, so
the knowledge base cannot quietly rot behind the code. It lands as its own `docs(memory)`
commit, separate from the reviewed diff.

## What is not here

Commands live in `docs/RUNNING.md`, verified by the run ladder. Decisions live in
`docs/adr/`. Work in progress lives in `specs/` and `keel status`. This skill points at
them rather than copying them, because a copy goes stale silently.
