---
name: review-ticket
description: Review someone's code — a GitHub PR or a branch — against a ticket and the team's definition of done. Prepares everything without a model, judges with one Sonnet agent per diff chunk in parallel, and shows the result on the dashboard with a sound.
disable-model-invocation: true
argument-hint: "<ticket file, or paste the ticket> <PR number | branch> [--base <ref>]"
---

# keel:review-ticket — $ARGUMENTS

Read-only for the code under review. It does not need a running keel flow.

## 1. The ticket

- A **file path** → use it.
- **Pasted text** → write it unchanged to `.keel/reviews/inbox.md` and use that path.
- Nothing given → ask for it. Do not review without a ticket: the checklist comes from it.

## 2. Prepare — no model, one command

```
keel ticket start --ticket <file> --pr <n>
keel ticket start --ticket <file> --branch <name> [--base <ref>]
```

A number is a PR (fetched with `gh`, no checkout); anything else is a branch. It reads the ticket's
"Definition of done" / "Acceptance criteria" list and the team's `.keel/dod.md` (creating a
starter on first use — tell the user to edit it once), saves the diff, and splits a large one into
chunks. Show its output as it is. If it says the ticket has no done list, say so: the review will
then judge the team checklist only.

## 3. Judge — one agent per chunk, all in one message

Start one `keel:ticket-reviewer` per chunk **in a single message**, so they run in parallel. Give
each only: the review id and its chunk number. Nothing about what you expect — a reviewer told
where to look stops looking elsewhere.

## 4. Report

When they are done, run `keel ticket verdict TR-nnn` (the last agent usually already has) and show
its output as it is: the verdict, every item that is not met or unclear, and every blocking finding.
Do not repeat the met items — the dashboard has the full table. The dashboard updates by itself and
plays a sound when the review finishes.

**Do not fix anything, comment on the PR or push.** If the user wants the findings posted to the PR
or fixed, that is a separate request.
