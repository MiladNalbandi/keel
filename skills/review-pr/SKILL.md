---
name: review-pr
description: Use to review someone else's change — a GitHub PR or a branch — against a ticket and your definition of done, plus build, lint and code-quality checks. Read-only; nothing reaches the author unless you choose what to share.
disable-model-invocation: true
argument-hint: "<ticket file, or paste the ticket> <PR number | branch> [--base <ref>] [--comment]"
---

# keel:review-pr — $ARGUMENTS

Read-only for the code under review. No keel flow needed. Do not write files: everything moves
through the pack, the prompts and stdin.

## 1. Prepare — one command, no model

```
keel ticket prep --ticket <file> --pr <n>                       # a ticket file
keel ticket prep --ticket - --branch <name> [--base <ref>] <<'EOF'
<the pasted ticket, unchanged>
EOF
```

A number is a PR, anything else a branch. No ticket given → ask for one. If prep stops (empty
diff, closed or draft PR, docs only, lockfiles only), show why and stop. Otherwise keep the pack it
prints in mind and **do not re-read** what it already gives you: items, ranked files, the `read`
commands, `AUTO` verdicts (decided — never re-judge them) and the `plan`.

## 2. Judge and build — at the same time

In **one message**:

- start one `keel:ticket-reviewer` per line of the pack's plan (jobs `ticket`, `team`, `bugs`,
  `quality`, or `all` for a small change). Each prompt gets: the review id, its job, the `read`
  line, its item lines (text + `files`), the file list by number with each `like:` file, and — for
  `quality` and `all` — the `quality rules` lines. Nothing about what you expect to find.
- run `keel ticket build TR-nnn` **in the background**. No model: it checks the code out into a
  throwaway worktree (never your tree), runs the project's compile/typecheck and the stack's lint
  tools, and keeps only messages that name a changed file. It can take minutes; the agents do not
  wait for it.

**No `keel:ticket-reviewer` (OpenCode)?** Run the build first, then do the jobs yourself, one
after another, the same way.

## 3. Validate — only the problems

For every `not-met` item and every `blocking` finding the agents return, start one more
`keel:ticket-reviewer` with job `check` and that single claim, all in one message. `rejected` →
drop the finding, or turn the item into `unclear`. Nothing to check → skip this step. Quality
notes (`Q`) are minor and are not re-checked. (OpenCode: re-read each claim's lines yourself.)

## 4. Record — one command

Pipe every result line (items, findings, quality notes, one `S |` summary line) into:

```
keel ticket record TR-nnn <<'END'
T1 | met | src/Order.kt:42 | rejects a negative quantity
T2 | not-met | src/Order.kt:57 | the total can go below zero | keep it at 0 or more
F | blocking | src/Order.kt:57 | total ignores the discount | subtract the discount first
Q | src/Order.kt:30 | like OrderService.kt | validation is inline | move it into a Validator
S | One sentence on the change.
END
```

It refuses a missing item and names it; add the line rather than guessing (`--partial` marks the
rest unclear). **Show its output as it is** — it is already the easy report: next steps first, then
what is missing, what must be fixed, what to check by hand, what is nice to have, and what is done.
Do not re-summarise it. The verdict counts the ticket, the definition of done and
blocking bugs; the **quality** section (lint, patterns, language rules) is minor and never changes
it — except a compile error in a changed file, which makes it not done. If the build is still
running, say so; it adds its section to the same review when it finishes, and the dashboard updates.

## 5. Sharing with the author — only what the reviewer chooses

The review is the reviewer's. It stays on this machine (`.keel/reviews.jsonl` is gitignored) and
**nothing is sent to the author unless the user asks**. When they ask — or ran with `--comment` —
ask with the question tool which sections to share (multi-select):

| Section | Default |
|---|---|
| `summary` — the verdict and one sentence | on |
| `notmet` — checklist items not done | on |
| `blocking` — bugs that must be fixed | on |
| `unclear` — items the code could not confirm | off |
| `minor` — non-blocking bugs | off |
| `build` — compile and lint issues | off |
| `quality` — pattern and language notes | off |

Then `keel ticket comment TR-nnn --include <chosen,sections>` prints the text. **Show it and ask
once more** before posting; on yes, post it as one comment with `gh pr comment <n> --body-file -`.
Never post anything they did not see. **Do not fix anything or push.**
