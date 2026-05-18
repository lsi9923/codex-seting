# Agent Selection

Use these rules when deciding the agent set.

## Fixed rules

- Total agents: `1..6`
- Main agent: always `1`, but implicit in the creative draft
- Sub-agents: `0..5`
- Effective concurrency must stay within the lower of Sonol policy, Codex
  `agents.max_threads`, and any operator override.
- Effective depth stays at `1` in v1.
- Sub-agents must not spawn child sub-agents in v1.

## Core policy

- Agent selection is `workstream-first`, not `fixed-role-bundle-first`.
- `Main` is the only mandatory role.
- Every other agent is optional and should be created from the request itself.
- Role names are free-form strings.
- Duplicate roles are allowed.
- `execution_class` is the stable internal routing field.
- `role_label` is the user-facing display name.

## Creative draft versus normalized plan

- The local creative draft is an input contract, not the saved normalized plan.
- Author the creative draft with the contract in
  `references/creative-draft-contract.md`.
- In the creative draft, the array key is `subagents`.
- In the creative draft, each subagent uses `slot_id` and `role_label`.
- Main agent policy is implicit and does not appear inside creative draft
  `subagents`.
- Use the checked-in examples before authoring a new draft:
  `references/creative-draft.example.ko.json`
  and
  `references/creative-draft.example.en.json`

## Workstream flow

1. Split the request into meaningful clauses or responsibility clusters.
2. Classify each cluster into one execution class.
3. Create one sub-agent per workstream.
4. Add planner / verifier / reviewer tracks only when the request signals that
   they are needed.
5. If the resulting set exceeds the provider limit, merge similar workstreams
   instead of falling back to a fixed bundle.

## Execution classes

- `lead`
- `planner`
- `research`
- `implementer`
- `verifier`
- `reviewer`
- `docs`
- `refactor`
- `ops`
- `general`

Legacy role names such as `Planner`, `Research`, or `Code` remain readable for
compatibility, but new recommendations should be driven by `execution_class`.

## Default provider base type mapping

- `lead` -> `default`
- `planner` -> `default`
- `research` -> `explorer`
- `implementer` -> `worker`
- `verifier` -> `worker`
- `reviewer` -> `explorer`
- `docs` -> `default`
- `refactor` -> `worker`
- `ops` -> `worker`
- `general` -> `default`

These are policy defaults, not hard requirements.

## Default control profile

- `lead`
  - model: `gpt-5.4`
  - reasoning: `high`
  - sandbox: `workspace-write`
- `planner`
  - model: `gpt-5.4`
  - reasoning: `high`
  - sandbox: `read-only`
- `research`
  - model: `gpt-5.4-mini`
  - reasoning: `medium`
  - sandbox: `read-only`
- `implementer`
  - model: `gpt-5.4`
  - reasoning: `medium`
  - sandbox: `workspace-write`
- `verifier`
  - model: `gpt-5.4-mini`
  - reasoning: `medium`
  - sandbox: `workspace-write`
- `reviewer`
  - model: `gpt-5.4`
  - reasoning: `high`
  - sandbox: `read-only`
- `docs`
  - model: `gpt-5.4-mini`
  - reasoning: `medium`
  - sandbox: `workspace-write`
- `refactor`
  - model: `gpt-5.4`
  - reasoning: `medium`
  - sandbox: `workspace-write`
- `ops`
  - model: `gpt-5.4-mini`
  - reasoning: `medium`
  - sandbox: `workspace-write`
- `general`
  - model: `gpt-5.4-mini`
  - reasoning: `medium`
  - sandbox: `read-only`

For all sub-agents by default:

- `approval_mode`: `inherit-session`
- `communication_mode`: `delegated-thread-and-runtime-events`
- `skills_config`: include `sonol-agent-runtime`
- `nickname_candidates`: derive from role label or execution class
- `mcp_servers`: keep minimal; add only when task scope truly needs them

## Creative draft subagent fields

When authoring the creative draft, define each subagent with:

- `slot_id`
- `role_label`
- `execution_class`
- `purpose`
- `task_title`
- `selection_rationale`
- `provider_agent_type`
- `developer_instructions`
- `model`
- `model_reasoning_effort`
- `sandbox_mode`
- `mcp_servers`
- `skills_config`
- `nickname_candidates`
- `read_paths`
- `write_paths`
- `deny_paths`
- `operational_constraints`
- `depends_on`

Do not author the creative draft with normalized agent fields such as
`agent_id`, `role`, `workstream_id`, `assigned_task_ids`, or
`reporting_contract`.

## Normalized plan agent fields

After remote normalization and local persistence, agent records can include:

- `agent_id`
- `role`
- `role_label`
- `execution_class`
- `workstream_id`
- `selection_rationale`
- `purpose`
- `provider_agent_type`
- adapter-specific alias fields only when the active adapter still needs them
- `developer_instructions`
- `model`
- `model_reasoning_effort`
- `sandbox_mode`
- `mcp_servers`
- `skills_config`
- `nickname_candidates`
- `read_paths`
- `write_paths`
- `deny_paths`
- `depends_on`
- `assigned_task_ids`
- `reporting_contract`

## Decision hints

- Prefer `single-agent` only when the work is narrow enough that `Main` plus at
  most one additional track is sufficient.
- Add `planner` when sequencing, dependency order, or checkpoint definition
  matters.
- Add multiple `research` tracks when the request contains independent research
  areas.
- Add `verifier` when direct edits or behavior changes need confirmation.
- Add `reviewer` when correctness, compatibility, or regression risk is high.
- Add `docs` when output quality depends on structured explanation or handoff
  materials.
- Prefer merging similar read-only workstreams before merging distinct writer
  tracks.

## Hard no-go assumptions

- Do not assume a public CLI exists for `spawn`, `wait`, `terminate`, or
  `send_input` on individual sub-agents.
- Do not assume dashboard approval can inject text into a live Codex session.
- Do not describe `read_paths` or `deny_paths` as native Codex ACLs unless they
  are backed by sandboxing or custom agent config.
- Lower concurrency when edits may collide.
- Keep effective sub-agent depth at `1`.
