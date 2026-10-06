---
name: review-pr
description: Use to review someone else's change — a GitHub PR or a branch — against a ticket and your definition of done. Read-only; the verdict goes to the terminal and the dashboard.
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

## 2. Judge — the agents in the pack's plan, all in one message

Start one `keel:ticket-reviewer` per line of the plan, **in a single message**. Each prompt gets:
the review id, its job (`all`, `ticket`, `team` or `bugs`), the `read` line, its item lines from
the pack (text + `files`), and the file list by number. Nothing about what you expect to find.

**No `keel:ticket-reviewer` (OpenCode)?** Do the jobs yourself, one after another, the same way.

## 3. Validate — only the problems

For every `not-met` item and every `blocking` finding the agents return, start one more
`keel:ticket-reviewer` with job `check` and that single claim, all in one message. `rejected` →
drop the finding, or turn the item into `unclear`. Nothing to check → skip this step. (OpenCode:
re-read each claim's lines yourself.)

## 4. Record — one command

Pipe every result line (items, findings, one `S |` summary line) into:

```
keel ticket record TR-nnn <<'EOF'
T1 | met | src/Order.kt:42 | rejects a negative quantity
F | blocking | src/Order.kt:57 | total ignores the discount
S | One sentence on the change.
EOF
```

It refuses a missing item and names it; add the line rather than guessing (`--partial` marks the
rest unclear). Show its output as it is. The dashboard updates and chimes.

**Do not fix anything or push.** With `--comment`, post the recorded summary as **one** PR comment
(`gh pr comment <n> --body …`) — nothing else.
