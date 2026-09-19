# Discovery

Read-only. Nothing runs, nothing is installed, nothing is written. `keel discover` prints what it found.

The premise: the most reliable description of how a project runs is not the README, it is the files that actually run it. CI is the most trustworthy of all, because those commands are known to pass.

## What it reads

| Source | What it yields |
|---|---|
| `build.gradle.kts`, `settings.gradle.kts`, `gradlew` / `mvnw` | the build tool and its wrapper |
| `package.json`, `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` | the package manager |
| `.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile` | commands that are known to pass — every `run:` line mentioning gradlew, mvnw, npm, pnpm, yarn, docker or playwright, capped at 15 |
| `compose.yml`, `compose.yaml`, `docker-compose*.yml` | service names and images |
| `.env.example`, `.env.sample` | required variable **names** |
| `**/*.{kt,java,ts,tsx,yml,properties}` under the app dirs | more variable names, from `${VAR}` and `import.meta.env.VAR`, up to 400 files per dir |
| `java -version`, `node -v`, `docker info`, `docker compose version`, `gh --version` | what is actually installed |

Directory candidates, first match wins: backend `apps/api`, `api`, `backend`, `engine`, `server`, `service`; frontend `apps/web`, `web`, `frontend`, `editor`, `ui`, `client`; contract `contracts/openapi.yaml`, `contracts/openapi.yml`, `docs/api/openapi.json`, `openapi.yaml`; e2e `e2e`, `tests/e2e`, `playwright`.

## Report it as one table

Backend, frontend, build tool, package manager, contract file, Compose file, services, required environment variable **names**, and what is missing. **Names only, never values** — reading `.env` is blocked in every phase, and `keel env` is the way to see which are set.

## The two questions

Ask at most these two, once per project, with `AskUserQuestion`:

1. **Where does the app run while you develop?** On my machine (recommended — services in Docker, Gradle and Vite on the host, fastest loops) / in a dev container / decide later.
2. Shaped by what discovery found: a Compose file exists → "use `<file>`?" with **use it** preselected; no Compose file but services detected → generate one, use your own, or reduced mode; Docker missing → install, external services, or reduced mode.

Everything else comes from discovery or has a default. Do not ask a third question.

## Failure modes

- **Two plausible backend directories** — discovery takes the first match. Say which it chose and let the user correct it.
- **Several Compose files** — name the one CI or the README uses, and say why.
- **No CI** — the build files still work, but you are guessing more. Say so rather than presenting a guess as verified.
- **`docker info` hangs** — it has a 15-second timeout; a missing daemon reads as "not available", which drives question 2.
