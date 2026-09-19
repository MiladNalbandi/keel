<!-- keel:start -->
## keel

Backend `{{BACKEND}}`, frontend `{{FRONTEND}}`, contract `{{CONTRACT}}`.

- Small work: `/keel:change`. Spec work: `/keel:feature`. Bugs: `/keel:fix`. Finish with `/keel:ship`.
- One acceptance criterion at a time: failing test first (`keel state red-done`, `keel commit red`), then the code (`keel state green-done`, `keel commit green`).
- Never edit tests while making them pass, never disable or skip a test, never hand-edit generated code or a merged migration.
- Commits go through `keel commit`; `keel status` says what the next step is.
- Run `keel verify fast` for a quick check and `keel verify coverage` before pushing.
<!-- keel:end -->
