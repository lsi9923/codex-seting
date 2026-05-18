#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultDbPath, openStore } from "../internal/core/sonol-store.mjs";

const args = {
  dbPath: null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd()
};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--status") {
    args.status = process.argv[index + 1];
    index += 1;
  } else if (token === "--message") {
    args.message = process.argv[index + 1];
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  }
}

if (!args.runId || !args.status) {
  console.error("Usage: node set-run-status.mjs --run-id <run_id> --status <status> [--message text] [--workspace-root <workspace_root>] [--db path]");
  process.exit(1);
}

args.dbPath ??= defaultDbPath({ workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const run = store.updateRunStatus(args.runId, args.status, {});
const plan = store.getPlanForRun(run);
if (!["completed", "failed", "cancelled", "stale"].includes(run.status)) {
  store.appendEvent("session_updated", {
    event_id: `session_updated_${run.run_id}_${Date.now()}`,
    plan_id: plan?.plan_id ?? run.plan_id,
    run_id: run.run_id,
    status: run.status,
    message: args.message ?? `Run status changed to ${run.status}.`,
    timestamp: new Date().toISOString(),
    schema_version: "1.0.0"
  });
}

process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
