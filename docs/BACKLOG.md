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

### A running keel reports the version on disk, not the one it is running

`keelVersion()` (`lib/projects.js:140`) reads `.claude-plugin/plugin.json` **at call time**, and
`hello()` (`mcp/http.js:70`) returns it. That is deliberate and right for what it was written for —
the comment at `bin/keel:29` records that a hardcoded version string sat at `0.13.0` across five
releases — but node loads a module once and keeps it. So a process started a week ago answers
`/api/hello` with today's version, confidently, while serving week-old code.

Seen in the field: ten keel processes, two of them **seven days old**, every one of them behind the
files on disk. The dashboard on port 7403 answered `{"keel":true,"version":"0.67.0"}` and was asked
to prove it; it was running code from before the map's edge colours were fixed, so the page kept
drawing every edge grey after the fix had shipped, been installed, and been verified on disk. The
check that should have caught it is the one that said everything was fine.

The same hole is wider than the dashboard: `keel projects` records a `keel` version per project
(`~/.keel/projects.json`), written by whichever long-lived process last touched it, and the MCP
server has no version surface at all.

**The fix**: `hello()` also reports the mtime of the newest module actually loaded —
`Object.keys(require.cache)` filtered to this install, `statSync`, take the max — next to the
version it read. The page compares the two and says "this page is serving code from 7 days ago"
rather than nothing. It is a few lines, it needs no new dependency, and it turns a silent wrong
answer into a visible one.

Worth doing at the same time: `keel doctor` should list keel processes older than the newest keel
file, because the reflex when a fix does not appear is to doubt the fix.

### keel's MCP heuristic lets an orchestrator through

`guards.checkMcp` decides from a name heuristic. Measured against a real flow: it refuses
`terminal_execute`, `workflow_execute`, `hooks_post-edit` and `task_create`, and **allows**
`agent_spawn`, `swarm_init`, `hive-mind_spawn`, `memory_store` and `neural_train` — because
`spawn|init|store|train` are not in the `writeish` pattern.

**The fix**: an `mcp.deny` list consulted *before* the heuristic, and widen `writeish`. Today the only
lever is an allowlist checked after it, so there is no way to say "never this tool in a flow".

---

## Designed, not built

### Phases B, C and D of the stack-pack plan — one is parked, two need a decision

Named in the body of `e74d8cc` as "scoped but not started". They were never designed: a grep for
`Phase (B|C|D)` across every plan file returns that one commit message and nothing else. What
follows is the research that was missing, so the naming stops standing in for a design.

**Phase B — a project switching stacks mid-life. Parked, deliberately.** Not because it is hard,
but because nothing has asked for it: `resolvePackForLane` already re-probes every pack's `detect:`
block on each run, so a project that changes its own shape is re-detected without keel being told.
The unhandled part is the *migration* — the commands, skills and boundaries of the old stack
outliving the switch. Unpark it when a real project switches, not before.

**Phase C — two stacks in one lane. Parked by decision: one stack per lane is the model.**
It read at least three ways — two backends in one repository, one backend calling another as a
service, or one lane whose tests span both — and `lib/skills.js:packCommands` keys everything off
one dir per lane (`pack.lane === 'web' ? frontend.dir : backend.dir`), so each reading breaks it
differently. The decision is that keel has two lanes, backend and frontend, and one stack in each.
Anything wanting a second backend is a second project. Unpark only if that turns out to be wrong in
practice, not because the idea is appealing.

**Phase D — OpenCode support. Shipped in 0.64.0 as `opencode/`; the research below is why it
looks the way it does.**

OpenCode plugins are JavaScript or TypeScript, loaded from `.opencode/plugins/` (project) or
`~/.config/opencode/plugins/`, or resolved from npm through `opencode.json`. Everything in `lib/`
is already plain CommonJS with no Claude Code import, so the enforcement core ports as-is; what
has to be written is the adapter, not the rules.

Its commands are markdown with YAML frontmatter in `.opencode/commands/`, taking `$ARGUMENTS` and
positional `$1`, with `agent:` and `model:` per command. That is close enough to a keel skill that
the eleven user-invoked ones translate mechanically — and Phase A already helps here, because a
pack emits **file paths** rather than `keel:` skill names, so stack skills need no plugin system at
all.

The hook exists and it can refuse: `tool.execute.before` blocks a tool call by throwing, which is
exactly what `guards.checkEdit` needs to be reachable from.

