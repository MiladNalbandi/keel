---
name: spec-authoring
description: Write a spec that can be approved: numbered layer-tagged acceptance criteria, an ASCII UI mockup showing four states, and an ASCII request path marked new versus changed. Load in the spec phase.
user-invocable: false
---

# Writing a spec

The spec gate is the one gate that can never be skipped, so this is the document a human actually decides on. Prose alone is hard to decide about. Two drawings make it answerable:

| Read this | For |
|---|---|
| `references/acceptance-criteria.md` | Numbering, layer tags, what makes one testable |
| `references/ui-mockup.md` | The wireframe, and the four states it must show |
| `references/request-path.md` | The backend drawing, and the skeleton per architecture style |

## Interview with options, not open questions

`AskUserQuestion` takes 2–4 options, and the options are the work. "What should happen on a duplicate?" in a selection box is still a prose question — name the candidate behaviours and what each costs, put the recommendation first, and the answer is one keypress. `references/acceptance-criteria.md` has the worked form.

Never ask what the code already answers, and never ask what the mockup will force you to decide anyway: draw it, then ask about the drawing.

## The order that matters

Draw **before** you finish the criteria list, not after. A mockup is not decoration on an agreed spec — it is how you find the criteria you would otherwise miss. Draw the empty state and you discover there is no criterion for an empty list; draw the error state and you discover nobody said what a failed save tells the user.

So: interview → sketch the four states → read the sketch back and write the criteria it implies → draw the request path → check what the path touches against the criteria.

## Both drawings go in the file

Fenced, so they survive as plain text, and placed after `## Acceptance criteria`. That position is deliberate: `keel pr` copies the first twelve lines of the spec into the PR body, and a drawing up there would land in every PR.

Keep everything inside **80 columns** — this is read in a terminal.

## Check before you ask for approval

```
keel spec check
```

It names `[WEB]` criteria with no state drawn, `[API]` criteria absent from the request path, and sections still left empty. It warns rather than blocks: a one-line change does not need a wireframe, and you are the one who decides that. It runs again inside `keel commit docs`, so the gaps are in front of the human at the moment they approve.

`keel spec show --mockup` or `--path` re-renders either drawing to the terminal later, without opening the file.

## What not to do

- Don't put an acceptance-criterion id inside a drawing. `[gate: skip]` is read from the first line mentioning an id, and a drawing that names one invites confusion.
- Don't draw pixel-accurate layout. This is about *what is on the screen and in what state*, not spacing, colour or font.
- Don't draw a state you have no criterion for, and don't leave a criterion with no state drawn. The two lists should match, and `keel spec check` tells you where they do not.
