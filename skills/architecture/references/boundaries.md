# Import boundaries and `keel verify arch`

Loading a skill cannot be enforced — the *absence* of a Skill call is not a tool event a hook can block. So the architecture choice is made binding on the output side instead: the imports in the code that came out.

## The config block

Written by `keel arch set <style>` into `.keel/architecture.json`, which merges beneath `.keel/config.yml`, so the project can override any of it:

```yaml
boundaries:
  enforce: warn      # off | warn | block
  rules:
    - name: domain-framework-free
      from: 'apps/api/**/domain/**'
      deny_imports: ['org.springframework.**', 'jakarta.persistence.**', 'javax.persistence.**']
    - name: feature-isolation
      from: 'apps/web/src/features/*/**'
      deny_imports: ['@/features/**']
      allow_imports: ['@/shared/**', '@/entities/**']
```

| Field | Meaning |
|---|---|
| `from` | Glob of files the rule applies to. A file matching no rule is never checked. |
| `deny_imports` | Import targets this file may not reference. |
| `allow_imports` | Optional whitelist that wins over `deny_imports`, for "nothing sideways except these". |
| `enforce` | `off` skips the check; `warn` reports and passes; `block` fails the tier. |

**Write the target in the language's own form.** Kotlin and Java keep dotted packages (`org.springframework.**`); TypeScript keeps the module path (`@/features/**`). Mixing them silently matches nothing.

`keel arch set` generates a default rule per style, so most projects never write this block by hand.

## What the check actually does

```
keel verify arch              # the working tree's changed files
keel verify arch --branch     # everything changed against the base branch
```

It reads the **import lines only** of changed files with a source extension, resolves each to its target, and tests it against the rules whose `from` matches. That is all — no compiler, no dependency graph. It is a grep, deliberately, because it also runs inside `keel verify fast`, which fires at the end of every turn; anything slower could not live there.

The consequences of that design are worth knowing:

- It sees **changed files**, not the whole repo. A pre-existing violation in a file you did not touch is not reported. Use `--branch` at ship for the branch's full surface.
- It matches **import statements**, so a fully-qualified reference written inline in the body, or a reflective lookup by string, is invisible to it.
- It cannot know whether an import is *used*. An unused import still counts, which is correct: it should not be there.

## Where it runs

| Moment | Behaviour |
|---|---|
| `keel verify fast` (so also the Stop hook, every turn) | `warn` appends a note; `block` fails the turn |
| `keel verify arch` | On demand, with the violations listed as `file:line` |
| Ship, architecture reviewer lens | Reads the style and its reference, and reports **new** boundary crossings only |

## When a rule is wrong

A boundary that fights the codebase is a bad rule, not a bad codebase. Change it in `.keel/config.yml` under `boundaries.rules` — that override outlives the next `keel arch set`. Do not work around a rule by restructuring code mid-AC, and do not silence the whole check by setting `enforce: off` when one rule is the problem.
