# Reporting Contract

## Event types

- `progress_event`
- `artifact_event`
- `completion_event`
- `session_updated`

## Shared rules

- `event_id` must be unique
- `plan_id` is required for every runtime event payload
- `timestamp` should be ISO8601
- `schema_version` is `1.0.0`
- Sonol v1 runtime supports one active `task_id` per agent at a time
- prefer direct helper-script writes to SQLite during execution
- generated runtime context files should carry the longer instructions so event
  text stays short
- keep `message`, `summary`, and `blocked_reason` compact and factual
- use optional `detail` when the dashboard should explain real work to the user
- `message` is a short headline
- `detail` is `1` to `3` short sentences with concrete activity, target, and next step
- reporting is the supported observability path; it is not a public Codex child
  control API
- reporting improves coordination and observability; it does not create native
  Codex control over child threads
- Reporting is a coordination layer, not a low-level Codex thread-control API
- if the planner driver is remote, runtime reporting still writes to the local
  Sonol DB unless a different transport is explicitly introduced
- when a generated run-scoped command exists, it is more authoritative than a
  hand-typed helper invocation because it pins the intended DB and identifiers

## progress_event

Use for:

- task start
- major step completion
- short in-task progress that keeps the dashboard fresh

Required fields:

- `event_id`
- `plan_id`
- `run_id`
- `agent_id`
- `task_id`
- `step_index`
- `total_steps`
- `state`
- `message`
- `timestamp`
- `schema_version`

## artifact_event

Use when an output should be inspected or reused.

Required fields:

- `event_id`
- `plan_id`
- `run_id`
- `agent_id`
- `task_id`
- `artifact_type`
- `artifact_ref`
- `summary`
- `validation_status`
- `timestamp`
- `schema_version`

Helper default:

- `report-artifact.mjs` defaults `validation_status` to `unchecked` when the
  flag is omitted

## completion_event

Use once per task completion.

Required fields:

- `event_id`
- `plan_id`
- `run_id`
- `agent_id`
- `task_id`
- `result`
- `summary`
- `blockers`
- `next_actions`
- `timestamp`
- `schema_version`

Helper defaults:

- `report-completion.mjs` defaults `blockers` to `[]` and `next_actions` to `[]`
  when those flags are omitted

## session_updated

Use when run or agent status meaningfully changes.

Required fields:

- `event_id`
- `plan_id`
- `run_id`
- `status`
- `message`
- `timestamp`
- `schema_version`

Optional fields:

- `agent_id`
- `task_id`
- `blocked_reason`

Use `session_updated` to request clarification or surface an unblock condition.
Do not assume an external controller can inject a message directly into the
current child thread.
For sub-agent runtime reports, `agent_id` is required. Run-level session changes
belong to top-level orchestration scripts, not child-agent report calls.
For sub-agents, `task_id` is optional and should be included when the current
task is known.
For normal sub-agent success or failure, use `completion_event` rather than
`session_updated completed`.

Recommended `status` meaning for agent sessions:

- `queued`: assigned but not started yet
- `running`: actively working now
- `blocked`: cannot continue until something specific is resolved
- `idle`: current assigned unit is done; waiting for the next instruction
- `cancelled`: the current unit was halted before normal completion

Missing-report safeguard:

- if a non-Main agent becomes ready to start and still emits no runtime event
  for about 90 seconds, Sonol may auto-mark it as `blocked`
- in manifest-only adapters, that safeguard starts after launch acknowledgement
  or another first agent session event makes the agent look live in the DB
- this is a coordination safeguard so silent agents do not look merely queued
- a wrong `--db` or stale hand-typed `run_id` can look exactly like “no report”
  from the dashboard point of view, so generated commands should be preferred

## Interpretation boundary

- `read_paths`, `write_paths`, and `deny_paths` are Sonol policy metadata unless
  a stronger enforcement layer exists
- dashboard visibility does not imply dashboard control over Codex threads

## Coordination boundary

- Use events and artifacts to communicate progress or handoff state.
- Do not assume direct peer-to-peer messaging between sub-agents exists.
- Do not assume an external dashboard can inject commands into Codex threads.
