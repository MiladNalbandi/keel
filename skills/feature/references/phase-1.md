# Phase 1 — clarify and spec

Interview first, write second. Use `AskUserQuestion` and cover: edge cases, validation rules, authorization rules, data rules, error states, and what is explicitly out of scope. Three question rounds maximum — then write the spec and list whatever is still open inside it.

## The spec file

`specs/NNN-slug.md`, from `templates/spec.md`. Sections: Context, Acceptance criteria, **UI mockup**, **Request path**, Data and migrations, Validation and security rules, Contract changes, Out of scope, Smoke checks, Decisions.

The two drawing sections come from `keel:spec-authoring`, and they are written **before** the criteria list is final: an ASCII mockup of four states (default, empty, loading, error) for any `[WEB]` criterion, and an ASCII request path marked `+` new / `~` changed for any `[API]` one. They are not documentation of an agreed spec — they are how the missing criteria get found. Run `keel spec check` before asking for approval.

Every AC is numbered, layer-tagged and testable:

```
- AC-001 [API] Given <state>, when <action>, then <observable result>
- AC-004 [WEB] …
- AC-006 [E2E] …
- AC-007 [SMOKE] …
```

Layer tags drive real behaviour: `[API]` ACs run in the `api` lane, `[WEB]` in `web`, and RED/GREEN edits are scoped to that lane. `[E2E]` is phase 7, `[SMOKE]` phase 8.

Tag a genuinely trivial criterion `[gate: skip]` to skip its human gate — keel reads the tag from the spec line when the AC is registered.

## Register the ACs

```
keel state ac AC-001 --layer API --current
keel state ac AC-002 --layer API
keel state ac AC-004 --layer WEB
```

`keel state board` shows what is registered.

## The gate — cannot be skipped

Spec approval is one of the two gates that can never be skipped. Show the ACs and ask for approval. On approval:

```
keel commit docs SPEC-NNN "spec"
```

Then **start a fresh session** before phase 2. State is on disk; the SessionStart hook re-injects a brief.

## What makes an AC testable

- Observable from outside: what a user sees, what a client receives, what gets stored or sent.
- One requirement each. "Validates and emails" is two ACs.
- Small enough to map to one or two tests at one layer.

If you cannot imagine the test, the AC is too vague — that is the signal to ask another question, not to write it and hope.

## Failure modes

- **An AC with no layer tag** — it will default to `API` and land in the wrong lane.
- **A "non-functional" AC** ("should be fast") — turn it into a number and a layer, or move it to Out of scope.
- **Validation and security rules left empty** — phase 1's exit criteria include them, and the security review later has nothing to check against. An authorization rule written here is what makes an IDOR detectable.
