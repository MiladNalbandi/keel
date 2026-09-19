---
id: NNN
title: <feature>
status: draft
---

## Context

<why this exists, in three sentences>

## Acceptance criteria

- AC-001 [API] Given <state>, when <action>, then <observable result>
- AC-002 [API] …
- AC-003 [WEB] …
- AC-004 [E2E] …
- AC-005 [SMOKE] …

Tag a trivial criterion with `[gate: skip]` to skip its human gate.

## UI mockup

<Four states, 80 columns, box-drawing. Draw these *before* finishing the criteria
above: the states you draw are how you find the criteria you would otherwise miss.
Omit this section entirely when the spec has no [WEB] criterion. See
keel:spec-authoring references/ui-mockup.md for the notation.>

```
Default
┌─ <screen> ──────────────────────────────────────────┐
│  [ <input>                      ]  ( <action> )     │
│                                                     │
│  <content>                                          │
└─────────────────────────────────────────────────────┘

Empty
<what the user sees instead of content, and what invites them to act>

Loading
<what is on screen while the request is in flight>

Error
<what failed, what it says, where it says it, and what survives>
```

## Request path

<The path this spec touches, marked + new, ~ changed, blank untouched. Draw both
the success and the failure response. Omit when the spec has no [API] criterion.
See keel:spec-authoring references/request-path.md for the skeleton per
architecture style.>

```
<METHOD> <path>                                        + endpoint
  → <Controller>.<method>                              +
    → <use case or service>                            + <the rule>
      → <repository>.<method>                          ~
        → <table>                                      ~ migration V<n>
  ← <success status> { <fields> }                       +
  ← <failure status> { <shape> }                        +
```

## Data and migrations

## Validation and security rules

## Contract changes

## Out of scope

## Smoke checks

## Decisions

<links to ADRs for anything with a real alternative>
