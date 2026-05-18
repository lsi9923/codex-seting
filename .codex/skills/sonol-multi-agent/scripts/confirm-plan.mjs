#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultAdapterConfig, launchRunWithAdapter, requireAdapter } from "../internal/core/sonol-adapters.mjs";
import { writeDashboardAuthorityArtifacts } from "../internal/core/sonol-authority-artifacts.mjs";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { appendStructuredLog } from "../internal/core/sonol-log.mjs";
import { localize } from "../internal/core/sonol-language.mjs";
import { createRunSnapshot } from "../internal/core/sonol-run-snapshot.mjs";
import { hasExplicitAdapterConfigEnv, resolveAutoAdapterConfig, resolveMainProviderSessionIdentity } from "../internal/core/sonol-provider-session.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";
import { resolveSonolBinding } from "../internal/core/sonol-binding-resolver.mjs";
import { isStructurallyMultiAgentPlan, validatePlan, validatePlanForAdapter } from "../internal/core/sonol-validation.mjs";

const adapterDefaults = defaultAdapterConfig();
const adapterExplicitFromEnv = hasExplicitAdapterConfigEnv();
const args = {
  dbPath: null,
  mode: "live",
  adapterType: adapterDefaults.adapter_type,
  adapterBackend: adapterDefaults.adapter_backend,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  dashboardUrl: null,
  allowDbMismatch: false
};

let adapterExplicitFromCli = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--plan-id") {
    args.planId = process.argv[index + 1];
    index += 1;
  } else if (token === "--mode") {
    args.mode = process.argv[index + 1];
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--adapter-type") {
    args.adapterType = process.argv[index + 1];
    adapterExplicitFromCli = true;
    index += 1;
  } else if (token === "--adapter-backend") {
    args.adapterBackend = process.argv[index + 1];
    adapterExplicitFromCli = true;
    index += 1;
  } else if (token === "--language") {
    args.language = process.argv[index + 1];
    index += 1;
  } else if (token === "--dashboard-url") {
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--allow-db-mismatch") {
    args.allowDbMismatch = true;
  }
}

const effectiveAdapter = resolveAutoAdapterConfig({
  workspaceRoot: args.workspaceRoot,
  adapterType: args.adapterType,
  adapterBackend: args.adapterBackend,
  adapterExplicit: adapterExplicitFromCli || adapterExplicitFromEnv
});
args.adapterType = effectiveAdapter.adapter_type;
args.adapterBackend = effectiveAdapter.adapter_backend;

const authority = await resolveCliAuthoritativeBinding({
  workspaceRoot: args.workspaceRoot,
  dbPath: args.dbPath,
  dashboardUrl: args.dashboardUrl,
  startDir: process.cwd()
});
if (authority.authority_mismatch && !args.allowDbMismatch) {
  console.error(formatAuthorityMismatchMessage(authority));
  process.exit(1);
}
let binding = authority.binding;
args.dashboardUrl = authority.dashboard_url;
writeDashboardAuthorityArtifacts({
  binding,
  dashboardUrl: args.dashboardUrl,
  source: "confirm-plan"
});

let store = openStore(binding.db_path, {
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  startDir: binding.workspace_root ?? args.workspaceRoot,
  runtimeRoot: binding.runtime_root
});
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

