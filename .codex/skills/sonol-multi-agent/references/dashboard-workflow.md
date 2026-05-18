# Dashboard Workflow

The operator-facing dashboard keeps the same full dashboard surface as the
legacy local build, but it is hosted remotely and talks to the workspace-scoped
local loopback bridge. The local SQLite database remains the authority for
plans, approvals, runs, and runtime events.

## Tabs

- `Plan`: request summary, single/multi recommendation, recommended agents
- `Agents`: role list, provider agent type, model choices, reasoning effort, sandbox mode, MCP/skills surface, dependency view, and path policy
- `Run`: launch mode, run creation, status changes, retry lineage
- `Monitor`: live run state, current task, recent events, blocked reason
- `Outputs`: artifacts and completion summaries
- `Advanced Controls`: DB path, runtime binding, and deeper execution assumptions

## Operator rules

- Auto-save only changes the draft plan.
- The remote dashboard URL should be treated as workspace-scoped through the
  loopback bridge bootstrap fragment, not as one global fixed port for every
  workspace.
- The bridge address and token should be carried in the remote URL fragment so
  the browser can read them without sending them to the remote server in the
  HTTP request line or referrer.
- The original review URL including `#bridge=...&bridge_token=...` is the
  canonical bootstrap link for the current session. Keep that exact URL if you
  need to reopen the dashboard in a new tab or browser on the same computer.
- If a dashboard tab is already open, pasting the full original review URL with
  the `#bridge=...` fragment back into that same tab should reinitialize the
  bridge bootstrap for the current link. Pasting only the plain dashboard path
  is still not enough.
- The plain dashboard path without the bootstrap fragment is not a shareable
  launch link by itself.
- The review URL is a same-computer session link. It depends on the local
  loopback bridge and the current Sonol terminal session, so it must not be
  treated as a cross-computer permanent link.
- The dashboard health and snapshot surfaces expose `dashboard_url`, `authoritative_db_path`, and `workspace_root`. Use those fields to verify that the browser and terminal are looking at the same workspace state.
- Sonol also writes workspace-local authority metadata to
  `<workspace_root>/.sonol/authority.json` and runtime authority metadata to
  `<runtime_root>/dashboard/authority.json`. Operator CLI diagnostics should use
  those authority records before falling back to heuristic DB discovery.
- The browser may cache static assets, but it is not allowed to become the
  source of truth for orchestration state. The bridge-backed SQLite snapshot is
  authoritative.
- The dashboard may review, edit, and approve a plan, but it must never impersonate terminal confirmation.
- After dashboard approval, the dashboard must tell the operator to type `승인` in the current Sonol terminal session.
- The assistant then resolves the latest active approved plan and runs the internal terminal confirmation step.
- Terminal confirmation prepares the run snapshot, runtime context, and launch manifest. It does not imply that provider subagents were auto-spawned.
- If the adapter is manifest-only, the next operator-visible step is “launch
  from the manifest now”, not “work already started”.
- In that mode, raw free-form provider delegation is invalid. Use the
  run-scoped prompt file for each planned `agent_id`.
- Terminal confirmation should prefer the latest approved plan's `authoritative_db_path` when resolving the DB binding, rather than assuming the terminal's initial DB choice is still correct.
- Terminal confirmation may still stop and return actionable guidance instead of launching immediately.
  Examples: dashboard approval is missing, the wrong plan is in focus, validation must be fixed, or the operator must refresh and reconfirm after a newer edit.
- Launch always creates a run snapshot.
- The run-scoped prompt under `<runtime_root>/<run_id>/prompts/...` is the authority for an active run.
- Runtime guidance should be read from the run-scoped prompt under `<runtime_root>/<run_id>/prompts/<agent_id>.txt`.
- Active run state must come from the DB-backed event stream.
- In a manifest-only adapter, a `prepared` run should still show run/session
  state in the dashboard before any real sub-agent progress arrives. “No
  sub-agent report yet” is not the same as “the dashboard has no state”.
- The canonical SQLite event table is `events`. A compatibility view named
  `runtime_events` may exist for older diagnostics, but new tooling should
  prefer the official APIs and the `events` table semantics.
- The remote dashboard mirror is not authoritative without the local SQLite bridge.
- The dashboard may edit supported sub-agent controls, but only within the
  current adapter control surface and Sonol-local governance fields.

## Dashboard control boundary

The dashboard may:

- show whether multi-agent is beneficial
- show and edit supported sub-agent controls
- show the current effective concurrency and depth policy
- show the current workspace root, dashboard URL, and authoritative DB binding for operator verification
- show blocked reasons, artifacts, and completion summaries
- instruct the operator what to confirm in terminal
- show local stop controls only when the current adapter exposes no remote cancel support
- use the bridge token only to authenticate the remote UI against the local
  loopback bridge; it must not be reused as a runtime or planner credential

The dashboard may not:

- inject text into an existing terminal session
- directly steer or terminate a provider sub-agent thread unless the adapter says that is supported
- imply that a local stop button means the remote provider thread was cancelled
- claim native enforcement of advisory path policies
- replace the local SQLite store with browser storage or remote persistence

## Replacement patterns

- use dashboard approval plus explicit terminal confirmation
- use dashboard visibility plus runtime events instead of direct agent control
- use `show-authority.mjs` first when DB/workspace identity is in doubt
- use `show-run-launch-manifest.mjs` or `/api/runs/<run_id>/launch-manifest`
  before assuming a disk `launch-manifest.json` is required
- use `/agent` or normal main-thread follow-up for human steering when a sub-agent must be redirected
- The dashboard must not assume it can inject text into an existing
  terminal session.
- The dashboard may show supported sub-agent controls, but unsupported controls
  must be labeled as unavailable rather than implied.
