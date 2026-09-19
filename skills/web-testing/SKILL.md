---
name: web-testing
description: Test patterns for a TypeScript frontend: Vitest with Testing Library, MSW handlers generated from the API contract, zod response parsing, and tagging tests with acceptance-criteria IDs. Load when writing or fixing frontend tests.
user-invocable: false
---

# TypeScript frontend test patterns

## Tag the test with its AC

```ts
it('AC-004 shows a validation error for an empty url', async () => { /* ... */ });
```

`keel verify ac AC-004` runs `vitest run -t AC-004`.

## Test against the generated client, not a hand-written fetch

- Types and the client come from the contract; never hand-edit the generated folder (the hooks block it).
- Mock at the network level with MSW handlers generated from the same contract, so a contract change breaks the test.
- Parse responses with the generated zod schema in at least one test per endpoint, so a body mismatch fails on the frontend too.

## What to assert

| AC kind | Assert |
|---|---|
| Rendering | Roles, labels and text, not class names |
| Validation | The message the user sees, and that no request was sent |
| Error state | The message for a 4xx or 5xx handler |
| Loading | The intermediate state, using a delayed handler |

## Rules keel enforces

- RED: only `*.test.tsx` files. GREEN: only source files.
- No `.skip(`, `.only(`, `xit(` or `test.fixme`: the hooks reject the edit.
- Component tests never start a real backend; that is what the E2E phase is for.
