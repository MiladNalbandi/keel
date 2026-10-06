# Code Review

Code is reviewed at fixed points, each looking at a bigger slice, each with a narrow job:

| When | Agent | Looks at |
|---|---|---|
| AC gate, on request | `keel:ac-reviewer` | one criterion: is it met, does the test prove it |
| after the last AC, before integration | `keel:code-reviewer` (Sonnet) | the whole branch: bugs across criteria, out-of-scope changes |
| ship | `keel:reviewer`, one per lens, in parallel | correctness, security, performance, architecture, assertions |
| final review | **you** | everything: should this merge? |

- Fixes go through `review-fix`, the one phase where tests and code can change together.
- At most two fix rounds per review (one after the full-branch review); then it stops and asks you.
- Ship skips its correctness lens when the full-branch review passed and no production code changed since.
- Every finding is shown in the reviewer's own words, including the ones judged not real, with why.
- The final review cannot be skipped, and it leads with the bad news.

## On demand: `/keel:review`

`/keel:review` (whole branch) · `/keel:review performance` (one lens) · `/keel:review all` ·
`/keel:review ac AC-003` · add `--base develop` to compare with another branch.
It only reports: it never edits code, moves the phase or passes a gate.

## Someone else's PR: `/keel:review-ticket`

`/keel:review-ticket <ticket file or pasted text> <PR# | branch>` checks a change against the
ticket's acceptance criteria and your `.keel/dod.md`.

```
keel ticket prep ──► agents by job (1 for a small change) ──► re-check problems ──► keel ticket record
 script decides what it can                                                    one line, dashboard + chime
```

Nothing is written but one index line. Add `--comment` to post the result as one PR comment.

