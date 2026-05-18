#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultAdapterConfig, launchRunWithAdapter, requireAdapter } from "../internal/core/sonol-adapters.mjs";
import { createRunSnapshot } from "../internal/core/sonol-run-snapshot.mjs";
import { hasExplicitAdapterConfigEnv, resolveAutoAdapterConfig, resolveMainProviderSessionIdentity } from "../internal/core/sonol-provider-session.mjs";
import { defaultDbPath, openStore } from "../internal/core/sonol-store.mjs";
import { isStructurallyMultiAgentPlan, validatePlanForAdapter } from "../internal/core/sonol-validation.mjs";

const adapterDefaults = defaultAdapterConfig();
const adapterExplicitFromEnv = hasExplicitAdapterConfigEnv();
const args = {
  dbPath: null,
  mode: "dry-run",
  adapterType: adapterDefaults.adapter_type,
  adapterBackend: adapterDefaults.adapter_backend,
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

function summarizeManualLaunch(adapterDispatch) {
  const candidates = Array.isArray(adapterDispatch?.manifest?.candidates) ? adapterDispatch.manifest.candidates : [];
  const labels = candidates
    .map((candidate) => {
      const promptFile = candidate?.packet?.runtime_prompt_file ?? null;
      return promptFile ? `${candidate.agent_id} -> ${promptFile}` : candidate.agent_id;
    })
    .join(" | ");
  return `Created a run and prepared its launch manifest. Do not use a fresh raw spawn prompt. Launch from the manifest using the run-scoped prompt files.${labels ? ` ${labels}` : ""}`;
}
let adapterExplicitFromCli = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--plan-id") {
    args.planId = process.argv[index + 1];
    index += 1;
  } else if (token === "--mode") {
    args.mode = process.argv[index + 1];
    index += 1;
  } else if (token === "--adapter-type") {
    args.adapterType = process.argv[index + 1];
    adapterExplicitFromCli = true;
    index += 1;
  } else if (token === "--adapter-backend") {
    args.adapterBackend = process.argv[index + 1];
    adapterExplicitFromCli = true;
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  }
}

if (!args.planId) {
  console.error("Usage: node create-run.mjs --plan-id <plan_id> [--mode dry-run|mock|live] [--workspace-root <workspace_root>] [--db path]");
  process.exit(1);
}

const effectiveAdapter = resolveAutoAdapterConfig({
  workspaceRoot: args.workspaceRoot,
  adapterType: args.adapterType,
  adapterBackend: args.adapterBackend,
  adapterExplicit: adapterExplicitFromCli || adapterExplicitFromEnv
});
args.adapterType = effectiveAdapter.adapter_type;
args.adapterBackend = effectiveAdapter.adapter_backend;

args.dbPath ??= defaultDbPath({ workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const plan = store.getPlan(args.planId);
if (!plan) {
  console.error(`Plan not found: ${args.planId}`);
  process.exit(1);
}

if (isStructurallyMultiAgentPlan(plan)) {
  console.error("Use confirm-plan.mjs for multi-agent launches so terminal confirmation remains the single launch authority.");
  process.exit(1);
}

const adapter = requireAdapter(args.adapterType, args.adapterBackend);
const adapterValidation = validatePlanForAdapter(plan, {
  provider: adapter.provider,
  adapter_type: args.adapterType,
  adapter_backend: args.adapterBackend
});
if (!adapterValidation.valid) {
  console.error("The plan execution target does not match the selected adapter.");
  for (const issue of adapterValidation.errors) {
    console.error(`- ${issue.message}`);
  }
  process.exit(1);
}

const activeRun = store.getActiveRunForPlan(plan.plan_id);
if (activeRun) {
  console.error(`Run creation blocked because an active run already exists for this plan: ${activeRun.run_id}`);
  process.exit(1);
}

const launchTimestamp = new Date().toISOString();
const snapshot = createRunSnapshot(plan, {
  mode: args.mode,
  adapter_type: args.adapterType,
  adapter_backend: args.adapterBackend
});
const queuedRun = store.saveRun({
  ...snapshot,
  provider_refs: {
    ...(snapshot.provider_refs ?? {}),
    ...resolveMainProviderSessionIdentity({
      workspaceRoot: args.workspaceRoot,
      adapterType: args.adapterType,
      adapterBackend: args.adapterBackend
    })
  },
  status: "queued",
  started_at: null
});
let adapterDispatch;
let run;
try {
  adapterDispatch = launchRunWithAdapter(store, queuedRun);
  const nextRunStatus = adapterDispatch?.dispatch_mode === "manifest_only" && adapterDispatch?.auto_launch_supported === false
    ? "prepared"
    : "running";
  run = store.updateRunStatus(queuedRun.run_id, nextRunStatus, {
    started_at: nextRunStatus === "running" ? launchTimestamp : null,
    ended_at: null,
    cancel_reason: null
  });
} catch (error) {
  try {
    store.updateRunStatus(queuedRun.run_id, "failed", {
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
  event_id: `session_updated_${run.run_id}_${Date.now()}`,
  plan_id: plan.plan_id,
  run_id: run.run_id,
  status: run.status,
  message: run.status === "prepared"
    ? "Created a run and prepared its launch manifest."
    : "Created and started a run from create-run.mjs.",
  detail: run.status === "prepared" ? summarizeManualLaunch(adapterDispatch) : "",
  timestamp: launchTimestamp,
  schema_version: "1.0.0"
});

const mainAgent = plan.agents.find((agent) => isMainAgent(agent));
if (mainAgent && (run.status === "running" || run.status === "prepared")) {
  const payload = {
    event_id: `session_updated_${run.run_id}_${mainAgent.agent_id}_${Date.now()}`,
    plan_id: plan.plan_id,
    run_id: run.run_id,
    agent_id: mainAgent.agent_id,
    status: run.status === "prepared" ? "queued" : "running",
    message: run.status === "prepared"
      ? "Waiting for manifest launch."
      : "Main coordination started.",
    detail: run.status === "prepared"
      ? summarizeManualLaunch(adapterDispatch)
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

process.stdout.write(`${JSON.stringify({ run, runtime_context: runtimeContext, adapter_dispatch: adapterDispatch }, null, 2)}\n`);
