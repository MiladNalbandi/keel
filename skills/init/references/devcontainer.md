# Dev-container mode

`keel init --dev-container`. Optional, and **not the default** — host mode is, because it is faster.

## When it is worth it

| Choose dev-container when | Choose host when |
|---|---|
| The machine is genuinely clean and you would rather not install a JDK, Node and a package manager on it | The toolchain is already installed and working |
| You are reproducing a CI failure and want CI's versions, not yours | You are doing day-to-day work and want the fastest AC loop |
| Onboarding someone, and "install these six things" is the friction | You are on macOS and the loop speed matters |

**The macOS caveat is real.** Mounted volumes are slow there, so a Gradle build inside the container can take noticeably longer than the same build on the host. That is why host mode stays the default and this is opt-in.

## What gets generated, and why three files

| File | What it is |
|---|---|
| `compose.dev.yml` | The actual definition: the `dev` service, its image or build, mounts, ports and environment. Assembled from the matched stack packs |
| `.devcontainer/devcontainer.json` | A pointer, so editors can find the container |
| `.devcontainer/Dockerfile` | Only when the repo matches more than one stack pack |

**`devcontainer.json` is deliberately a pointer, not a definition.** It carries four keys — `name`, `dockerComposeFile`, `service`, `workspaceFolder` — and nothing else. It does not restate the image, the mounts or the ports.

That is not minimalism for its own sake. Two files describing one container drift: someone adds a port to the compose file, the JSON still says otherwise, and now the container behaves differently depending on whether you started it with `keel stack up` or by reopening in your editor. Keeping compose as the single source of truth makes that impossible rather than merely unlikely. JSON cannot carry comments, which is why this explanation lives here.

**The Dockerfile exists because toolchains do not compose for free.** A Java image has no Node; a Node image has no JDK. The devcontainer *features* mechanism is designed for exactly this and cannot be used, because features apply when the devcontainer spec builds the image and ours is defined by compose. So the primary pack supplies the `FROM` and every other matched pack contributes its install lines. A single-stack repo skips this entirely and uses its pack's image directly.

## Why the editor integration is most of the point

Without `devcontainer.json`, the container runs and the build works, but your editor is still on the host — with no JDK, so go-to-definition and autocomplete are broken while the tests pass. On a genuinely clean machine that is most of what you wanted.

With it: VS Code offers "Reopen in Container", GitHub Codespaces uses it, and JetBrains Gateway can attach. The language server runs *inside* the container, against the same toolchain the build uses.

## What keel does not touch

**keel never edits your own `compose.yml`.** `compose.dev.yml` includes it unchanged and adds one service beside it. If a port clashes or a service needs different settings, that goes in `compose.keel.override.yml` — your file stays yours.

Two consequences worth knowing:

- The `dev` service gets the host's Docker socket mounted. That is what lets Testcontainers start sibling containers, and it is host-level access inside the container — a real trade, which is why this mode is something you choose rather than get by default.
- Rung 7 of the ladder (a container-backed test) is the one that proves this actually works. Docker being reachable is not the same as Testcontainers being able to use it, and that gap is a common source of confusing failures later.

## Changing what the container holds

Edit the `devcontainer:` block in the relevant `stacks/*.yml`, then rerun `keel init --dev-container`. Editing the generated files directly works until the next regeneration overwrites them.
