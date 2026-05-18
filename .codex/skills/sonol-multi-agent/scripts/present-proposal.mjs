import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recommendPlanAutonomous } from "../internal/core/sonol-autonomous-planner.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";
import { ensureDashboardReady } from "../internal/core/sonol-dashboard-launcher.mjs";
import { acquirePlannerLock } from "../internal/core/sonol-planner-lock.mjs";
import { localize } from "../internal/core/sonol-language.mjs";
import { resolvePlannerConfig, summarizePlannerConfig, validatePlannerConfig } from "../internal/core/sonol-planner-driver.mjs";
import { creativeDraftGuidance, loadCreativeDraft } from "../internal/core/sonol-creative-draft.mjs";
import { ensureDashboardBridgeToken, operatorDashboardUrlForWorkspace } from "../internal/core/sonol-dashboard-bridge.mjs";
import { writeDashboardAuthorityArtifacts } from "../internal/core/sonol-authority-artifacts.mjs";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { dashboardUrlForWorkspace } from "../internal/core/sonol-runtime-paths.mjs";
import { validateRequestSummaryInput } from "../internal/core/sonol-validation.mjs";

const startDashboardScript = fileURLToPath(new URL("./start-dashboard.mjs", import.meta.url));

const args = {
  dbPath: null,
  dashboardUrl: null,
  creativeDraftFile: process.env.SONOL_CREATIVE_DRAFT_FILE ?? null,
  creativeDraftBase64: process.env.SONOL_CREATIVE_DRAFT_BASE64 ?? null,
  creativeDraftJson: process.env.SONOL_CREATIVE_DRAFT_JSON ?? null,
  save: true,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  timeoutMs: 180000,
  allowDbMismatch: false
};
const positionalArgs = [];
const allowedFlags = new Set([
  "--db",
  "--dashboard-url",
  "--language",
  "--no-save",
  "--request-summary",
  "--workspace-root",
  "--timeout-ms",
  "--creative-draft-file",
  "--creative-draft-base64",
  "--creative-draft-json",
  "--allow-db-mismatch"
]);

function dashboardAttemptLines(language, dashboardState) {
  if (!Array.isArray(dashboardState?.launch_attempts) || dashboardState.launch_attempts.length === 0) {
    return [];
  }
  return dashboardState.launch_attempts.map((attempt) => {
    const launchLabel = attempt.started
      ? localize(language, "기동 요청됨", "launch requested")
      : localize(language, "기동 실패", "launch failed");
    const verificationLabel = attempt.health_reason
      ? `, ${localize(language, "검증", "verification")}: ${attempt.health_reason}`
      : "";
    return `${localize(language, "시도", "Attempt")}: ${attempt.strategy} - ${launchLabel}${verificationLabel} - ${attempt.detail ?? "-"}`;
  });
}

