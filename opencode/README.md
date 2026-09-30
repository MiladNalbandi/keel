# keel on OpenCode

keel's rules were never Claude Code's. `keel hook pre-tool` reads a JSON object on stdin and answers
with an exit code — `0` allows, `2` refuses and puts the reason on stderr. Everything in `lib/` is
plain CommonJS with no harness import. So this directory is an **adapter**, not a second keel: it
renames OpenCode's tool and argument names to the ones the hook already understands, and turns
exit `2` into the thrown error OpenCode uses to refuse a call.

No rule lives here. A rule that lived in two harnesses would drift, and the copy the user is being
judged by would be the wrong one.

Nothing in this directory is read by Claude Code. It ships in the repo and is inert until installed.

## Install

```bash
node opencode/install.mjs             # into ./.opencode/
node opencode/install.mjs --global    # into ~/.config/opencode/
node opencode/install.mjs --dry-run   # print what it would write
```

That writes two things:

| What | Where |
|---|---|
| the enforcement plugin | `.opencode/plugins/keel.js` |
| one command per keel flow | `.opencode/command/keel-<flow>.md` |

Restart OpenCode afterwards — plugins load at start.

`keel` must be on `PATH`. Set `KEEL_BIN` to an absolute path if it is not.

### The commands are generated, not copied

`install.mjs` reads keel's own `skills/` tree and emits one command per skill marked
`disable-model-invocation: true` — the eleven a person starts. Each command points at the
`SKILL.md` by absolute path rather than inlining it, which is the same harness-agnostic trick
Phase A used for stack packs: a file path needs no plugin system to resolve.

Eleven copied command files would drift from the skills they mirror, and the copy the agent read
would be the stale one. The reference skills (`architecture`, `web-testing`, and the rest) are
deliberately **not** installed as commands — they are for the model to pull in mid-task, and
offering a reference sheet as a slash command invites running it like a flow.

## What is enforced, and what is not

This is the part to read before trusting it.

OpenCode's `tool.execute.before` **does not fire for tool calls made inside a subagent** spawned
through the `task` tool. Reported upstream against 1.0.182 and open. Seven of keel's eighteen
agents can write — `e2e-author`, `implementer`, `lane-runner`, `librarian`, `prover`, `reproducer`,
`test-author` — so on OpenCode their writes would reach disk unchecked. That is the one guarantee
keel exists to make.

**The plugin closes it by refusing the `task` call itself.** That call is made by the *primary*
agent, so the hook does see it: spawning a write-capable keel agent while a flow is running is
refused, which keeps every write on the agent the guards can still reach. Read-only agents —
`explorer`, `reviewer`, `investigator`, `hunter`, `security-auditor`, `arch-surveyor`,
`code-reviewer`, `ac-reviewer`, `dependency-triager`, `setup-doctor`, `bulk-reader` — spawn freely.

Two of those seven were already opt-in: `loops.red_author` and `loops.green_author` default to
`main` (`lib/config.js`), so `implementer` and `test-author` do not run unless a project asks.

### Enforcement is two layers, and only the first is a hook

| Layer | What it refuses | Harness |
|---|---|---|
| `keel hook pre-tool` | the **edit**, before it happens | needs the hook — this adapter |
| `keel commit <type>` | the **commit**, if the staged set does not match the phase | a CLI command, holds anywhere |

The commit guard (`COMMIT_RULES`, `lib/cli.js`) is unaffected by any of the above. Even if an edit
slipped past layer 1, the commit carrying it is refused.

### Where it fails closed

Two cases refuse rather than guess, matching keel's rule that a phase with no row in the guard
matrix fails closed instead of falling back to allow-all:

- **`keel` cannot be run** — a flow that looks enforced and is not is worse than one that stops.
- **`apply_patch` whose body names no file** — keel has nothing to check, so the patch is refused
  with a pointer to `edit` or `write`, which name their file directly.

## Tool mapping

| OpenCode | keel sees | Argument |
|---|---|---|
| `read` | `Read` | `filePath` → `file_path` |
| `write` | `Write` | `filePath` → `file_path` |
| `edit` | `Edit` | `filePath` → `file_path` |
| `apply_patch` | `Edit`, once per file in the patch | parsed from `patchText` |
| `bash` | `Bash` | `command` |
| `task` | — | refused for write-capable agents during a flow |

`grep`, `glob`, `webfetch`, `websearch`, `todowrite` and the rest are not guarded by keel in any
harness and pass through untouched rather than being guessed at.

`tool.execute.after` forwards to `keel hook log-tool`, so `keel board` and the dashboard read one
timeline whichever harness produced it.

## Verified behaviour

Against a fixture with a live flow, the adapter tracks the phase rather than holding a fixed
opinion:

```
phase red     production code REFUSED    test file ALLOWED
phase green   production code ALLOWED    test file REFUSED     ← inverted
phase gate    production code REFUSED    test file REFUSED
no flow       production code ALLOWED    test file ALLOWED     ← keel stays out of the way
```

## Not done

- **Phase C** (two stacks in one lane) is parked; one stack per lane, backend and frontend, is the
  model. See `docs/BACKLOG.md`.
- The `session.created` / `tui.toast.show` hooks are unused. A startup notice naming the subagent
  limitation would be better than a line in this file, and is not written.
- Nothing here is exercised against a running OpenCode. The adapter is tested against keel's own
  hook contract, which is the half that can rot; the OpenCode half is read from its documented API.
