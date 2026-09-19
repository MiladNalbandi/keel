---
name: init
description: Set up keel in this repository: detect the layout, ask the two runtime questions, prove the project runs, write the runbook and config. Use before the first keel flow.
disable-model-invocation: true
argument-hint: "[--write] [--new]"
---

# keel:init

## 1. Discover (read only)

Run `keel init` and read its output. Then read, in this order: CI workflows, the build files, Compose files, application config, `.env.example`, README. CI is the most reliable source: those commands are known to pass.

Report what you found in one table: backend, frontend, build tool, contract file, Compose file, services, required environment variable names (names only, never values).

## 2. Two questions

Ask with `AskUserQuestion`:

1. **Where does the app run while developing?** On my machine (recommended) / In a dev container / Decide later.
2. Shaped by discovery:
   - A Compose file exists: "Use `<file>` for services?" — **Use it (recommended)** / I run these services myself.
   - No Compose file but services are detected: Generate one / Use services I run / No services (reduced mode).
   - Docker missing: I will install it / Use services I run / Reduced mode.

## 3. Setup plan, then approval

Show one table: every service, port, environment variable name, every command the ladder will run, everything that will be downloaded, and every unknown. Never include deploy, publish or delete commands. Ask for approval before anything runs.

## 4. Run the ladder

Stop at the first rung that fails:

1. Toolchain: JDK, Node, Docker reachable, ports free
2. Dependencies resolve
3. Both apps compile
4. Unit tests
5. One container-backed test
6. Services up and healthy
7. API boots, health endpoint OK
8. Frontend serves
9. One smoke check
10. `keel doctor --hooks`

After each rung, record the exact command that worked.

## 5. When a rung fails

Delegate to `keel:setup-doctor`. Retries that change nothing may run. Anything that changes the machine or repo files needs the user's approval. Never edit application code. After 3 attempts, record the rung as "needs you" and continue.

## 6. Build the knowledge base

Everything an agent needs to work here, under `docs/knowledge/`: architecture and its
boundaries, the domain's vocabulary, conventions, data and fixtures, integrations and their
test stand-ins. Detect the architecture first (`keel arch detect`, then `keel arch set`), so
the architecture and conventions sections describe the style the code actually uses.

If the `ai-coding-toolkit:project-onboarding` skill is available, delegate the initial build
to it — it already does parallel-agent onboarding, a knowledge graph and Mermaid diagrams —
then fit the result to keel's six sections. Otherwise fill `templates/knowledge/` yourself
from discovery. Either way keel owns every later refresh, through `keel memory update`.

This is a deliberate, bounded, init-time-only exception to keel depending on no other
plugin; nothing at flow time relies on it, and the templates are the fallback.

## 7. Write it down

Run `keel init --write`, then write `docs/RUNNING.md` with the verified commands, the date, the commit, and the "needs you" list. Add the keel block to CLAUDE.md. Ask before applying test-speed changes (Testcontainers reuse, one shared Spring test context).

Finish with the three ways to start work: `/keel:change` for small work, `/keel:feature` for spec work, `/keel:fix` for bugs — and `/keel:memory` to read the knowledge base back in a later session.
