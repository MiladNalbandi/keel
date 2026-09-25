# Code Review

In the feature flow, code is reviewed at **four points**. Each one looks at a bigger slice than the
one before, and each has a narrow job so that no two say the same thing.

```
 AC loop:  RED → GREEN → gate ──(you pick "review")──► ① ac-reviewer
                                                          │ findings → review-fix → gate
 after all ACs:  security → ② code-reviewer (whole branch)
                                                          │ findings → review-fix → security
 ship:  ③ keel:reviewer × each lens, in parallel
                                                          │ blocking → review-fix → verify again
 final:  ④ you read everything → approve → memory → PR
```

| # | When | Agent | Looks at | Checks |
|---|---|---|---|---|
| ① | AC gate, on request | `keel:ac-reviewer` | one criterion's two commits | is it met, does the test prove it, does the code fit |
| ② | before E2E | `keel:code-reviewer` | the whole branch diff | bugs across criteria, duplication, out-of-scope changes |
| ③ | ship | `keel:reviewer` per lens | the whole branch diff | correctness, security, performance, architecture, assertions |
| ④ | final review | you | everything | should this merge? |

## Rules

- **Fixes go through `review-fix`**, the one phase where tests and production code can change together, because sometimes the finding is "this test is wrong".
- **At most two fix rounds** per review. A third stops and asks you.
- **Nothing is hidden.** Every finding is shown in the reviewer's own words, including every blocking finding that was judged not real, with the reason.
- **The final review cannot be skipped**, and it leads with the bad news: skipped gates and accepted coverage gaps come first.

## Run a review yourself: `/keel:review`

| You type | What runs |
|---|---|
| `/keel:review` | `keel:code-reviewer` on the branch |
| `/keel:review performance` | one `keel:reviewer` with that lens |
| `/keel:review all` | every lens in `review.lenses`, in parallel |
| `/keel:review ac AC-003` | `keel:ac-reviewer` on that criterion |
| `… --base develop` | compare with `develop` instead of `main` |

It only reports. It never edits code, moves the phase, passes a gate or counts as a ship round.
