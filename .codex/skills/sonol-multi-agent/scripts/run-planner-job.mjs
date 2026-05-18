#!/usr/bin/env node
import { resolve } from "node:path";
import { recommendPlanAutonomous } from "../internal/core/sonol-autonomous-planner.mjs";
import { resolveSonolBinding } from "../internal/core/sonol-binding-resolver.mjs";
import { resolvePlannerConfig, summarizePlannerConfig, validatePlannerConfig } from "../internal/core/sonol-planner-driver.mjs";
import { ensureDashboardBridgeToken, operatorDashboardUrlForWorkspace } from "../internal/core/sonol-dashboard-bridge.mjs";
import { dashboardUrlForWorkspace } from "../internal/core/sonol-runtime-paths.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";
import { localize } from "../internal/core/sonol-language.mjs";

const args = {
  jobId: null,
  dbPath: null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ?? process.cwd(),
  dashboardUrl: null,
  preferredLanguage: process.env.SONOL_PREFERRED_LANGUAGE ?? null,
  plannerDriver: process.env.SONOL_PLANNER_DRIVER ?? null,
  creativeDraftFile: process.env.SONOL_CREATIVE_DRAFT_FILE ?? null,
  creativeDraftBase64: process.env.SONOL_CREATIVE_DRAFT_BASE64 ?? null,
  creativeDraftJson: process.env.SONOL_CREATIVE_DRAFT_JSON ?? null
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--job-id") {
    args.jobId = process.argv[index + 1];
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--dashboard-url") {
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--language") {
    args.preferredLanguage = process.argv[index + 1];
    index += 1;
  } else if (token === "--planner-driver") {
    args.plannerDriver = process.argv[index + 1];
    index += 1;
  } else if (token === "--creative-draft-file") {
    args.creativeDraftFile = process.argv[index + 1];
    index += 1;
  } else if (token === "--creative-draft-base64") {
    args.creativeDraftBase64 = process.argv[index + 1];
    index += 1;
  } else if (token === "--creative-draft-json") {
    args.creativeDraftJson = process.argv[index + 1];
    index += 1;
  }
}

if (!args.jobId) {
  console.error("Usage: node run-planner-job.mjs --job-id <job_id> [--workspace-root <workspace_root>] [--db <db_path>] [--dashboard-url <url>] [--language ko|en] [--planner-driver <driver>] [--creative-draft-file <path>]");
  process.exit(1);
}

const plannerConfig = resolvePlannerConfig({
  plannerDriver: args.plannerDriver,
  workspaceRoot: args.workspaceRoot
});
const plannerConfigIssue = validatePlannerConfig(plannerConfig);

const binding = resolveSonolBinding({
  workspaceRoot: args.workspaceRoot,
  dbPath: args.dbPath,
  startDir: args.workspaceRoot
});
const resolvedDashboardUrl = args.dashboardUrl ?? dashboardUrlForWorkspace({
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  startDir: binding.workspace_root ?? args.workspaceRoot,
  preferEnv: false
});
const bridgeToken = ensureDashboardBridgeToken({
  runtimeRoot: binding.runtime_root,
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  dashboardUrl: resolvedDashboardUrl,
  bindingId: binding.binding_id,
  rotate: true
});
const operatorDashboardUrl = operatorDashboardUrlForWorkspace({
  runtimeRoot: binding.runtime_root,
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  bridgeUrl: resolvedDashboardUrl,
  bridgeToken,
  workspaceId: binding.workspace_id,
  bindingId: binding.binding_id
});

const store = openStore(binding.db_path, {
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  startDir: binding.workspace_root ?? args.workspaceRoot,
  runtimeRoot: binding.runtime_root
});

function normalizeComparablePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function plannerJobBindingMatches(job, nextBinding) {
  if (job?.workspace_id && nextBinding?.workspace_id && job.workspace_id !== nextBinding.workspace_id) {
    return false;
  }
  if (job?.binding_id && nextBinding?.binding_id && job.binding_id !== nextBinding.binding_id) {
    return false;
  }
  const existingWorkspaceRoot = normalizeComparablePath(job?.binding?.workspace_root);
  const nextWorkspaceRoot = normalizeComparablePath(nextBinding?.workspace_root);
  if (existingWorkspaceRoot && nextWorkspaceRoot && existingWorkspaceRoot !== nextWorkspaceRoot) {
    return false;
  }
  const existingDbPath = normalizeComparablePath(job?.binding?.db_path);
  const nextDbPath = normalizeComparablePath(nextBinding?.db_path);
  if (existingDbPath && nextDbPath && existingDbPath !== nextDbPath) {
    return false;
  }
  return true;
}

try {
  if (plannerConfigIssue) {
    const error = new Error(plannerConfigIssue.message);
    error.code = plannerConfigIssue.error_code;
    error.details = summarizePlannerConfig(plannerConfig);
    throw error;
  }
  const initialJob = store.getPlannerJob(args.jobId);
  if (!initialJob) {
    throw new Error(`planner job not found: ${args.jobId}`);
  }
  if (!plannerJobBindingMatches(initialJob, binding)) {
    throw new Error(`planner job binding mismatch for ${args.jobId}; refusing to run with the current workspace/db binding`);
  }

  const job = store.claimPlannerJob(args.jobId);
  if (!job) {
    process.exit(0);
  }

  store.updatePlannerJob(job.job_id, {
    planner_backend: plannerConfig.planner_backend,
    planner_driver: plannerConfig.planner_driver,
    binding_id: binding.binding_id,
    binding: {
      ...binding,
      planner_selection: summarizePlannerConfig(plannerConfig)
    }
  });

  const plan = await recommendPlanAutonomous(job.request_summary, {
    dashboardBridgeUrl: resolvedDashboardUrl,
    operatorDashboardUrl,
    authoritativeDbPath: binding.db_path,
    preferredLanguage: args.preferredLanguage ?? undefined,
    cwd: binding.workspace_root ?? args.workspaceRoot,
    workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
    plannerDriver: plannerConfig.planner_driver,
    creativeDraftFile: args.creativeDraftFile,
    creativeDraftBase64: args.creativeDraftBase64,
    creativeDraftJson: args.creativeDraftJson
  });
  store.touchPlannerJob(job.job_id);

  const savedPlan = store.savePlan(plan);
  store.setActivePlan(savedPlan.plan_id);
  store.completePlanningRequest(savedPlan.plan_id);
  store.completePlannerJob(job.job_id, {
    result_plan_id: savedPlan.plan_id
  });
  store.appendEvent("plan_updated", {
    event_id: `plan_updated_${savedPlan.plan_id}_${Date.now()}`,
    plan_id: savedPlan.plan_id,
    approval_status: savedPlan.approval_status,
    message: localize(savedPlan.preferred_language, "planner job이 새 계획 초안을 만들었습니다.", "The planner job created a new plan draft."),
    timestamp: new Date().toISOString(),
    schema_version: "1.0.0"
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /timed out/i.test(message) ? "PLANNER_TIMED_OUT" : "PLANNER_FAILED";
  try {
    store.failPlanningRequest(message);
    store.failPlannerJob(args.jobId, {
      status: code === "PLANNER_TIMED_OUT" ? "timed_out" : "failed",
      error_code: code,
      error_message: message
    });
  } catch {
  }
  console.error(message);
  process.exit(1);
} finally {
  store.close();
}
