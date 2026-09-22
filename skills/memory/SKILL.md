---
name: memory
description: Read back what keel knows about this project — architecture, domain vocabulary, conventions, data and integrations — and refresh it. Load when you need project context you do not have, or after /clear, rather than re-deriving it from the code.
disable-model-invocation: false
user-invocable: true
argument-hint: "[show|sections|reload --section <name>|check|update]"
---

# keel:memory

`docs/knowledge/` holds what an agent needs to work in this repo: the architecture and its
boundaries, the domain's own vocabulary, the conventions that make new code match its
neighbours, the data and fixture strategy, and the integrations with their test stand-ins.
`keel init` builds it; `/keel:ship` refreshes it under a gate.

**You choose which sections exist.** `keel memory sections` prints the five, what each is for, and
which are built; `keel memory sections --confirm conventions,data --by user` records the answer.
`keel memory update` refuses until it has one — five librarians is the most expensive thing init
does, and nothing used to ask. A section nobody chose reads `not selected`, which is a fact and not
a problem, so a partial knowledge base blocks no push. Confirming again **adds**: re-run
`/keel:init` to finish a base over more than one sitting, and what exists is kept, not rebuilt.

The selection decides what must *exist*. It never decides what gets *checked* — a section that is
on disk is read back as project authority whether or not it was chosen, so an unsourced one is
still refused.

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

## Write or rebuild it

Send one **`keel:librarian`** per section, **in parallel** — architecture, domain, conventions,
data, integrations. Each gets one section and nothing about the others: five readers each covering
a slice beats one reader trying to hold the whole codebase, and the sections are independent by
construction. Each writes its own file and ends
`SECTION: <name> claims:<n> cited:<n> unverified:<n>`.

Give every librarian the same two rules, because they are what make the result worth keeping:

- **Every claim carries a backticked `path:line`.** A claim that cannot be cited is not written.
- **A rule about validation, transactions, error mapping or authorization needs a proof** — a
  citation into a test or a `.keel/hunt/repro/` recipe — or the literal prefix `unverified:`.
  A citation proves the code *says* something; only a test proves it *does*. A repo was once
  onboarded with `@Valid @Min @Max` recorded as its pagination convention, on a controller with no
  `@Validated` on the class, so Spring ignored it. The annotation was really on that line.

## Check it

```
keel memory check
```

Resolves every citation, refuses a path that is missing or a line past the end of a file, refuses a
section with no citations at all, refuses a template placeholder nobody replaced, and refuses a
correctness-affecting rule with neither a proof nor an `unverified:` marker. It cannot tell whether
a claim is *true* — nothing can — but it refuses the claims that are not even checkable.

## Refresh it

```
keel memory update
```

Fills the template values keel knows, runs the check, and writes a verdict carrying both the commit
and a hash of the sections — so a knowledge base nobody touched is reported as stale at a new
commit rather than re-stamped as current. `keel pr` is refused while that verdict is missing, stale
or failing. It lands as its own `docs(memory)` commit, separate from the reviewed diff.

## What is not here

Commands live in `docs/RUNNING.md`, verified by the run ladder. Decisions live in
`docs/adr/`. Work in progress lives in `specs/` and `keel status`. This skill points at
them rather than copying them, because a copy goes stale silently.
