# Goal Workflow

Use this workflow whenever the user invokes `/goal` or `/goals`.

This workflow is based on the inspected YouTube guide `6RdMjPYt84o`: clear and measurable goals, short feedback loops, and external memory files.

## Operating Contract

1. Start by turning the user request into a concrete goal.
2. Define the stop condition before making changes.
3. Convert qualitative requirements into a checklist that can be verified.
4. Work in short loops: inspect, change, verify, record evidence, decide the next loop.
5. Keep external memory for the task instead of relying on chat memory only.
6. Do not mark the task done without real evidence from tools, files, tests, screenshots, API responses, or generated outputs.

## External Memory Files

For non-trivial work, create or reuse a task folder under:

```text
.omx/goals/<task-slug>/
```

Use these files:

- `plan.md`: target result, constraints, acceptance checklist, stop condition.
- `experiments.md`: single source of truth for attempts, commands, outputs, pass/fail results, and the next decision.
- `scratchpad.md`: temporary hypotheses, UI observations, parsing notes, and cleanup notes.

If relevant files already exist, continue them. Do not restart the task from scratch.

## Retry And Waiting Rules

- If a valid output already exists, reuse it and move to the next phase.
- Do not re-plan or re-send prompts just because the output format is slightly different; first parse and validate what already exists.
- For web UI generation, wait for the current generation to finish before retrying.
- Retry only after a clear error, timeout, missing output, or failed validation.
- When a retry is needed, keep the same source inputs unless the validation evidence proves the input is wrong.
- If a UI has a visible retry button for a failed request, click that before sending a new prompt.

## Completion Rules

Before final response:

- Check every acceptance item.
- Summarize exactly what changed.
- List the verification commands or files inspected.
- State what could not be verified, if anything.
- Keep the answer short unless the user asked for detail.

