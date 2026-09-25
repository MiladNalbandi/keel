# Installation

keel is a Claude Code plugin. The repository is its own marketplace.

## From GitHub

```
/plugin marketplace add MiladNalbandi/keel
/plugin install keel@keel-marketplace
```

## From a local clone (your edits apply straight away)

```
/plugin marketplace add /absolute/path/to/keel
/plugin install keel@keel-marketplace
/reload-plugins
```

## For one session only

```bash
claude --plugin-dir /absolute/path/to/keel
```

## Check it loaded

`/plugin` lists keel, and `/keel:status` answers.

## Set up a project

In your project, run:

```
/keel:init
```

Init detects the layout, proves the machine can build, test and run the project (the "run ladder"),
writes `.keel/config.yml`, and builds a small knowledge base under `docs/knowledge/`. It stops and
asks when something is missing, rather than guessing.

## Try it without a project

keel ships a simulator. It builds a throwaway repo with fake build tools and drives the real hooks
and CLI through every scenario:

```bash
node bin/keel simulate            # every scenario
node bin/keel simulate --sandbox  # keep a sandbox repo to poke at
node bin/keel doctor --hooks      # the always-on guard rules only
```

Next: [[The Flows]]
