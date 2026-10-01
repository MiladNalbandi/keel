# Installation

```
/plugin marketplace add MiladNalbandi/keel
/plugin install keel@keel-marketplace
```

From a local clone, add its absolute path instead and run `/reload-plugins`. For one session only:
`claude --plugin-dir /path/to/keel`. Check it loaded with `/keel:status`.

Then, in your project:

```
/keel:init
```

Init detects the layout, proves the project builds, tests and runs, and writes `.keel/config.yml`.
It asks when something is missing rather than guessing.

**Another stack?** Kotlin + Spring Boot and TypeScript React are built in. For Symfony, Django or
plain-JS React: `keel packs add packs`. See [[Stacks]].

**No project yet?** `node bin/keel simulate` drives the real hooks and CLI through every scenario,
and `keel dashboard --demo` shows the dashboard with example data.

Next: [[The Flows]]