function summarizeManualLaunch(run, adapterDispatch, language) {
  const candidates = Array.isArray(adapterDispatch?.manifest?.candidates) ? adapterDispatch.manifest.candidates : [];
  const rootDir = adapterDispatch?.runtime_context?.root_dir ?? null;
  const manifestFile = rootDir ? `${rootDir}/launch-manifest.json` : null;
  const authorityFile = rootDir ? `${rootDir}/authority.json` : null;
  const labels = candidates
    .map((candidate) => {
      const promptFile = candidate?.packet?.runtime_prompt_file ?? null;
      return promptFile ? `${candidate.agent_id} -> ${promptFile}` : candidate.agent_id;
    })
    .join(" | ");
  return localize(
    language,
    `이 실행은 manifest만 준비되었습니다. 일반 spawn_agent 프롬프트를 새로 쓰지 말고, launch manifest의 run-scoped prompt 파일로 실제 하위 에이전트를 시작하세요.${manifestFile ? ` manifest 파일: ${manifestFile}.` : ""}${authorityFile ? ` authority 파일: ${authorityFile}.` : ""}${labels ? ` ${labels}` : ""}`,
    `This run is only prepared. Do not write a fresh raw spawn_agent prompt. Launch the real sub-agents from the launch manifest using the run-scoped prompt files.${manifestFile ? ` Manifest file: ${manifestFile}.` : ""}${authorityFile ? ` Authority file: ${authorityFile}.` : ""}${labels ? ` ${labels}` : ""}`
  );
}
function canConfirmPlanCandidate(store, plan) {
  if (!plan || !isStructurallyMultiAgentPlan(plan) || plan.dashboard_approval_status !== "approved") {
    return false;
  }
  if (store.getActiveRunForPlan(plan.plan_id)) {
    return false;
  }
  if (plan.terminal_confirmation_status !== "confirmed") {
    return true;
  }
  return store.listRuns(plan.plan_id).length === 0;
}

if (!args.planId) {
  const workspaceState = store.getWorkspaceState?.() ?? null;
  const activePlanId = workspaceState?.active_plan_id ?? null;
  const activePlan = activePlanId ? store.getPlan(activePlanId) : null;
  if (canConfirmPlanCandidate(store, activePlan)) {
    args.planId = activePlan.plan_id;
  }
}

if (!args.planId) {
  const candidates = store
    .listPlans()
    .filter((plan) => canConfirmPlanCandidate(store, plan));

  if (candidates.length === 1) {
    args.planId = candidates[0].plan_id;
  } else if (candidates.length > 1) {
    const messageLanguage = args.language ?? "ko";
    console.error(localize(messageLanguage, "승인 대기 중인 계획이 여러 개입니다. --plan-id 를 명시해 주세요.", "Multiple approved plans are waiting. Provide --plan-id explicitly."));
    process.exit(1);
  }
}

if (!args.planId) {
  const messageLanguage = args.language ?? "ko";
  console.error(localize(messageLanguage, "대시보드에서 승인된 최신 구성을 찾지 못했습니다. 먼저 대시보드에서 구성을 승인해 주세요.", "Could not find the latest approved dashboard plan. Approve a plan in the dashboard first."));
  console.error("Usage: node confirm-plan.mjs [--plan-id <plan_id>] [--mode dry-run|mock|live] [--adapter-type <type>] [--adapter-backend <backend>] [--language ko|en] [--workspace-root <workspace_root>] [--db <path>] [--dashboard-url <url>] [--allow-db-mismatch]");
  console.error(localize(messageLanguage, "보통은 --workspace-root 만 넘기고 --db 는 생략하세요. 그러면 대시보드 health 와 plan.authoritative_db_path 를 따라 최신 바인딩으로 재해석합니다.", "Usually pass --workspace-root and omit --db. Then confirm-plan can follow dashboard health and plan.authoritative_db_path to rebind to the latest authority."));
  process.exit(1);
}

let plan = store.getPlan(args.planId);
if (
  plan?.authoritative_db_path
  && !args.dbPath
  && plan.authoritative_db_path !== binding.db_path
) {
  store.close();
  binding = resolveSonolBinding({
    workspaceRoot: args.workspaceRoot,
    dbPath: plan.authoritative_db_path,
    startDir: process.cwd()
  });
  store = openStore(binding.db_path, {
    workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
    startDir: binding.workspace_root ?? args.workspaceRoot,
    runtimeRoot: binding.runtime_root
  });
  writeDashboardAuthorityArtifacts({
    binding,
    dashboardUrl: args.dashboardUrl,
    source: "confirm-plan-rebind"
  });
  plan = store.getPlan(args.planId);
}
if (!plan) {
  console.error(localize(args.language, `계획을 찾을 수 없습니다: ${args.planId}`, `Plan not found: ${args.planId}`));
  process.exit(1);
}

