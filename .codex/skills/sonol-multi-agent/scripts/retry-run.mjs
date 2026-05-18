#!/usr/bin/env node
import { resolve } from "node:path";
import { launchRunWithAdapter } from "../internal/core/sonol-adapters.mjs";
import { createRunSnapshot } from "../internal/core/sonol-run-snapshot.mjs";
import { resolveMainProviderSessionIdentity } from "../internal/core/sonol-provider-session.mjs";
import { defaultDbPath, openStore } from "../internal/core/sonol-store.mjs";
import { isStructurallyMultiAgentPlan } from "../internal/core/sonol-validation.mjs";

const args = {
  dbPath: null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd()
};

function normalizeExecutionClass(agent) {
  const explicit = String(agent?.execution_class ?? "").trim();
  if (explicit) {
    return explicit;
  }

  const legacyMap = {
    Main: "lead",
    Planner: "planner",
    Research: "research",
    Code: "implementer",
    Test: "verifier",
    Reviewer: "reviewer",
    Docs: "docs",
    Refactor: "refactor",
    Ops: "ops"
  };

  return legacyMap[String(agent?.role ?? "").trim()] ?? "general";
}

function isMainAgent(agent) {
  return normalizeExecutionClass(agent) === "lead" || agent?.role === "Main";
}

function resolveMainTaskId(plan) {
  return plan.tasks.find((task) => task.task_id === "task_main_integrate" || task.task_id === "task_single_execute")?.task_id ?? null;
}

function summarizeManualLaunch(previousRunId, adapterDispatch) {
  const candidates = Array.isArray(adapterDispatch?.manifest?.candidates) ? adapterDispatch.manifest.candidates : [];
  const labels = candidates
    .map((candidate) => {
      const promptFile = candidate?.packet?.runtime_prompt_file ?? null;
      return promptFile ? `${candidate.agent_id} -> ${promptFile}` : candidate.agent_id;
    })
    .join(" | ");
  return `Retry run prepared a launch manifest from ${previousRunId}. Do not use a fresh raw spawn prompt. Launch from the manifest using the run-scoped prompt files.${labels ? ` ${labels}` : ""}`;
}
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  }
}

if (!args.runId) {
  console.error("Usage: node retry-run.mjs --run-id <run_id> [--workspace-root <workspace_root>] [--db path]");
  process.exit(1);
}

args.dbPath ??= defaultDbPath({ workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const previousRun = store.getRun(args.runId);
if (!previousRun) {
  console.error(`Run not found: ${args.runId}`);
  process.exit(1);
}

const plan = store.getPlanForRun(previousRun);
if (!plan) {
  console.error(`Plan not found: ${previousRun.plan_id}`);
  process.exit(1);
}

if (isStructurallyMultiAgentPlan(plan)) {
  console.error("Multi-agent retry is disabled. Re-approve the plan in the dashboard, then type `승인` in the current Sonol terminal session.");
  process.exit(1);
}

const activeRun = store.getActiveRunForPlan(plan.plan_id);
if (activeRun) {
  console.error(`Retry blocked because an active run already exists for this plan: ${activeRun.run_id}`);
  process.exit(1);
}

const launchTimestamp = new Date().toISOString();
const snapshot = createRunSnapshot(plan, {
  mode: previousRun.mode,
  adapter_type: previousRun.adapter_type,
  adapter_backend: previousRun.adapter_backend,
  retry_of: previousRun.run_id
});
const queuedRetryRun = store.saveRun({
  ...snapshot,
  provider_refs: {
    ...(snapshot.provider_refs ?? {}),
    ...resolveMainProviderSessionIdentity({
      workspaceRoot: args.workspaceRoot,
      adapterType: previousRun.adapter_type,
      adapterBackend: previousRun.adapter_backend
    })
  },
  status: "queued",
  started_at: null
});
let adapterDispatch;
let retryRun;
try {
  adapterDispatch = launchRunWithAdapter(store, queuedRetryRun);
  const nextRunStatus = adapterDispatch?.dispatch_mode === "manifest_only" && adapterDispatch?.auto_launch_supported === false
    ? "prepared"
    : "running";
  retryRun = store.updateRunStatus(queuedRetryRun.run_id, nextRunStatus, {
    started_at: nextRunStatus === "running" ? launchTimestamp : null,
    ended_at: null,
    cancel_reason: null
  });
} catch (error) {
  try {
    store.updateRunStatus(queuedRetryRun.run_id, "failed", {
      ended_at: new Date().toISOString(),
      cancel_reason: "launch_failed"
    });
  } catch {
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const runtimeContext = adapterDispatch.runtime_context;
store.appendEvent("session_updated", {
  event_id: `session_updated_${retryRun.run_id}_${Date.now()}`,
  plan_id: plan.plan_id,
  run_id: retryRun.run_id,
  status: retryRun.status,
  message: retryRun.status === "prepared"
    ? `Retry run prepared a launch manifest from ${previousRun.run_id}.`
    : `Retry run started from ${previousRun.run_id}.`,
  detail: retryRun.status === "prepared"
    ? summarizeManualLaunch(previousRun.run_id, adapterDispatch)
    : "",
  timestamp: launchTimestamp,
  schema_version: "1.0.0"
});

const mainAgent = plan.agents.find((agent) => isMainAgent(agent));
if (mainAgent && (retryRun.status === "running" || retryRun.status === "prepared")) {
  const payload = {
    event_id: `session_updated_${retryRun.run_id}_${mainAgent.agent_id}_${Date.now()}`,
    plan_id: plan.plan_id,
    run_id: retryRun.run_id,
    agent_id: mainAgent.agent_id,
    status: retryRun.status === "prepared" ? "queued" : "running",
    message: retryRun.status === "prepared"
      ? "Waiting for manifest launch."
      : "Main coordination started.",
    detail: retryRun.status === "prepared"
      ? summarizeManualLaunch(previousRun.run_id, adapterDispatch)
      : "Preparing sub-agent launch and integration flow.",
    timestamp: launchTimestamp,
    schema_version: "1.0.0"
  };
  const mainTaskId = resolveMainTaskId(plan);
  if (mainTaskId) {
    payload.task_id = mainTaskId;
  }
  store.appendEvent("session_updated", payload, {
    internal_control: true
  });
}

process.stdout.write(`${JSON.stringify({ run: retryRun, runtime_context: runtimeContext, adapter_dispatch: adapterDispatch }, null, 2)}\n`);
