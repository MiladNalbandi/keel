# Running the two lanes in parallel

Only after the contract commit, and **only if the user says so**. This is not a model decision: it changes how many terminals they are watching, whether a whole lane's human gates happen at all, and whether the review at ship is over work a person saw being written. Put it to them with `AskUserQuestion` once the contract is committed and the spec has `[WEB]` criteria:

| Choice | What it means |
|---|---|
| **Sequential** (default) | one lane at a time in this session. Every gate happens. Simplest to follow, slowest in wall-clock |
| **Parallel, interactive** | `keel lane start web`, second terminal, they drive it. Both lanes keep their gates |
| **Parallel, background** | `keel lane start web --background` hands the lane to `keel:lane-runner`. Faster, and **that lane's human gates are skipped by definition** — say this out loud before they choose, not afterwards |

Default to sequential when they have no preference. The background lane trades a category of review for wall-clock, and that is a trade only they can price.

The mechanics once chosen — backend stays in this session; the frontend lane gets its own worktree, branch and stack, so the two never share a port or a database:

```
keel lane start web                  # interactive: open a second terminal there
keel lane start web --background     # or hand the lane to keel:lane-runner
keel lane start web --acs AC-004,AC-005   # or name the criteria yourself
keel lane status
```

`lane start` hands the lane its own seeded state — its criteria, its branch, its lane name — and takes those criteria off this session's board, where they then read `lane`. The two sessions never pick up the same work, and the edit hook holds each side to its own directories while the lane is open. A background lane goes to `keel:lane-runner`, which works inside that worktree and never runs a keel command from here.

In a background lane that lane's human gates are skipped by definition; every automatic check still runs. `keel lane merge web` brings it back before phase 5 — it refuses while criteria are unfinished unless you pass `--force`, folds the lane's criteria and gate log into this session's state so `keel trace` and the PR body can see them, and reports the files if it conflicts. Approving the last criterion here holds at the gate rather than moving on to integration while a lane is still out.

