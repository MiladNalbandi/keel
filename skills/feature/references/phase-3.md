# Phase 3 — contract

The contract changes before any controller or client code. Both sides are generated from it, which is what keeps them from drifting.

```
# edit contracts/openapi.yaml
keel verify contract
keel commit contract SPEC-NNN "<what changed>"
```

## What `keel verify contract` runs

In order, stopping at the first failure:

| Step | Command key | Required |
|---|---|---|
| contract lint | `contract_lint` | no — reported as skipped if unset |
| codegen | `codegen` | **yes** — the tier fails if unset |
| api compile | `api_compile` | yes |
| web typecheck | `web_typecheck` | yes |

A missing **required** command fails the tier with `MISSING: <step>`; a missing optional one is listed as `skipped:` in the success output. Neither is silently dropped. `keel doctor` shows which are set.

## Rules

- Only the contract file is writable this phase — `api-main`, `web-src` and test buckets are all denied by the matrix.
- Generated code is never committed and never hand-edited; the guard blocks the `generated` bucket in every phase.
- Additive changes only, unless the spec says a break is intended and the Decisions section records it.

## Then

Both lanes can start. If a web lane is running, this is the earliest point it may begin:

```
keel lane start web [--background]
```

## Failure modes

- **`codegen` is not configured** — the tier fails by design rather than pretending to pass. Set `commands.codegen` (typically the generator task plus the client generator) in `.keel/config.yml`.
- **Codegen succeeds, compile fails** — the contract introduced a required field the existing code does not supply. That is a real AC, not a contract problem; note it and let the AC loop handle it.
- **Lint objects to an existing part of the file** — fix only what your change introduced. Pre-existing lint debt is a separate `/keel:change`.
- **The generated folder shows as modified** — it should be gitignored. If it is tracked, that is a repo problem to fix before continuing, or every commit will carry generated noise.
