#!/usr/bin/env node
import { compactText, createEventId, logReportLifecycle, nowIso, parseFlagArgs, runWithRetryingStore } from "./_report-common.mjs";

const args = parseFlagArgs(process.argv.slice(2));
const required = ["planId", "runId", "agentId", "taskId", "artifactType", "artifactRef", "summary"];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required flag: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    process.exit(1);
  }
}

const payload = {
  event_id: createEventId("artifact_event", args.runId, args.agentId, args.taskId, args.artifactType, args.artifactRef, args.summary),
  plan_id: args.planId,
  run_id: args.runId,
  agent_id: args.agentId,
  task_id: args.taskId,
  artifact_type: args.artifactType,
  artifact_ref: args.artifactRef,
  summary: compactText(args.summary, 140),
  detail: compactText(args.detail, 220),
  validation_status: args.validationStatus ?? "unchecked",
  timestamp: nowIso(),
  schema_version: "1.0.0"
};

logReportLifecycle("attempt", "report-artifact", {
  run_id: payload.run_id,
  agent_id: payload.agent_id,
  event_type: "artifact_event",
  event_id: payload.event_id
});

try {
  runWithRetryingStore(args, "report-artifact", (store) => {
    store.appendEvent("artifact_event", payload);
  });
  logReportLifecycle("success", "report-artifact", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "artifact_event",
    event_id: payload.event_id
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  logReportLifecycle("failure", "report-artifact", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "artifact_event",
    event_id: payload.event_id,
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
