#!/usr/bin/env node
import { resolve } from "node:path";
import { recommendPlanAutonomous } from "../internal/core/sonol-autonomous-planner.mjs";
import { localize } from "../internal/core/sonol-language.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";
import { acquirePlannerLock } from "../internal/core/sonol-planner-lock.mjs";
import { resolvePlannerConfig, summarizePlannerConfig, validatePlannerConfig } from "../internal/core/sonol-planner-driver.mjs";
import { creativeDraftGuidance, loadCreativeDraft } from "../internal/core/sonol-creative-draft.mjs";
import { ensureDashboardBridgeToken, operatorDashboardUrlForWorkspace } from "../internal/core/sonol-dashboard-bridge.mjs";
import { writeDashboardAuthorityArtifacts } from "../internal/core/sonol-authority-artifacts.mjs";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { dashboardUrlForWorkspace } from "../internal/core/sonol-runtime-paths.mjs";
import { validateRequestSummaryInput } from "../internal/core/sonol-validation.mjs";

const args = {
  save: true,
  dbPath: null,
  dashboardUrl: null,
  creativeDraftFile: process.env.SONOL_CREATIVE_DRAFT_FILE ?? null,
  creativeDraftBase64: process.env.SONOL_CREATIVE_DRAFT_BASE64 ?? null,
  creativeDraftJson: process.env.SONOL_CREATIVE_DRAFT_JSON ?? null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  timeoutMs: 180000,
  allowDbMismatch: false
};
const positionalArgs = [];
const allowedFlags = new Set([
  "--no-save",
  "--db",
  "--dashboard-url",
  "--language",
  "--request-summary",
  "--workspace-root",
  "--timeout-ms",
  "--creative-draft-file",
  "--creative-draft-base64",
  "--creative-draft-json",
  "--allow-db-mismatch"
]);

function buildGuidance(errorCode, message, extra = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    expected_usage: [
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/recommend-plan.mjs --creative-draft-file /abs/draft.json --workspace-root /abs/workspace --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/recommend-plan.mjs --creative-draft-json '{\"plan_title\":\"Short title\",\"preferred_language\":\"ko\",\"single_or_multi\":\"multi\",\"multi_agent_beneficial\":true,\"recommendation_summary\":\"...\",\"recommendation_reasons\":[\"...\"],\"subagents\":[...]}' --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/recommend-plan.mjs --creative-draft-file /abs/draft.json --language ko --workspace-root /abs/workspace --db /path/to/sonol.sqlite --timeout-ms 180000 --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/recommend-plan.mjs --creative-draft-file /abs/draft.json --workspace-root /abs/workspace --db /path/to/sonol.sqlite --dashboard-url http://127.0.0.1:18081 --request-summary \"request summary\""
    ],
    rules: [
      "--request-summary is required",
      "A local creative draft is required via --creative-draft-file, --creative-draft-base64, --creative-draft-json, or SONOL_CREATIVE_DRAFT_FILE",
      "--workspace-root is recommended when running outside the current workspace",
      "--dashboard-url is an explicit override; omit it to use the workspace-derived dashboard URL",
      "Public/community edition uses the built-in hosted planner defaults while keeping the DB local",
      "Set SONOL_REMOTE_PLAN_NORMALIZER_URL and SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL only when overriding the default hosted planner",
      "SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN is optional and is only needed for restricted private deployments",
      "The local Codex/Claude side must author the creative draft. The hosted service only normalizes, validates, and binds execution.",
      "Before authoring a draft, open the creative draft schema or the checked-in example files.",
      "Positional request text is not allowed",
      "Do not pass flag-looking text as the request summary",
      "Use a non-empty natural-language request summary"
    ],
    ...extra
  };
}

function printGuidance(guidance) {
  console.error(guidance.message);
  console.error("");
  console.error("Expected format:");
  for (const line of guidance.expected_usage) {
    console.error(`- ${line}`);
  }
  console.error("");
  console.error(JSON.stringify(guidance, null, 2));
}

function failWithGuidance(errorCode, message, extra = {}) {
  const guidance = buildGuidance(errorCode, message, extra);
  printGuidance(guidance);
  process.exit(1);
}