const activeRun = store.getActiveRunForPlan(plan.plan_id);
if (activeRun) {
  console.error(localize(plan.preferred_language, `이미 진행 중인 실행이 있어 시작할 수 없습니다: ${activeRun.run_id}`, `Cannot launch because an active run already exists: ${activeRun.run_id}`));
  process.exit(1);
}

const requiresTerminalFlow = isStructurallyMultiAgentPlan(plan);

if (requiresTerminalFlow && plan.dashboard_approval_status !== "approved") {
  console.error(localize(plan.preferred_language, "터미널 확정 전에 대시보드 승인이 필요합니다.", "Dashboard approval is required before terminal confirmation."));
  process.exit(1);
}

const validation = validatePlan(plan);
if (!validation.valid) {
  console.error(localize(plan.preferred_language, "최신 대시보드 계획에 오류가 남아 있어 실행을 시작할 수 없습니다.", "The latest dashboard plan still has validation errors, so the run cannot start."));
  for (const issue of validation.errors) {
    console.error(`- ${issue.message}`);
  }
  process.exit(1);
}

const adapter = requireAdapter(args.adapterType, args.adapterBackend);
const adapterValidation = validatePlanForAdapter(plan, {
  provider: adapter.provider,
  adapter_type: args.adapterType,
  adapter_backend: args.adapterBackend
});
if (!adapterValidation.valid) {
  console.error(localize(plan.preferred_language, "계획의 실행 대상과 선택한 adapter가 맞지 않아 실행을 시작할 수 없습니다.", "The plan execution target does not match the selected adapter, so the run cannot start."));
  for (const issue of adapterValidation.errors) {
    console.error(`- ${issue.message}`);
  }
  process.exit(1);
}

