# The runbook and what setup writes

`docs/RUNNING.md` is generated from the ladder run, not written by hand. `keel ladder` writes it when the ladder completes; `keel ladder --write-runbook` regenerates it on demand.

## What it contains

- **When and against what it was verified** — the date and the short commit sha. A runbook without that is a wish.
- **Prerequisites** — the detected JDK and Node versions, whether Docker is running and which Compose file supplies the services, and the required environment variable **names** (values live in `.env.local` and never appear here).
- **Verified steps** — a table of every rung: label, the exact command, and its result.
- **Needs you** — every rung that failed or was recorded as `needs-you`, with the diagnosis.
- **Day to day** — `keel stack up`, `keel status`, `keel verify fast`.

Regenerate it after the build or Compose files change. A stale runbook is worse than none, because it is believed.

## Everything setup writes

| File | Committed | Contents |
|---|---|---|
| `.keel/config.yml` | yes | paths and the working commands, from `templates/config.yml` |
| `.keel/proven.json` | no | commands the ladder proved; merged beneath the config |
| `.keel/setup.json` | no | rung results, for `--resume` |
| `docs/RUNNING.md` | yes | the verified runbook |
| `.env.local` | **no** | values you entered for required variables |
| `compose.keel.override.yml` | no by default | local fixes such as a port change or `platform: linux/amd64` |
| `compose.yml` | yes, if generated | services discovery found when the project had none |
| CLAUDE.md block | yes | between the keel markers, under 30 lines |

`keel init --write` also adds `.keel/state.json`, `.keel/coverage.json`, `.keel/logs/`, `.keel/format-queue.txt`, `.keel/last-fast-check`, `.keel/flaky.json` and `.env.local` to `.gitignore`.

## Secrets

keel lists every required variable **by name**, asks for each value, and writes them to the gitignored `.env.local`. Values never appear in the conversation, the logs or the runbook — reading `.env*` is blocked in every phase. During the `setup` phase only, writing that one file is allowed; reading it never is.

Services that cannot run locally (company SSO, internal APIs, paid SaaS) go in "needs you" with a suggested stand-in: WireMock for HTTP APIs, Testcontainers modules for brokers and databases, a local Keycloak for OAuth.

## Reduced mode

No Docker: unit, slice and frontend component tests only. Body, data, integration, E2E and smoke layers are marked "not run" in the runbook, the final review and the PR body. Allowed for trivial and small changes; the spec flow requires Docker.

## Finish by offering the three entry points

`/keel:change` for small work, `/keel:feature` for spec work, `/keel:fix` for bugs.

## Failure modes

- **A test-speed change applied without asking** — Testcontainers reuse and a shared Spring test context need approval first; they change how tests behave.
- **The CLAUDE.md block grows past 30 lines** — it is paid for in every session. Link to the runbook instead of restating it.
- **`.env.local` already exists** — never overwrite it. Add only the missing names, and ask.