class GuidanceSignal extends Error {
  constructor(guidance) {
    super(guidance?.message ?? "guidance required");
    this.name = "GuidanceSignal";
    this.guidance = guidance;
  }
}

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token.startsWith("--") && !allowedFlags.has(token)) {
    failWithGuidance("UNKNOWN_FLAG", `Unsupported flag: ${token}`, { unsupported_flag: token });
  }
  if (token === "--no-save") {
    args.save = false;
  } else if (token === "--db") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --db", { flag: "--db" });
    }
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--dashboard-url") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --dashboard-url", { flag: "--dashboard-url" });
    }
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--language") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --language", { flag: "--language" });
    }
    args.language = process.argv[index + 1];
    index += 1;
  } else if (token === "--request-summary") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_REQUEST_SUMMARY", "Missing value for --request-summary");
    }
    args.requestSummary = process.argv[index + 1];
    index += 1;
  } else if (token === "--workspace-root") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --workspace-root", { flag: "--workspace-root" });
    }
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--timeout-ms") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --timeout-ms", { flag: "--timeout-ms" });
    }
    args.timeoutMs = Number(process.argv[index + 1]);
    index += 1;
  } else if (token === "--creative-draft-file") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --creative-draft-file", { flag: "--creative-draft-file" });
    }
    args.creativeDraftFile = process.argv[index + 1];
    index += 1;
  } else if (token === "--creative-draft-base64") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --creative-draft-base64", { flag: "--creative-draft-base64" });
    }
    args.creativeDraftBase64 = process.argv[index + 1];
    index += 1;
  } else if (token === "--creative-draft-json") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --creative-draft-json", { flag: "--creative-draft-json" });
    }
    args.creativeDraftJson = process.argv[index + 1];
    index += 1;
  } else if (token === "--allow-db-mismatch") {
    args.allowDbMismatch = true;
  } else {
    positionalArgs.push(token);
  }
}

if (positionalArgs.length > 0) {
  failWithGuidance(
    "POSITIONAL_REQUEST_SUMMARY_NOT_ALLOWED",
    `Positional arguments are not allowed: ${positionalArgs.join(" ")}`,
    { positional_args: positionalArgs }
  );
}

