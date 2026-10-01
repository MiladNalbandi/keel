# Code Review

Code is reviewed at fixed points, each looking at a bigger slice, each with a narrow job:

| When | Agent | Looks at |
|---|---|---|
| AC gate, on request | `keel:ac-reviewer` | one criterion: is it met, does the test prove it |
| integration gate, on request | `keel:code-reviewer` | the branch once the frontend calls the real API |
| before E2E | `keel:code-reviewer` | the whole branch: bugs across criteria, out-of-scope changes |
| ship | `keel:reviewer`, one per lens, in parallel | correctness, security, performance, architecture, assertions |
| final review | **you** | everything: should this merge? |

- Fixes go through `review-fix`, the one phase where tests and code can change together.
- At most two fix rounds per review; a third stops and asks you.
- Every finding is shown in the reviewer's own words, including the ones judged not real, with why.
- The final review cannot be skipped, and it leads with the bad news.

## On demand: `/keel:review`

`/keel:review` (whole branch) · `/keel:review performance` (one lens) · `/keel:review all` ·
`/keel:review ac AC-003` · add `--base develop` to compare with another branch.
It only reports: it never edits code, moves the phase or passes a gate.
