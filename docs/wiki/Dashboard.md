# Dashboard

keel has a live dashboard: one local web page for **every keel project on your machine**.

Ask Claude to open it (the `keel_dashboard` MCP tool), or open `http://127.0.0.1:7391`.

```
Session A (shop) ─┐
Session B (blog) ─┼──► ~/.keel/projects.json ──► one hub on :7391 ──► all projects
Session C (api)  ─┘
```

## What you see

- **All projects.** One card per project: its flow, phase ("step 3 of 15"), acceptance-criteria progress, and a red mark when a question is waiting on you.
- **One project.** Click a card or a tab: the flow as a state-machine graph (you are here, where you may go next), the criteria, the RED/GREEN/GATE loop, running agents, a live tool feed, what is frozen, and what blocks a push.
- **Theme.** The `theme:` button in the header cycles auto → light → dark. Your choice is kept in that browser.

## How the hub works

- The first session that opens the dashboard runs the hub. Every other session hands back the same URL.
- A project joins the list when a Claude session starts in it. It leaves when its `.keel/config.yml` is gone, after 14 days unseen, or with `keel projects forget <name>`.
- If the hub's session closes, another session that has opened the dashboard takes the port over within about ten seconds, and the page reconnects by itself.
- It listens on localhost only, is read-only, refuses foreign `Host` headers, and nothing can register a project over HTTP.

## MCP tools

| Tool | Answers |
|---|---|
| `keel_status` | the whole board for a project |
| `keel_projects` | every project, one line each |
| `keel_next` | the single next action |
| `keel_timeline` | what just happened |
| `keel_explain` | what a phase allows and refuses |
| `keel_dashboard` | the dashboard URL |

Every tool takes `project: "<name>"`, so one session can ask about another.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `KEEL_DASHBOARD_PORT` | `7391` | the hub's port |
| `KEEL_HOME` | `~/.keel` | where the project list lives |
