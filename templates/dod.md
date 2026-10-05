# Definition of done

<!-- The team's checklist. `keel ticket start` checks every review against each item below, plus
     the "Definition of done" / "Acceptance criteria" list in the ticket itself. One item per line.
     Edit it once for your team; keep items short and checkable from the code. -->

- [ ] Every acceptance criterion in the ticket is implemented
- [ ] New or changed behaviour has tests, and the tests assert the behaviour (not just run it)
- [ ] No test is disabled, skipped or weakened
- [ ] Errors are handled: invalid input is rejected with a clear message, failures are not swallowed
- [ ] Authorization is checked on every new or changed endpoint
- [ ] No secrets, credentials or personal data in code, config or logs
- [ ] No dead code, commented-out code, debug output or TODO left behind
- [ ] Database changes come with a migration, and it is safe on existing data
- [ ] Public API or contract changes are documented and backward compatible, or the break is called out
- [ ] User-facing text and docs are updated where the behaviour changed