function dashboardGuidanceLines(plan, dashboardState) {
  const language = plan?.preferred_language;
  const strategyLine = dashboardState?.launch_strategy
    ? [`${localize(language, "자동 시작 전략", "Auto-launch strategy")}: ${dashboardState.launch_strategy}`]
    : [];
  const attemptLines = dashboardAttemptLines(language, dashboardState);
  const manualStartLine = `${localize(language, "수동 시작 명령", "Manual start command")}: ${dashboardState?.start_command ?? "-"}`;
  const dashboardUrlLine = localize(
    language,
    "먼저 위 대시보드 URL을 브라우저에서 직접 열어 실제로 접속되는지 확인하세요.",
    "First open the dashboard URL directly in a browser and confirm it actually loads."
  );
  const noAdhocPollingLine = localize(
    language,
    "별도의 `sleep`, `curl` 같은 임의 health 확인 명령은 만들지 마세요. `present-proposal.mjs` 출력과 대시보드 화면을 기준으로 판단하세요.",
    "Do not invent ad-hoc `sleep` or `curl` health checks. Use the `present-proposal.mjs` output and the dashboard UI as the source of truth."
  );
  const sameComputerLine = localize(
    language,
    "이 검토 링크는 같은 컴퓨터의 현재 Sonol 세션용입니다. 다른 컴퓨터에서는 열리지 않습니다.",
    "This review link only works on the same computer while the current Sonol session and local bridge are alive."
  );
  const originalLinkLine = localize(
    language,
    "검토용 원본 링크 전체(#bridge...)를 그대로 보관하세요. 대시보드의 plain 주소만 복사하면 브리지를 다시 부팅하지 못할 수 있습니다.",
    "Keep the full original review URL including the #bridge fragment. Copying only the plain dashboard address may not bootstrap the bridge again."
  );
  const sameTabReuseLine = localize(
    language,
    "이미 열려 있던 대시보드 탭이라도 원본 링크 전체(#bridge...)를 다시 붙여넣으면 현재 링크 기준으로 다시 초기화됩니다.",
    "Even in an already-open dashboard tab, pasting the full original review URL including #bridge should reinitialize the dashboard for the current link."
  );
  const firstLoadRetryLine = localize(
    language,
    "최초 접속부터 열리지 않으면 몇 초 뒤 같은 원본 링크를 다시 열어 보세요.",
    "If the dashboard does not open on first load, retry the same original review URL after a few seconds."
  );

  switch (dashboardState?.status) {
    case "already_running":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "현재 워크스페이스 바인딩으로 이미 준비됨", "Already ready with the current workspace binding.")}`,
        ...strategyLine,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine
      ];
    case "started":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "자동 기동 및 바인딩 확인 완료", "Started automatically and verified with the expected binding.")}`,
        ...strategyLine,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine
      ];
    case "started_unverified":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "자동 기동은 요청됐지만 현재 세션에서 readiness 확인이 끝나지 않았습니다.", "Automatic launch was requested, but readiness could not be confirmed from the current session.")}`,
        ...strategyLine,
        ...attemptLines,
        dashboardUrlLine,
        firstLoadRetryLine,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine,
        noAdhocPollingLine,
        manualStartLine,
        localize(
          language,
          "브라우저에서 열리지 않을 때만 위 명령을 새 터미널 같은 지속 세션에서 한 번 실행하세요.",
          "Only if the dashboard still does not open, run the manual start command once in a persistent session such as a new terminal."
        )
      ];
    case "started_wrong_binding":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "같은 포트의 대시보드는 응답했지만 다른 워크스페이스 또는 DB에 바인딩되어 있습니다.", "A dashboard responded on the same port, but it is bound to a different workspace or DB.")}`,
        ...strategyLine,
        ...attemptLines,
        dashboardUrlLine,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine,
        manualStartLine,
        localize(
          language,
          "충돌 중인 기존 대시보드 인스턴스를 정리한 뒤 위 명령으로 현재 워크스페이스 바인딩을 다시 기동하세요.",
          "Clear the conflicting dashboard instance, then rerun the manual start command for the current workspace binding."
        )
      ];
    case "no_launch_strategy":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "현재 호스트 세션에서는 자동 기동 전략을 사용할 수 없습니다.", "No automatic dashboard launch strategy is available in the current host session.")}`,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine,
        manualStartLine,
        localize(
          language,
          "위 명령을 새 터미널 같은 지속 세션에서 실행한 뒤 대시보드 URL을 여세요.",
          "Run the manual start command in a persistent session such as a new terminal, then open the dashboard URL."
        )
      ];
    case "non_local_dashboard":
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "원격 대시보드 URL에는 자동 기동을 적용하지 않습니다.", "Auto-launch is not supported for remote dashboard URLs.")}`
      ];
    case "launch_failed":
    default:
      return [
        `${localize(language, "대시보드 상태", "Dashboard status")}: ${localize(language, "자동 대시보드 기동에 실패했습니다.", "Automatic dashboard launch failed.")}`,
        ...strategyLine,
        ...attemptLines,
        sameComputerLine,
        originalLinkLine,
        sameTabReuseLine,
        manualStartLine,
        localize(
          language,
          "위 명령을 새 터미널 같은 지속 세션에서 실행한 뒤 대시보드 URL을 여세요.",
          "Run the manual start command in a persistent session such as a new terminal, then open the dashboard URL."
        ),
        noAdhocPollingLine
      ];
  }
}

