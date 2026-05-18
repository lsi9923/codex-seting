#!/usr/bin/env node
import { compactText, createEventId, logReportLifecycle, nowIso, parseFlagArgs, runWithRetryingStore } from "./_report-common.mjs";

const args = parseFlagArgs(process.argv.slice(2));
const required = ["planId", "runId", "agentId", "status", "message"];
for (const key of required) {
  if (!args[key]) {
    console.error(`Missing required flag: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    process.exit(1);
  }
}

const payload = {
  event_id: createEventId("session_updated", args.runId, args.agentId ?? "system", args.taskId, args.status, args.message, args.blockedReason ?? ""),
  plan_id: args.planId,
  run_id: args.runId,
  agent_id: args.agentId,
  task_id: args.taskId,
  status: args.status,
  message: compactText(args.message, 96),
  detail: compactText(args.detail, 220),
  blocked_reason: compactText(args.blockedReason, 96),
  timestamp: nowIso(),
  schema_version: "1.0.0"
};

logReportLifecycle("attempt", "report-session", {
  run_id: payload.run_id,
  agent_id: payload.agent_id ?? "system",
  event_type: "session_updated",
  event_id: payload.event_id,
  status: payload.status
});

try {
  runWithRetryingStore(args, "report-session", (store) => {
    store.appendEvent("session_updated", payload);
  });
  logReportLifecycle("success", "report-session", {
    run_id: payload.run_id,
    agent_id: payload.agent_id ?? "system",
    event_type: "session_updated",
    event_id: payload.event_id,
    status: payload.status
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  logReportLifecycle("failure", "report-session", {
    run_id: payload.run_id,
    agent_id: payload.agent_id ?? "system",
    event_type: "session_updated",
    event_id: payload.event_id,
    status: payload.status,
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
