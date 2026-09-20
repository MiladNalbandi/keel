# Backlog

What is known to be missing, wrong, or deliberately left alone. Written down because it was found
faster than it could be built, and a finding nobody recorded is a finding nobody acts on.

Four sections, and the distinction between them matters: a **defect** is something that behaves
wrongly today; a **design** is something worked out and not written; a **kept limit** is a trade
somebody chose, recorded so it is not "fixed" by accident; and an **untested inference** is a claim
that follows from reading the code and has not been run.

Every claim here names the file it came from, so it can be re-checked rather than believed.

---

## Defects found, not fixed

### Init leaves a tree that blocks the flows it recommends

There is no `commit` anywhere in `skills/init/SKILL.md`. So a successful `/keel:init` leaves
`.keel/config.yml`, `.gitignore`, the `CLAUDE.md` block, `docs/RUNNING.md` and the knowledge sections
uncommitted — and `keel preflight`, step 0 of every flow, refuses a tree that is not clean. Init closes
by naming three flows to start and none of them can start.

**The fix**: one `keel commit docs INIT-<date>` at step 7. One commit rather than two, because
`keel commit` always stages `git add -A` and the `memoryOnly` rule refuses any staged file outside
`docs/knowledge/` — so a separate `docs(memory)` commit is not expressible at init. Its rationale
(keeping a knowledge refresh out of a reviewed *code* diff) does not apply where there is no code diff.

### The `git` rung passes on a repository with no commits

`verify.hasGit` is `git rev-parse --git-dir`, which answers *"is there a `.git` directory"* — not the
question keel depends on, which is *"can a verdict be keyed to a commit"*. On an empty repository the
first succeeds and `rev-parse HEAD` fails.

Seen in the field: a repository on `main` with **zero commits and 19 untracked entries**, including the
project itself, because someone ran `git init` to answer keel's own `git-repo` question and stopped
there. Every verdict written after that carries a placeholder sha that can never match HEAD, so the
coverage, dependency and knowledge push gates are permanently unsatisfiable. The hunt id
`2026-09-20-unknow` was `'unknown'` sliced to six characters.

**The fix**: the rung also requires `rev-parse HEAD` to resolve, and raises a blocking
`git-first-commit` question naming what it costs. keel must **not** make that commit itself —
committing someone's whole untracked project unasked is not a thing this tool does.

**This must land before the init commit above**: `git add -A` in a repository whose project is
untracked would sweep the entire codebase into a `docs(…)` commit.

### `keel memory check` is not scoped to a selection

A partial `docs/knowledge/` reads as missing sections, and a failing knowledge verdict blocks **every
push**. That is why `--fast` had to defer the knowledge base wholesale rather than build two of five
sections.

**The fix**: `memory.json` gains `selected`. *Missing* means chosen-but-absent; an unchosen section
reads `not selected`, which is a fact and not a problem. `gates.memoryBlocker` honours it.

### keel's MCP heuristic lets an orchestrator through

`guards.checkMcp` decides from a name heuristic. Measured against a real flow: it refuses
`terminal_execute`, `workflow_execute`, `hooks_post-edit` and `task_create`, and **allows**
`agent_spawn`, `swarm_init`, `hive-mind_spawn`, `memory_store` and `neural_train` — because
`spawn|init|store|train` are not in the `writeish` pattern.

**The fix**: an `mcp.deny` list consulted *before* the heuristic, and widen `writeish`. Today the only
lever is an allowlist checked after it, so there is no way to say "never this tool in a flow".

---

## Designed, not built

### A human gate on the knowledge build

`keel memory sections --confirm data,conventions`, modelled on `keel hunt lenses --confirm`: the user
picks which sections, and one `keel:librarian` is spawned per chosen section and no others. Three
states that genuinely differ — `null` (never asked; `update` refuses, which is the gate's teeth), `[]`
(deliberately none, which is what `--fast` becomes), and a list.

**Depends on the scoped `check` above.** Without it, choosing one section costs you every push, so the
gate would hand the user a knife.

### `keel hunt regress`

Replay the stored recipes of every finding closed as `fixed`. Those recipes are already runnable,
committed artifacts sitting next to the report — so a bug that comes back is caught by the exact proof
that caught it the first time.

This is the highest-value item in this file and it needs **no new dependency**. It also makes any
future memory worth more, because the store would then hold verified, replayable findings rather than
recollections.

### ruflo as an index, never as the record

`docs/knowledge/` stays the source of truth — cited, committed, `check`-able, versioned to a sha — and
is indexed into ruflo *after* `keel memory check` passes, for semantic and cross-repo recall.

The principle: **ruflo may remember; keel must still prove.** Anything entering the store has passed a
keel gate first, so the store inherits the bar. An index can be rebuilt from the record; a record
cannot be recovered from an index.

Replacing `docs/knowledge/` with a vector store was considered and rejected: it drops the citation
check, the PR-diff reviewability, the sha-versioning, and the ability to work with no MCP server
present — and it would not save the time, because the cost is five agents reading the tree, not the
file writes.

### `keel models` cannot reach `maxTurns` or `tools`

`model` and `effort` are settable. The same frontmatter-rewriting mechanism would cover the other two.

---

## Limits kept on purpose

Recorded so none of these is mistaken for an oversight.

- **`keel init --write` overwrites a hand-edited `.keel/config.yml`.** Merge-or-refuse needs a decision
  about what merging a commented YAML file means. It is why the gitignore repair lives in
  `keel hunt start` rather than in advice to re-run init.
- **`keel commit` cannot stage selectively.** The bucket rules check what happened to be dirty, not
  what was named; giving `commit` a path argument changes what those rules mean.
- **A prover can write to a real database.** Nothing in `checkBash` inspects `DATABASE_URL`. Point a
  hunt at a disposable stack.
- **E2E coverage detection answers "no spec references this"**, not "this is untested". It matches a
  finding id or a source basename. A wrong *yes* would excuse a missing test; a wrong *no* only asks a
  question — which is the right way round for a crude check.
- **Severity is model-judged** apart from the 5xx floor, which is the one clause a program can check.
- **Nothing proves a human answered a question.** `--by user` / `--by model` is attribution, not
  verification, and a self-answer prints as one.
- **A hook cannot bind a subagent to a path subset.** The payload carries no instance id
  (`lib/state.js:13`), so scope is forced at the ingest instead.
- **Outside a flow, every MCP tool is allowed**, `terminal_execute` included — `checkMcp` returns early
  when `phase === 'none'`. keel governs flows, not the machine.
- **A fast init leaves the stack down**, so a hunt started straight after returns a page of `unproven`
  that reads like "no bugs found". The skill says to run `keel stack up`; nothing makes you.
- **keel cannot tell whether a knowledge claim is true**, only whether it is checkable. A well-cited,
  well-proven, wrong sentence passes every gate.

---

## Untested inference

**Does a ruflo-spawned agent's file write bypass keel's guard entirely?**

`agent_spawn` runs the agent inside ruflo's process, not Claude Code's tool loop, so its writes should
never reach `PreToolUse` — which would mean keel's phase matrix never sees them, and a swarm running
during `green` could rewrite the frozen tests keel exists to protect.

This follows from where the process boundary sits. **It has not been tested.** Confirming it is about
five minutes: start a flow, reach `green`, have a ruflo-spawned agent edit a frozen test file, and
watch whether the edit is refused. Until then it belongs here as an experiment, not as a claim.
