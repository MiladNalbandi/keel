# The run ladder

Cheapest rung first, and each must pass before the next runs. Every passing command is recorded exactly as it ran.

```
keel ladder --plan       # show what would run, run nothing
keel ladder              # run it, write the runbook at the end
keel ladder --resume     # skip rungs that already passed
keel ladder --from compile
```

**Get the plan approved before running anything.** One table: every service and its port, the environment variable names it needs, every command the ladder will run, everything that will be downloaded, and every unknown. Commands that deploy, publish or delete are never part of it.

## The rungs

| # | Rung | Proves | Command |
|---|---|---|---|
| 1 | Toolchain | java, node, and docker unless reduced mode | a check, not a command |
| 2 | Dependencies resolve | the build can fetch what it needs | `deps_api`, else `<build> -q help` |
| 3 | Frontend dependencies | the lockfile installs | `deps_web`, else the package manager's frozen install |
| 4 | Both apps compile | the code is syntactically whole | `api_compile` |
| 5 | Frontend typecheck | types agree | `web_typecheck` |
| 6 | Unit tests | tests run at all | `unit_tests`, else `api_test_module` |
| 7 | A container-backed test | Docker is usable **from tests**, not just running | `testcontainers_test` — optional |
| 8 | Services up and healthy | Compose works and health checks pass | `<compose> up -d --wait` — optional |
| 9 | API boots and is healthy | the app starts with real config | `api_health_check` — optional |
| 10 | Frontend serves | the dev server answers | `web_health_check` — optional |
| 11 | Smoke check | one end-to-end path works | `smoke` — optional |
| 12 | Hook self-test | every guard rule fires | `keel doctor --hooks` |

Rungs with no configured command are skipped rather than failing. Rung 7 matters more than it looks: Docker running is not the same as Testcontainers being able to reach it, and that difference is a common source of confusing failures later.

## Proven commands feed back into config

What the ladder proves is written to `.keel/proven.json` and merged **beneath** `.keel/config.yml`, so a verified project cannot end up with an unconfigured command it has already demonstrated. Your own config still wins. `keel doctor` names which commands came from the ladder.

## When a rung fails

Delegate to `keel:setup-doctor`. It reads the trimmed failure and the discovery notes and returns a cause, evidence and a proposed fix, ending `DIAGNOSIS: fixable`, `needs-you` or `unknown`.

- A retry that changes nothing on the machine or in the repo may just run.
- **Anything else needs approval**: installing or switching a JDK, creating `.env.local`, adding a Compose override, changing a port.
- Setup never edits application code or tests.
- After `setup.fix_attempts_per_rung` (3) attempts, record the rung as "needs you" with the diagnosis and continue where possible.

Problems it recognises: Colima or Podman sockets Testcontainers cannot find, an arm64 image gap on Apple Silicon, a port already in use, `docker-compose` versus `docker compose`, too little Docker memory, the wrong JDK active.

## Failure modes

- **Rung 2 fails offline** — dependency resolution needs the network. Say so rather than diagnosing the build.
- **Rung 8 times out** — a service is unhealthy, not slow. Read its logs; raising the timeout hides it.
- **Everything passes but rung 12 fails** — the guards are not firing, which means the plugin is not properly installed. Nothing downstream can be trusted until that is fixed.