let latestPlan = null;
let queuedRun = null;
let adapterDispatch;
let run;
const launchTimestamp = new Date().toISOString();
try {
  latestPlan = store.savePlan({
    ...plan,
    context_version: plan.context_version + 1,
    single_or_multi: requiresTerminalFlow ? "multi" : "single",
    multi_agent_beneficial: requiresTerminalFlow,
    approval_status: requiresTerminalFlow ? "approved" : "ready",
    terminal_confirmation_required: requiresTerminalFlow,
    terminal_confirmation_status: requiresTerminalFlow ? "confirmed" : "not_required",
    dashboard_approval_status: requiresTerminalFlow ? plan.dashboard_approval_status : "not_needed",
    latest_editor: "terminal_confirmation"
  }, {
    expectedContextVersion: plan.context_version
  });

  const snapshot = createRunSnapshot(latestPlan, {
    mode: args.mode,
    adapter_type: args.adapterType,
    adapter_backend: args.adapterBackend
  });
  queuedRun = store.saveRun({
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
  if (!latestPlan && error instanceof Error && error.message.startsWith("plan context conflict:")) {
    console.error(localize(plan.preferred_language, "대시보드 계획이 방금 바뀌었습니다. 새로고침 후 다시 확인해 주세요.", "The dashboard plan changed just now. Refresh and confirm again."));
    process.exit(1);
  }
  if (queuedRun) {
    try {
      store.updateRunStatus(queuedRun.run_id, "failed", {
        ended_at: new Date().toISOString(),
        cancel_reason: "launch_failed"
      });
    } catch {
    }
  }
  if (requiresTerminalFlow && latestPlan) {
    try {
      store.savePlan({
        ...latestPlan,
        context_version: latestPlan.context_version + 1,
        approval_status: "approved",
        terminal_confirmation_status: "pending",
        latest_editor: "terminal_confirmation_rollback"
      }, {
        expectedContextVersion: latestPlan.context_version
      });
    } catch {
    }
  }
  console.error(localize(plan.preferred_language, "실행 시작 준비 중 오류가 발생했습니다. 대시보드 승인은 유지되지만 터미널 확정은 되돌렸습니다.", "Failed while preparing the launch. Dashboard approval is kept, but terminal confirmation was rolled back."));
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const runtimeContext = adapterDispatch.runtime_context;
appendStructuredLog("sonol-runtime", {
  action: run.status === "prepared" ? "run_manifest_prepared" : "run_launched",
  run_id: run.run_id,
  plan_id: latestPlan.plan_id,
  dashboard_approval_status: latestPlan.dashboard_approval_status,
  terminal_confirmation_status: latestPlan.terminal_confirmation_status,
  runtime_context_root: runtimeContext.root_dir,
  dispatch_mode: adapterDispatch.dispatch_mode ?? null,
  expected_agents: latestPlan.agents.map((agent) => agent.agent_id)
});

store.appendEvent("plan_updated", {
  event_id: `plan_updated_${latestPlan.plan_id}_${Date.now()}`,
  plan_id: latestPlan.plan_id,
  approval_status: latestPlan.approval_status,
  message: run.status === "prepared"
    ? localize(latestPlan.preferred_language, "터미널 확정이 기록되었습니다. 최신 대시보드 상태로 실행 manifest를 준비했습니다.", "Terminal confirmation was recorded. The launch manifest was prepared from the latest dashboard state.")
    : localize(latestPlan.preferred_language, "터미널 확정이 기록되었습니다. 최신 대시보드 상태로 실행을 시작합니다.", "Terminal confirmation was recorded. Launching from the latest dashboard state."),
  timestamp: new Date().toISOString(),
  schema_version: "1.0.0"
});

store.appendEvent("session_updated", {
  event_id: `session_updated_${run.run_id}_${Date.now()}`,
  plan_id: latestPlan.plan_id,
  run_id: run.run_id,
  status: run.status,
  message: run.status === "prepared"
    ? localize(latestPlan.preferred_language, "실행 manifest가 준비되었습니다.", "The launch manifest has been prepared.")
    : localize(latestPlan.preferred_language, "새 실행이 시작되었습니다.", "A new run has started."),
  detail: run.status === "prepared"
    ? summarizeManualLaunch(run, adapterDispatch, latestPlan.preferred_language)
    : "",
  timestamp: launchTimestamp,
  schema_version: "1.0.0"
});

const mainAgent = latestPlan.agents.find((agent) => isMainAgent(agent));
if (mainAgent && (run.status === "running" || run.status === "prepared")) {
  const mainPayload = {
    event_id: `session_updated_${run.run_id}_${mainAgent.agent_id}_${Date.now()}`,
    plan_id: latestPlan.plan_id,
    run_id: run.run_id,
    agent_id: mainAgent.agent_id,
    status: run.status === "prepared" ? "queued" : "running",
    message: run.status === "prepared"
      ? localize(latestPlan.preferred_language, "manifest launch를 기다립니다.", "Waiting for manifest launch.")
      : localize(latestPlan.preferred_language, "전체 흐름을 조율하기 시작합니다.", "Starting overall coordination."),
    detail: run.status === "prepared"
      ? summarizeManualLaunch(run, adapterDispatch, latestPlan.preferred_language)
      : localize(latestPlan.preferred_language, "하위 에이전트 시작과 결과 통합 흐름을 준비합니다.", "Preparing sub-agent launch and integration flow."),
    timestamp: launchTimestamp,
    schema_version: "1.0.0"
  };
  const mainTaskId = resolveMainTaskId(latestPlan);
  if (mainTaskId) {
    mainPayload.task_id = mainTaskId;
  }
  store.appendEvent("session_updated", mainPayload, {
    internal_control: true
  });
}

process.stdout.write(`${JSON.stringify({ plan: latestPlan, run, runtime_context: runtimeContext, adapter_dispatch: adapterDispatch }, null, 2)}\n`);