const requestSummaryValidation = validateRequestSummaryInput(args.requestSummary);
if (!requestSummaryValidation.ok) {
  failWithGuidance(requestSummaryValidation.error_code, requestSummaryValidation.message, {
    received_request_summary: args.requestSummary ?? ""
  });
}
const requestSummary = requestSummaryValidation.normalized;
let creativeDraft = null;
try {
  ({ draft: creativeDraft } = loadCreativeDraft(args));
} catch (error) {
  if (error?.code === "CREATIVE_DRAFT_REQUIRED" || error?.code === "CREATIVE_DRAFT_INVALID") {
    failWithGuidance(error.code, error.message, {
      creative_draft: creativeDraftGuidance(),
      validation_errors: error.validation_errors ?? []
    });
  }
  throw error;
}
const authority = await resolveCliAuthoritativeBinding({
  workspaceRoot: args.workspaceRoot,
  dbPath: args.dbPath,
  dashboardUrl: args.dashboardUrl,
  startDir: process.cwd()
});
if (authority.authority_mismatch && !args.allowDbMismatch) {
  failWithGuidance("AUTHORITATIVE_DB_MISMATCH", formatAuthorityMismatchMessage(authority), {
    authority_mismatch: authority.authority_mismatch
  });
}
const binding = authority.binding;
const resolvedDashboardUrl = args.dashboardUrl ?? authority.dashboard_url ?? dashboardUrlForWorkspace({
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
const plannerConfig = resolvePlannerConfig({
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot
});
const plannerConfigIssue = validatePlannerConfig(plannerConfig);
if (plannerConfigIssue) {
  failWithGuidance(plannerConfigIssue.error_code, plannerConfigIssue.message, {
    planner_config: summarizePlannerConfig(plannerConfig)
  });
}

let plannerLock = null;
let plan = null;
let deferredGuidance = null;
let store = null;
let plannerJob = null;
try {
  plannerLock = acquirePlannerLock({
    workspaceRoot: binding.workspace_root ?? binding.workspace_id,
    requestSummary
  });
  if (!plannerLock.ok) {
    failWithGuidance("PLANNER_REQUEST_IN_PROGRESS", "A planner request for this workspace and request summary is already running.", {
      workspace_root: args.workspaceRoot,
      lock_path: plannerLock.lockPath,
      lock_metadata: plannerLock.metadata ?? null
    });
  }

  writeDashboardAuthorityArtifacts({
    binding,
    dashboardUrl: resolvedDashboardUrl,
    source: "recommend-plan"
  });

  store = args.save
    ? openStore(binding.db_path, {
        workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
        startDir: binding.workspace_root ?? args.workspaceRoot,
        runtimeRoot: binding.runtime_root
      })
    : null;

  if (store) {
    store.upsertWorkspaceRegistry?.({
      workspace_id: binding.workspace_id,
      workspace_root: binding.workspace_root,
      preferred_db_path: binding.db_path,
      preferred_runtime_root: binding.runtime_root,
      binding_id: binding.binding_id,
      source: binding.source
    });
    const planningClaim = store.claimPlanningRequest(requestSummary);
    if (!planningClaim?.ok) {
      throw new GuidanceSignal(buildGuidance(
        planningClaim.code,
        planningClaim.code === "DUPLICATE_PENDING_REQUEST"
          ? "The same planning request is already in progress."
          : "Another planning request is already in progress for this workspace.",
        {
          pending_request_summary: planningClaim.pending_request_summary ?? null
        }
      ));
    }
    plannerJob = store.createPlannerJob({
      workspace_id: binding.workspace_id,
      request_summary: requestSummary,
      planner_backend: plannerConfig.planner_backend,
      planner_driver: plannerConfig.planner_driver,
      binding_id: binding.binding_id,
      binding: {
        ...binding,
        planner_selection: summarizePlannerConfig(plannerConfig)
      },
      status: "queued"
    });
    plannerJob = store.claimPlannerJob(plannerJob.job_id);
    if (!plannerJob) {
      throw new Error("planner job could not be claimed");
    }
  }

  plan = await recommendPlanAutonomous(requestSummary, {
    dashboardBridgeUrl: resolvedDashboardUrl,
    operatorDashboardUrl,
    authoritativeDbPath: binding.db_path,
    preferredLanguage: args.language,
    cwd: binding.workspace_root ?? args.workspaceRoot,
    workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
    timeoutMs: args.timeoutMs,
    plannerDriver: plannerConfig.planner_driver,
    creativeDraft,
    creativeDraftFile: args.creativeDraftFile,
    creativeDraftBase64: args.creativeDraftBase64,
    creativeDraftJson: args.creativeDraftJson
  });

  if (store) {
    store.savePlan(plan);
    store.setActivePlan(plan.plan_id);
    store.completePlanningRequest(plan.plan_id);
    store.completePlannerJob(plannerJob.job_id, {
      result_plan_id: plan.plan_id
    });
    store.appendEvent("plan_updated", {
      event_id: `plan_updated_${plan.plan_id}_${Date.now()}`,
      plan_id: plan.plan_id,
      approval_status: plan.approval_status,
      message: localize(plan.preferred_language, "recommend-plan.mjs로 새 계획을 만들었습니다.", "Recommended a new plan from recommend-plan.mjs."),
      timestamp: new Date().toISOString(),
      schema_version: "1.0.0"
    });
  }
} catch (error) {
  if (error instanceof GuidanceSignal) {
    deferredGuidance = error.guidance;
  } else {
    if (store) {
      store.failPlanningRequest(error instanceof Error ? error.message : String(error));
      if (plannerJob?.job_id) {
        store.failPlannerJob(plannerJob.job_id, {
          error_code: "PLANNER_FAILED",
          error_message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    throw error;
  }
} finally {
  store?.close();
  plannerLock?.release?.();
}

if (deferredGuidance) {
  printGuidance(deferredGuidance);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
