# Dashboard

<a href="https://github.com/MiladNalbandi/keel/blob/main/assets/demo/dashboard.mp4"><img alt="The keel dashboard" src="https://raw.githubusercontent.com/MiladNalbandi/keel/main/assets/demo/dashboard.gif" width="800"></a>

One live local page for **every keel project on your machine**. Run `keel dashboard`
(`--demo` for example data), or ask Claude (the `keel_dashboard` MCP tool).

```
Session A (shop) ─┐
Session B (blog) ─┼──► ~/.keel/projects.json ──► one hub on :7391 ──► all projects
Session C (api)  ─┘
```

## What you see

- **All projects:** one card each, with flow, phase, criteria progress and a red mark when a question waits on you.
- **One project:** the flow as a state machine, the criteria, agents, a live tool feed, what is frozen and what blocks a push.
- **Map** (`keel map build`): the system, the business flow, modules, classes and the database schema, drawn from the code, migrations and Helm charts. Anything it could not read is named on screen.
- **Theme:** the `theme:` button cycles auto, light and dark.

## Good to know

- The first session to open it runs the hub; others reuse it, and one takes over if the hub's session closes.
- A project joins when a session starts in it, and leaves when keel is removed, after 14 days, or with `keel projects forget <name>`.
- Localhost only. The **console** (call an endpoint, read the database, run a named command) is off until you enable it under `console:` in `.keel/config.yml`.
- MCP tools: `keel_status`, `keel_projects`, `keel_next`, `keel_timeline`, `keel_explain`, `keel_dashboard`; each takes `project: "<name>"`.
- Settings: `KEEL_DASHBOARD_PORT` (default `7391`), `KEEL_HOME` (default `~/.keel`).
