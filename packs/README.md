# packs — optional stack packs

Stack packs that ship with keel but are **not loaded until you install one**. keel has
`kotlin-spring` and `ts-react` built in (see `../stacks/`); anything else lives here and is
opt-in, so keel's default surface stays small and a stack you do not use costs you nothing.

| Pack | Lane | Detects on |
|---|---|---|
| `symfony` | api | `composer.json`, `symfony.lock`, `bin/console`, `.php` files |
| `react-js` | web | `react` in `package.json`, **and no `tsconfig.json`** |

## Install

```
keel packs add packs                    # this machine, both packs
keel packs add packs --project          # just this project
keel packs add packs/stacks/symfony.yml # or one pack on its own
```

`keel packs list` then shows them and where they came from. A project install
(`.keel/stacks/`) beats a machine install (`~/.keel/stacks/`) beats the built-ins.

Nothing here is read until you do that — dropping a pack in this directory does not activate it.

## Optional: native skills in Claude Code

```
/plugin install keel-stacks@keel-marketplace
```

This exposes the same `SKILL.md` files natively, so you can invoke `/keel-stacks:symfony-testing`
yourself and see them in `/plugin`. It is **additive** — it does not give keel the pack
definitions, because Claude Code deliberately does not let one plugin read another plugin's
install directory (that path is versioned and out of bounds). Do this *as well as*
`keel packs add`, not instead of it.

## Layout

One copy of every file serves both: the `SKILL.md` Claude Code picks up is the same file keel
reads by path.

```
.claude-plugin/plugin.json   makes this directory installable as a Claude Code plugin
stacks/*.yml                 the pack definitions keel reads
skills/*/SKILL.md            testing + implementation guidance
references/*.md              hexagonal / ddd / layered placement, for PHP
templates/starter/           what `keel init --new --stack symfony` writes
```

## Adding a stack

Copy `stacks/symfony.yml` and follow it. A pack needs `name`, `lane` (`api` or `web`), and a
`detect:` block with at least one signal — keel refuses a pack without them, because a pack that
detects nothing would match every project. `../stacks/README.md` documents every key.
