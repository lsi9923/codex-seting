import {
  buildOperatorMessage,
  detectPreferredLanguage,
  localize
} from "./sonol-language.mjs";
import {
  REMOTE_PLANNER_DRIVER,
  resolvePlannerConfig,
  resolvePlannerModel,
  validatePlannerConfig
} from "./sonol-planner-driver.mjs";
import { requestRemotePlannerDraft } from "./sonol-remote-planner.mjs";
import { loadCreativeDraft } from "./sonol-creative-draft.mjs";
import { dashboardUrlForWorkspace, getWorkspaceContext } from "./sonol-runtime-paths.mjs";
import { validatePlan } from "./sonol-validation.mjs";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function defaultDashboardUrl(options = {}) {
  return dashboardUrlForWorkspace({
    workspaceRoot: options.cwd ?? process.cwd(),
    preferEnv: false
  });
}

function createId(prefix, value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "item";
  return `${prefix}_${slug}_${Date.now().toString(36)}`;
}

function ensureArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function uniqueStrings(value) {
  return Array.from(
    new Set(
      ensureArray(value)
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    )
  );
}

function materializeRemotePlanTemplate(requestSummary, remotePlan, options = {}) {
  if (!remotePlan || typeof remotePlan !== "object" || Array.isArray(remotePlan)) {
    throw new Error("remote plan normalizer did not return a normalized plan object");
  }

  const workspace = getWorkspaceContext({ startDir: options.cwd });
  const preferredLanguage = remotePlan.preferred_language
    ?? options.preferredLanguage
    ?? detectPreferredLanguage(requestSummary, "ko");
  const createdAt = nowIso();
  const operatorDashboardUrl = normalizeText(
    options.operatorDashboardUrl ?? options.dashboardUrl,
    defaultDashboardUrl(options)
  );
  const authoritativeDbPath = options.authoritativeDbPath ?? process.env.SONOL_DB_PATH ?? "";
  const plannerConfig = resolvePlannerConfig({
    ...options,
    workspaceRoot: options.workspaceRoot ?? workspace.workspace_root
  });
  const plannerModel = resolvePlannerModel({
    ...options,
    plannerDriver: plannerConfig.planner_driver,
    workspaceRoot: options.workspaceRoot ?? workspace.workspace_root
  });
  const singleOrMulti = String(
    remotePlan.single_or_multi
    ?? (remotePlan.multi_agent_beneficial ? "multi" : "single")
  ).toLowerCase() === "multi"
    ? "multi"
    : "single";
  const isMulti = singleOrMulti === "multi";

  return {
    ...remotePlan,
    plan_id: normalizeText(remotePlan.plan_id, createId("plan", requestSummary)),
    plan_title: normalizeText(remotePlan.plan_title, requestSummary),
    workspace_id: workspace.workspace_id,
    workspace_root: workspace.workspace_root,
    request_summary: requestSummary,
    preferred_language: preferredLanguage,
    single_or_multi: singleOrMulti,
    multi_agent_beneficial: isMulti,
    recommendation_summary: normalizeText(
      remotePlan.recommendation_summary,
      isMulti
        ? localize(preferredLanguage, "여러 역할로 나눠 진행하는 편이 적합합니다.", "Multi-agent orchestration is the better fit.")
        : localize(preferredLanguage, "이번 요청은 일반 단일 흐름으로 진행하는 편이 낫습니다.", "This request is better handled in the normal single-agent flow.")
    ),
    recommendation_reasons: uniqueStrings(remotePlan.recommendation_reasons),
    operator_message: normalizeText(
      remotePlan.operator_message,
      buildOperatorMessage(isMulti ? "multi" : "single", operatorDashboardUrl, preferredLanguage)
    ),
    dashboard_url: operatorDashboardUrl,
    authoritative_db_path: authoritativeDbPath,
    agents: ensureArray(remotePlan.agents),
    tasks: ensureArray(remotePlan.tasks),
    dependency_edges: ensureArray(remotePlan.dependency_edges),
    approval_status: normalizeText(remotePlan.approval_status, isMulti ? "draft" : "ready"),
    dashboard_approval_status: normalizeText(remotePlan.dashboard_approval_status, isMulti ? "pending" : "not_needed"),
    terminal_confirmation_status: normalizeText(remotePlan.terminal_confirmation_status, isMulti ? "not_requested" : "not_required"),
    terminal_confirmation_required: isMulti,
    latest_editor: normalizeText(remotePlan.latest_editor, "system_recommendation"),
    context_version: Number.isInteger(remotePlan.context_version) ? remotePlan.context_version : 1,
    effective_max_threads: Number.isInteger(remotePlan.effective_max_threads)
      ? remotePlan.effective_max_threads
      : Math.max(1, ensureArray(remotePlan.agents).length),
    effective_max_depth: Number.isInteger(remotePlan.effective_max_depth)
      ? remotePlan.effective_max_depth
      : 1,
    planning_mode: normalizeText(remotePlan.planning_mode, "remote_normalized_local_creative_draft"),
    planning_backend: normalizeText(remotePlan.planning_backend, plannerConfig.planner_backend),
    planning_driver: normalizeText(remotePlan.planning_driver, plannerConfig.planner_driver),
    planner_selection_source: normalizeText(remotePlan.planner_selection_source, plannerConfig.planner_selection_source),
    remote_config_detected: plannerConfig.remote_config_detected,
    remote_config_complete: plannerConfig.remote_config_complete,
    planning_model: normalizeText(remotePlan.planning_model, plannerModel),
    created_at: normalizeText(remotePlan.created_at, createdAt),
    updated_at: createdAt
  };
}

export async function recommendPlanAutonomous(requestSummary, options = {}) {
  const preferredLanguage = options.preferredLanguage ?? detectPreferredLanguage(requestSummary, "ko");
  const workspaceRoot = options.workspaceRoot ?? options.cwd ?? process.cwd();
  const dashboardBridgeUrl = options.dashboardBridgeUrl ?? defaultDashboardUrl({ ...options, cwd: workspaceRoot });
  const plannerConfig = resolvePlannerConfig({
    ...options,
    workspaceRoot
  });
  const plannerConfigIssue = validatePlannerConfig(plannerConfig);
  if (plannerConfigIssue) {
    const error = new Error(plannerConfigIssue.message);
    error.code = plannerConfigIssue.error_code;
    error.details = plannerConfigIssue.details;
    throw error;
  }
  if (plannerConfig.planner_driver !== REMOTE_PLANNER_DRIVER) {
    throw new Error(`public/community edition requires ${REMOTE_PLANNER_DRIVER}`);
  }

  const creativeDraft = options.creativeDraft ?? loadCreativeDraft(options).draft;
  const remotePlan = await requestRemotePlannerDraft(requestSummary, {
    ...options,
    creativeDraft,
    preferredLanguage,
    workspaceRoot,
    dashboardBridgeUrl,
    operatorDashboardUrl: options.operatorDashboardUrl,
    plannerModel: resolvePlannerModel({
      ...options,
      plannerDriver: plannerConfig.planner_driver,
      workspaceRoot
    })
  });

  const plan = materializeRemotePlanTemplate(requestSummary, remotePlan, {
    ...options,
    preferredLanguage,
    workspaceRoot,
    dashboardUrl: options.operatorDashboardUrl ?? dashboardBridgeUrl
  });
  const validation = validatePlan(plan);
  if (!validation.valid) {
    const detail = validation.errors.map((issue) => issue.message).join("; ");
    throw new Error(`remote plan normalizer produced an invalid plan: ${detail}`);
  }
  return plan;
}
