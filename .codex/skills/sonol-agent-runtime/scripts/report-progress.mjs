#!/usr/bin/env node
import { compactText, createEventId, logReportLifecycle, nowIso, parseFlagArgs, runWithRetryingStore } from "./_report-common.mjs";

const args = parseFlagArgs(process.argv.slice(2));
const required = ["planId", "runId", "agentId", "taskId", "stepIndex", "totalSteps", "state", "message"];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required flag: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    process.exit(1);
  }
}

const payload = {
  event_id: createEventId("progress_event", args.runId, args.agentId, args.taskId, args.stepIndex, args.totalSteps, args.state, args.message),
  plan_id: args.planId,
  run_id: args.runId,
  agent_id: args.agentId,
  task_id: args.taskId,
  step_index: Number(args.stepIndex),
  total_steps: Number(args.totalSteps),
  state: args.state,
  message: compactText(args.message, 96),
  detail: compactText(args.detail, 220),
  timestamp: nowIso(),
  schema_version: "1.0.0"
};

logReportLifecycle("attempt", "report-progress", {
  run_id: payload.run_id,
  agent_id: payload.agent_id,
  event_type: "progress_event",
  event_id: payload.event_id
});

try {
  runWithRetryingStore(args, "report-progress", (store) => {
    store.appendEvent("progress_event", payload);
  });
  logReportLifecycle("success", "report-progress", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "progress_event",
    event_id: payload.event_id
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  logReportLifecycle("failure", "report-progress", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "progress_event",
    event_id: payload.event_id,
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
