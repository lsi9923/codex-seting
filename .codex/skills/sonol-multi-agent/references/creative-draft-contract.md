# Creative Draft Contract

Use this document when authoring the local creative draft that is passed to
`present-proposal.mjs` or `recommend-plan.mjs`.

## Authority

- The creative draft is the local AI-authored input contract.
- The hosted planner only normalizes, validates, and binds that draft.
- The creative draft is not the same thing as the persisted normalized plan.

## Root fields

The creative draft must contain exactly these required root fields:

- `plan_title`
- `preferred_language`
- `single_or_multi`
- `multi_agent_beneficial`
- `recommendation_summary`
- `recommendation_reasons`
- `subagents`

Do not author the draft with plan-level extras such as `agent_count`,
`main_agent_role`, or `output_artifacts`. Those belong to other layers or are
implicit.

## Main agent

- The Main agent is mandatory in runtime orchestration.
- The Main agent is implicit.
- Do not include Main inside the creative draft `subagents` array.

## Subagent fields

Each item in `subagents` must contain these canonical fields:

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

## Important distinction

The persisted normalized plan and run layers later use fields such as
`agent_id`, `role`, `workstream_id`, `assigned_task_ids`, and
`reporting_contract`.

Those are not the creative draft authoring contract.

## Examples

- Korean example: `references/creative-draft.example.ko.json`
- English example: `references/creative-draft.example.en.json`
- JSON schema: `internal/schemas/creative-draft.schema.json`
