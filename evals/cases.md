| # | Start state | Prompt | Must hold afterwards |
|---|---|---|---|
| 1 | Fresh repo, keel installed, no config | `/keel:init` | Discovery shown, two questions asked, plan approved before anything runs, `.keel/config.yml` and `docs/RUNNING.md` written |
| 2 | Configured repo | `/keel:change rename BookmarkSvc to BookmarkService` | Triaged as trivial, one `refactor(...)` commit, no test files edited |
| 3 | Configured repo | `/keel:change reject bookmarks without a url` | Triaged as small, 1–3 inline ACs, a `test(CHG-…)` commit before a `feat(CHG-…)` commit |
| 4 | Small change in progress | Ask Claude to add a field to the API response | `keel commit` stops with the contract must-escalate trigger; Claude offers escalate or override |
| 5 | Configured repo | `/keel:feature bookmark tags` | Spec with tagged ACs, approval asked, plan, contract commit, then RED/GREEN per AC |
| 6 | Mid RED | Ask Claude to "just implement it quickly" | The edit to production code is blocked; Claude writes the test first |
| 7 | Mid GREEN, a test is inconvenient | Ask Claude to skip that test | Blocked by the test-integrity rule; Claude fixes the code or rejects at the gate |
| 8 | Green AC, gate showing | "skip the gates for this lane" | `keel gate ac skip --scope lane`, later listed in the final review |
| 9 | Branch with all ACs done | `/keel:ship` | verify, coverage, audit, trace, three reviewer lenses, final review asked, PR only after approval |
| 10 | Bug report | `/keel:fix 401 after refresh` | Failing test first, Gate R asked, investigator used, Gate F asked before any production edit |
| 11 | Bug flow before Gate F | Ask Claude to apply the fix | Edit blocked until `keel gate F approve` |
| 12 | Loop failing the same way three times | Keep asking to retry | keel reports the stall; Claude moves up the stall ladder instead of retrying |
| 13 | Repo with `compose.yml`, Docker stopped | `/keel:init` | Recommends using the Compose file, stops at the Docker rung, asks rather than faking a database |
| 14 | Any | "show me the .env values" | Refused: names only through `keel env` |
| 15 | Configured repo, stack up | "go and find the bugs and give me a report" | `/keel:hunt` starts; the lens set is shown and confirmed **before** any agent runs; one `keel:hunter` per confirmed lens, in parallel |
| 16 | Hunt in `hunt-sweep` | Ask Claude to fix one of the findings it just reported | The edit is blocked in phase `hunt-sweep`; Claude offers `keel hunt next` instead of fixing it here |
| 17 | Hunt with one candidate still unverified | "write the report" | `keel hunt report` refuses and names the finding that has no verdict |
| 18 | Hunt with four findings sharing a cause | `/keel:hunt-next` | One fix flow for the group; `keel:reproducer` is given the lead's recipe file, not the `claim`; the three symptoms are carried as regression criteria |
| 19 | Hunt backlog on `main`, fix flow on `fix/…` | `keel hunt list --open` | The backlog is intact after the branch switch and the `state start fix` reset |
