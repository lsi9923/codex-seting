#!/usr/bin/env node
import { compactList, compactText, createEventId, logReportLifecycle, nowIso, parseFlagArgs, runWithRetryingStore } from "./_report-common.mjs";

const args = parseFlagArgs(process.argv.slice(2));
const required = ["planId", "runId", "agentId", "taskId", "result", "summary"];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required flag: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    process.exit(1);
  }
}

const payload = {
  event_id: createEventId("completion_event", args.runId, args.agentId, args.taskId, args.result, args.summary, args.nextActions ?? "", args.blockers ?? ""),
  plan_id: args.planId,
  run_id: args.runId,
  agent_id: args.agentId,
  task_id: args.taskId,
  result: args.result,
  summary: compactText(args.summary, 140),
  detail: compactText(args.detail, 220),
  blockers: compactList(args.blockers, 80),
  next_actions: compactList(args.nextActions, 80),
  timestamp: nowIso(),
  schema_version: "1.0.0"
};

logReportLifecycle("attempt", "report-completion", {
  run_id: payload.run_id,
  agent_id: payload.agent_id,
  event_type: "completion_event",
  event_id: payload.event_id
});

try {
  runWithRetryingStore(args, "report-completion", (store) => {
    store.appendEvent("completion_event", payload);
  });
  logReportLifecycle("success", "report-completion", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "completion_event",
    event_id: payload.event_id
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  logReportLifecycle("failure", "report-completion", {
    run_id: payload.run_id,
    agent_id: payload.agent_id,
    event_type: "completion_event",
    event_id: payload.event_id,
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
