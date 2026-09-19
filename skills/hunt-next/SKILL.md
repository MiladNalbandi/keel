---
name: hunt-next
description: Take the top open group from the current hunt backlog and start the right flow for it, carrying the repro recipe rather than the theory. Use to drain a hunt one finding at a time.
disable-model-invocation: true
argument-hint: "[<finding-or-group-id>]"
---

# keel:hunt-next — $ARGUMENTS

Drains one item from the backlog `/keel:hunt` left behind. It is a slash command of its own
because a twenty-finding backlog is drained across many sessions and at least one `/clear`, and
re-entering `/keel:hunt` would start a new hunt rather than continue this one.

```
keel hunt next
```

It prints the top open group — highest severity first, the whole group as one unit — with the
lead's recipe path and the exact commands to start the right flow. It refuses while any
candidate is unproven, and while the report is uncommitted, because `keel preflight` refuses a
dirty tree.

## Then

```
keel hunt next --take          # records the dispatch so the next call moves on
```

Pick the flow from the lead's `kind`:

| `kind` | Flow | Why |
|---|---|---|
| `defect` | `/keel:fix` | The behaviour contradicts something the system already promises |
| `unspecified` | `/keel:feature` | Nothing ever said what should happen — do not fix an unspecified behaviour inside a bug flow |

Two things to get right, both of them the reason the group exists:

- **Hand `keel:reproducer` the recipe file, not the `claim`.** The recipe shows the symptom; the
  claim is the lens agent's theory, and an agent that knows the suspected cause writes a test
  confirming the theory instead of one demonstrating the bug.
- **The symptoms are regression criteria, not separate work.** Put them in the Gate F plan so
  the one fix is asserted from every angle the hunt saw it from. Fixing them separately is how
  four conflicting edits to one line happen.

## When it merges

```
keel hunt close <id|G-nn> --as fixed --note "<PR or commit>"
```

Closing never deletes a finding — a backlog that forgets what it decided is a report again.
`accepted` and `wontfix` are the other two dispositions, and both need a note.

`keel hunt status` says how many are left.
