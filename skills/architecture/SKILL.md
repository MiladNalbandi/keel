---
name: architecture
description: Where new code belongs in this codebase, for the architecture style the project actually uses: hexagonal, DDD, layered, MVC or feature-sliced. Load in GREEN before placing a new endpoint, rule, query or component, and at ship when reviewing placement.
user-invocable: false
---

# Where the code goes

This answers one question: **the test drives some new code — which package does it belong in?**

It never answers "what abstraction should I add". The minimum-code rule stands: no field, endpoint, abstraction or branch the test does not drive. Placement and restraint are separate concerns, and this skill only covers placement.

## Load one reference, for this project's style

```
keel arch show
```

That prints `architecture.style` plus the per-module styles. Then read exactly one file:

| `architecture.style` | Read |
|---|---|
| `hexagonal` | `references/hexagonal-kotlin.md` |
| `ddd` | `references/ddd-kotlin.md` |
| `layered` | `references/layered-kotlin.md` |
| `mvc` | `references/mvc-kotlin.md` |
| `feature-sliced` | `references/feature-sliced-web.md` |
| `unknown` | Nothing. Copy the nearest neighbour file and say so. |

A monorepo usually has two styles: `modules` in `keel arch show` gives the backend and frontend separately. Read the one for the module you are editing.

When `hybrid_with` is set, the codebase mixes two styles. Follow the **prevailing** one for the directory you are in — read the neighbours — and do not migrate anything on the way past.

## Boundaries are checked, not trusted

`references/boundaries.md` covers the `boundaries:` block and `keel verify arch`. The short version: some imports are refused, the check runs inside `keel verify fast`, and `enforce: block` fails the turn.

## Two rules that override any style

1. **Copy the neighbours.** The style reference describes the intent; the directory you are editing describes the practice. Where they differ, match the practice and mention the difference once.
2. **Never restructure while implementing an AC.** Moving a file is a change with its own acceptance criterion. If placement is genuinely wrong, say so at the gate.