**The hole**: `tool.execute.before` does not fire for tool calls made by subagents spawned through
the `task` tool — reported against 1.0.182, still open, no maintainer response. Seven of keel's
eighteen agents can write: `e2e-author`, `implementer`, `lane-runner`, `librarian`, `prover`,
`reproducer`, `test-author`. On OpenCode every one of those would write unguarded, which is the
single guarantee keel exists to make.

It is survivable, and the reason is worth stating because it was not designed for this. Enforcement
is already two layers, and only the first is a hook:

1. `keel hook pre-tool` refuses the edit — harness-dependent, and on OpenCode it would cover the
   primary agent only.
2. `keel commit <type>` refuses the *commit*, checking the staged set against `COMMIT_RULES` in
   `lib/cli.js:444` — a CLI command, so it holds in any harness, subagent or not.

So an OpenCode port is honest as long as it says which layer is doing the work. Two of the seven
writers are already opt-in — `loops.red_author` and `loops.green_author` default to `main`
(`lib/config.js:50`), so `implementer` and `test-author` do not run unless a project asks for them.
The remaining five are load-bearing and would need either the upstream fix, or a mode that keeps
their writes on the primary agent.

**What Phase D should not do**: ship as though the guards are intact. The gap belongs in
`keel doctor` on OpenCode, named, the way a blank required command is named today.

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

## Shipped since this file was written

### A visual map of the project — **0.62.0**

`keel map build` writes `.keel/map.json`: five figures, keyed to a sha and to a hash of the sources
it read, every node citing the `file:line` it came from. The dashboard grows a `map` view at
`#<id>/map` — whole system, business flow, modules, classes, and the database schema — plus a
console that can call an endpoint or run a configured command against the local stack.

The parts worth not regressing:

- **It refuses to be quietly wrong.** Freshness is the sha *and* the content hash, so a map rebuilt
  from edited sources at the same commit reads as changed and one nobody rebuilt does not re-stamp
  itself. `keel map check` re-resolves every citation and exits 3 on one that no longer lands.
- **One renderer, two routers.** `renderGraph` takes callbacks whose defaults are the flow graph's
  behaviour, so there is no second SVG emitter to keep in step. The routers differ because a rail
  and a schema want different shapes, and that is said out loud rather than forced.
- **The console refuses before it acts.** Four CSRF barriers, then five gates. The scenario that
  tries all four ways past the barriers is the one that must never regress.
- **The example is unmistakably not yours.** `templates/map.json` is a real build of a fictional
  project, carries no sha, draws hatched, and the console is hard-off against it.

### A human gate on the knowledge build — **0.13.0**

`keel memory sections [--confirm a,b | --all | --none]`, modelled on `keel hunt lenses --confirm`:
the user picks which sections, and one `keel:librarian` is spawned per chosen section and no others.
Three states that genuinely differ — `null` (never asked; `keel memory update` refuses, which is the
gate's teeth), `[]` (deliberately none, which is what `--fast` records), and a list.

Its prerequisite shipped with it: **`memory check` is now scoped to the selection.** *Missing* means
chosen-but-absent; an unchosen section reads `not selected`, which is a fact and not a problem, and
`gates.memoryBlocker` honours it — so a two-of-five knowledge base no longer costs the push gate.

Two properties worth not regressing, both covered by scenarios:

- **Confirming again adds.** A built section cannot be un-chosen (`--none` refuses while files
  exist), so re-running `/keel:init` finishes a base over several sittings without orphaning one.
- **Selection decides what must exist, never what gets checked.** A section on disk is read back as
  project authority whether or not it was chosen, so an unsourced one is still refused.

## Limits kept on purpose

Recorded so none of these is mistaken for an oversight.

- **The map's derivations are crude, and each says so on screen.** Endpoints come from the
  contract, so one a controller serves without a contract entry is invisible. Tables come from the
  migrations, so an ORM-generated schema is not seen. A queue is a literal name at a publish or
  listen site. Class edges are imports, not calls — a same-package Kotlin reference needs no import
  and is invisible. A module is a directory unless no role directories exist, in which case it is an
  endpoint path prefix.
- **The console cannot read a database or publish to a queue by itself.** Both need a client keel
  does not ship, so both refuse and name the `db_query` / `queue_publish` command a project can
  define. Running a scheduled job on demand is not offered at all.
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
