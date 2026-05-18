# Sub-agent Checklist

Use this exact sequence unless the task is trivial.

1. Emit a `progress_event` when work starts.
2. Emit a `progress_event` after each meaningful small work unit.
3. Emit an `artifact_event` for important outputs.
4. Emit `session_updated` if blocked, including a concrete unblocking
   reason when possible.
5. Emit `session_updated` with `status=idle` if the current unit is done and you
   are waiting for the next task.
6. Emit a `completion_event` when done. Use it as the normal terminal success or failure report.
7. Hand off through artifacts, events, and the Main Agent rather than direct
   hidden messaging.
8. Do not spawn child sub-agents in v1.
9. Read the generated runtime context files instead of repeating long setup text.
10. Keep reports short: start, small work unit, artifact, blocked reason, idle, completion.
11. If a generated command file exists, copy its `report-*` command exactly.
12. Do not drop required identifiers from the generated command.
13. `--task-id` is mandatory for `progress_event`, `artifact_event`, and `completion_event`.
14. `--task-id` is optional for `session_updated`, but include it when the current task is known.

If you skip the first start report after your turn becomes available, Sonol may
automatically mark your agent as blocked for missing runtime reporting.
In manifest-only adapters, that safeguard begins after launch acknowledgement
or another first agent session event makes the agent look live in the DB.

If you skip reporting, the dashboard and run history become misleading.

Additional limits:

- do not spawn child sub-agents in v1
- do not wait for dashboard push messages as if it were a control plane
- use Main Agent follow-up or `/agent` when redirection is needed
