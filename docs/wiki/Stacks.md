# Stacks

The workflow is not written for one build tool. Which tools run, which test layers exist and which
skills teach them come from a **stack pack**: one YAML file.

| Pack | Lane | |
|---|---|---|
| `kotlin-spring`, `ts-react` | api, web | built in |
| `symfony`, `django` | api | install from `packs/` |
| `react-js` | web | install from `packs/` |

```
keel packs list                   # what keel can see
keel packs add packs              # this machine
keel packs add packs --project    # this project only (wins over the machine copy)
```

- **Which pack runs:** each pack says how to detect itself. One match wins; none falls back to the
  built-in and says so; two or more is refused until `architecture.backend_stack` /
  `frontend_stack` settles it.
- **Installing a pack installs commands keel will run**, so `keel packs add` prints them.
- **A pack brings** its own skills, placement references, `keel init --new` starter and tools
  (`keel tools list`, `keel tools run <name>`).
- **Migrations that are not SQL** (Doctrine, Django): run `keel tools run schema-dump` once and
  commit the snapshot; the map reads that.

**Your own stack:** copy `packs/stacks/symfony.yml`. Every key is in
[`stacks/README.md`](https://github.com/MiladNalbandi/keel/blob/main/stacks/README.md).