function buildGuidance(errorCode, message, extra = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    expected_usage: [
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/present-proposal.mjs --creative-draft-file /abs/draft.json --workspace-root /abs/workspace --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/present-proposal.mjs --creative-draft-json '{\"plan_title\":\"Short title\",\"preferred_language\":\"ko\",\"single_or_multi\":\"multi\",\"multi_agent_beneficial\":true,\"recommendation_summary\":\"...\",\"recommendation_reasons\":[\"...\"],\"subagents\":[...]}' --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/present-proposal.mjs --creative-draft-file /abs/draft.json --language ko --workspace-root /abs/workspace --db /path/to/sonol.sqlite --timeout-ms 180000 --request-summary \"request summary\"",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/present-proposal.mjs --creative-draft-file /abs/draft.json --workspace-root /abs/workspace --db /path/to/sonol.sqlite --dashboard-url http://127.0.0.1:18081 --request-summary \"request summary\""
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
  if (token === "--db") {
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
  } else if (token === "--no-save") {
    args.save = false;
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
args.dashboardUrl = resolvedDashboardUrl;
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
const dashboardState = await ensureDashboardReady({
  dashboardUrl: resolvedDashboardUrl,
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  dbPath: binding.db_path,
  runtimeRoot: binding.runtime_root,
  scriptPath: startDashboardScript,
  expectedRemoteDashboardOrigin: operatorDashboardUrl ? new URL(operatorDashboardUrl).origin : ""
});

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
    source: "present-proposal"
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

  process.stderr.write(`${localize(
    args.language,
    "로컬 bridge 대시보드 준비가 끝났습니다. 로컬 AI 초안을 원격 정규화하는 동안 진행 로그를 표시합니다.",
    "The local dashboard bridge is ready. Progress logs will appear while the local AI draft is normalized remotely."
  )}\n`);

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
        message: localize(plan.preferred_language, "새 계획 초안을 만들었습니다.", "Created a new plan draft."),
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

if (!plan.multi_agent_beneficial) {
  process.stdout.write(
    [
    localize(plan.preferred_language, "단일 에이전트 권장", "single-agent recommended"),
    `${localize(plan.preferred_language, "계획 제목", "Plan title")}: ${plan.plan_title ?? plan.request_summary}`,
    plan.recommendation_summary,
    `${localize(plan.preferred_language, "플래너 backend", "Planner backend")}: ${plan.planning_backend}`,
    `${localize(plan.preferred_language, "플래너 driver", "Planner driver")}: ${plan.planning_driver}`,
    `${localize(plan.preferred_language, "정규화 경로 선택 출처", "Normalizer selection source")}: ${plan.planner_selection_source ?? "unknown"}`,
    `${localize(plan.preferred_language, "원격 정규화 설정 감지", "Remote normalizer config detected")}: ${plan.remote_config_detected ? "yes" : "no"}`,
    `${localize(plan.preferred_language, "원격 대시보드 URL", "Remote dashboard URL")}: ${plan.dashboard_url}`,
    `${localize(plan.preferred_language, "로컬 bridge URL", "Local bridge URL")}: ${resolvedDashboardUrl}`,
    `${localize(plan.preferred_language, "워크스페이스 ID", "Workspace ID")}: ${binding.workspace_id}`,
    `${localize(plan.preferred_language, "바인딩 ID", "Binding ID")}: ${binding.binding_id}`,
    `${localize(plan.preferred_language, "기준 DB", "Authoritative DB")}: ${plan.authoritative_db_path}`,
      ...dashboardGuidanceLines(plan, dashboardState),
      localize(plan.preferred_language, "사용자가 오케스트레이션을 명시적으로 원하지 않으면 일반 단일 에이전트 흐름으로 진행하세요.", "Proceed in the normal single-agent flow unless the user explicitly wants orchestration."),
      "",
      JSON.stringify(plan, null, 2)
    ].join("\n")
  );
  process.exit(0);
}

const roleLines = plan.agents.map((agent) =>
  [
    `- ${agent.role} (${agent.agent_id})`,
    `  provider_agent_type: ${agent.provider_agent_type ?? agent.codex_agent_type}`,
    `  model: ${agent.model}`,
    `  reasoning: ${agent.model_reasoning_effort}`,
    `  sandbox: ${agent.sandbox_mode}`,
    `  purpose: ${agent.purpose}`,
    `  skills: ${agent.skills_config.join(", ") || "none"}`,
    `  mcp_servers: ${agent.mcp_servers.join(", ") || "none"}`,
    `  read_paths: ${agent.read_paths.join(", ") || "none"}`,
    `  write_paths: ${agent.write_paths.join(", ") || "none"}`,
    `  deny_paths: ${agent.deny_paths.join(", ") || "none"}`,
    `  depends_on: ${agent.depends_on.join(", ") || "none"}`,
    `  constraints: ${agent.operational_constraints.join(" | ")}`
  ].join("\n")
).join("\n");

process.stdout.write(
  [
    localize(plan.preferred_language, "멀티 에이전트 권장", "multi-agent recommended"),
    `${localize(plan.preferred_language, "계획 제목", "Plan title")}: ${plan.plan_title ?? plan.request_summary}`,
    plan.recommendation_summary,
    `${localize(plan.preferred_language, "플래너 backend", "Planner backend")}: ${plan.planning_backend}`,
    `${localize(plan.preferred_language, "플래너 driver", "Planner driver")}: ${plan.planning_driver}`,
    `${localize(plan.preferred_language, "정규화 경로 선택 출처", "Normalizer selection source")}: ${plan.planner_selection_source ?? "unknown"}`,
    `${localize(plan.preferred_language, "원격 정규화 설정 감지", "Remote normalizer config detected")}: ${plan.remote_config_detected ? "yes" : "no"}`,
    `${localize(plan.preferred_language, "제안된 총 에이전트 수", "Proposed total agents")}: ${plan.agents.length}`,
    `${localize(plan.preferred_language, "유효 한도", "Effective limits")}: threads ${plan.effective_max_threads}, depth ${plan.effective_max_depth}`,
    localize(plan.preferred_language, "제안된 역할:", "Proposed roles:"),
    roleLines,
    `${localize(plan.preferred_language, "검토용 원격 대시보드 URL", "Remote dashboard review URL")}: ${plan.dashboard_url}`,
    `${localize(plan.preferred_language, "로컬 bridge URL", "Local bridge URL")}: ${resolvedDashboardUrl}`,
    `${localize(plan.preferred_language, "워크스페이스 ID", "Workspace ID")}: ${binding.workspace_id}`,
    `${localize(plan.preferred_language, "바인딩 ID", "Binding ID")}: ${binding.binding_id}`,
    `${localize(plan.preferred_language, "기준 DB", "Authoritative DB")}: ${plan.authoritative_db_path}`,
    ...dashboardGuidanceLines(plan, dashboardState),
    localize(plan.preferred_language, "먼저 대시보드에서 승인하세요. 그다음 현재 Sonol 터미널 세션에 승인이라고 입력하면 최신 대시보드 상태 기준으로 확정됩니다.", "Approve in the dashboard first. Then type `승인` in the current Sonol terminal session to confirm using the latest dashboard state."),
    "",
    JSON.stringify(plan, null, 2)
  ].join("\n")
);
