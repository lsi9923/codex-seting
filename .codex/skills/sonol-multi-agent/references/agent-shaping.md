# Agent Shaping

Use this guide when deciding whether the request should stay single-agent or
be split into multiple tracks.

## Public guidance

- Main is always the final integrator.
- Add sub-agents only when the work clearly separates into independent tracks.
- Use role names that match the job instead of forcing a fixed bundle.
- Keep the total plan small enough that the operator can still review it.
- Merge similar tracks before splitting the plan too aggressively.
- Add verification or review only when the task actually carries edit or
  regression risk.
- Keep sub-agent depth shallow.
- Lower concurrency when writer tracks could collide.
- Preserve local DB and runtime reporting as the source of truth.

## Common track examples

- planning or sequencing
- research or fact-finding
- implementation
- verification
- review
- docs or handoff
- ops or environment checks

## Notes

- The exact count, titles, and responsibilities should come from the current
  request and the local AI-authored creative draft.
- The hosted planner should normalize and bind that draft, not invent it on the
  remote side.
