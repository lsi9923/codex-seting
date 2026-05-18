import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { buildAgentPacketForRun, buildLaunchManifestForRun, cancelRunWithAdapter, collectAdapterStatusForRun, defaultAdapterConfig, getAdapterCapabilities, launchRunWithAdapter, listAdapters, prepareRunContextForRun } from "../core/sonol-adapters.mjs";
import { resolveSonolBinding, sanitizedBinding } from "../core/sonol-binding-resolver.mjs";
import {
  ensureDashboardBridgeToken,
  operatorDashboardUrlForWorkspace,
  readDashboardBridgeTokenRecord,
  remoteDashboardOrigin
} from "../core/sonol-dashboard-bridge.mjs";
import { collectRunDiagnostics } from "../core/sonol-diagnostics.mjs";
import { localize, normalizePreferredLanguage, SUPPORTED_LANGUAGES } from "../core/sonol-language.mjs";
import { resolvePlannerConfig, summarizePlannerConfig, validatePlannerConfig } from "../core/sonol-planner-driver.mjs";
import { dashboardHost, dashboardPortForWorkspace, dashboardUrlForWorkspace, defaultLogDir } from "../core/sonol-runtime-paths.mjs";
import { openStore, openStoreWithOptions } from "../core/sonol-store.mjs";
import { createRunSnapshot } from "../core/sonol-run-snapshot.mjs";
import { isStructurallyMultiAgentPlan, validatePlan, validatePlanForAdapter, validateRequestSummaryInput } from "../core/sonol-validation.mjs";

const ROOT_DIR = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const FRONTEND_DIST_DIR = resolve(fileURLToPath(new URL("./dist", import.meta.url)));
const BINDING = resolveSonolBinding({
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ?? null,
  dbPath: process.env.SONOL_DB_PATH ?? null,
  runtimeRoot: process.env.SONOL_RUNTIME_ROOT ?? null,
  startDir: process.cwd()
});
const HOST = dashboardHost({ preferEnv: true });
const PORT = dashboardPortForWorkspace({
  workspaceRoot: BINDING.workspace_root ?? process.cwd(),
  preferEnv: true
});
const DB_PATH = BINDING.db_path;
const DASHBOARD_URL = dashboardUrlForWorkspace({
  workspaceRoot: BINDING.workspace_root ?? process.cwd(),
  host: HOST,
  port: PORT,
  preferEnv: true
});
const REMOTE_DASHBOARD_ORIGIN = remoteDashboardOrigin({
  runtimeRoot: BINDING.runtime_root,
  workspaceRoot: BINDING.workspace_root ?? process.cwd()
});
ensureDashboardBridgeToken({
  runtimeRoot: BINDING.runtime_root,
  workspaceRoot: BINDING.workspace_root ?? process.cwd(),
  dashboardUrl: DASHBOARD_URL,
  bindingId: BINDING.binding_id
});
const WORKSPACE_CONTEXT = {
  workspace_id: BINDING.workspace_id,
  workspace_root: BINDING.workspace_root
};
const SERVER_WORKSPACE_ROOT = BINDING.workspace_root ?? process.cwd();
const EXPOSE_BINDING_PATHS = process.env.SONOL_EXPOSE_PATHS === "1";
const ADAPTER_DEFAULTS = defaultAdapterConfig({ workspaceRoot: BINDING.workspace_root ?? process.cwd() });

const PROVIDER_COMPATIBLE_FIELDS = [
  "provider_agent_type",
  "custom_agent_name",
  "custom_config_file",
  "developer_instructions",
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
  "mcp_servers",
  "skills_config",
  "nickname_candidates",
  "approval_mode",
  "communication_mode"
];

const COMPATIBILITY_ALIAS_FIELDS = [
  "codex_agent_type"
];

const SONOL_ENFORCED_FIELDS = [
  "depends_on",
  "reporting_contract",
  "operational_constraints"
];

const ADVISORY_FIELDS = [
  "read_paths",
  "write_paths",
  "deny_paths"
];

const UNSUPPORTED_CONTROL_ASSUMPTIONS = [
  "dashboard_terminal_injection",
  "dashboard_direct_thread_control",
  "public_spawn_handle_api",
  "public_send_input_api",
  "recursive_child_subagents"
];

const DASHBOARD_LOG_PATH = resolve(
  defaultLogDir({ workspaceRoot: SERVER_WORKSPACE_ROOT, startDir: SERVER_WORKSPACE_ROOT }),
  `sonol-dashboard-${new Date().toISOString().slice(0, 10)}.jsonl`
);
const WORKSPACE_ARTIFACT_IGNORE_DIRS = new Set([
  ".git",
  ".sonol",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);
const workspaceArtifactBaselines = new Map();
let invalidBindingPollCount = 0;

function writeDashboardLog(action, payload = {}) {
  try {
    appendFileSync(
      DASHBOARD_LOG_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        kind: "sonol-dashboard",
        action,
        ...payload
      })}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("dashboard log write failed", error);
  }
}

function shouldIgnoreWorkspaceArtifactPath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => WORKSPACE_ARTIFACT_IGNORE_DIRS.has(part))) {
    return true;
  }
  return normalized.startsWith(".sonol_fix/");
}

function snapshotWorkspaceFiles(rootDir, currentDir = rootDir, files = new Map()) {
  let entries = [];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = resolve(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);
    if (!relPath || shouldIgnoreWorkspaceArtifactPath(relPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      snapshotWorkspaceFiles(rootDir, fullPath, files);
      continue;
    }
    try {
      const stats = statSync(fullPath);
      files.set(relPath, { mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
    }
  }

  return files;
}

function isLiveRunStatus(status) {
  return ["queued", "prepared", "running", "blocked"].includes(status);
}

function appendWorkspaceArtifactEvent(store, { run, plan, relPath, changeType }) {
  const mainAgent = plan.agents.find((agent) => agent.agent_id === "agent_main");
  const taskId = mainAgent?.current_task_id ?? resolveMainTaskId(plan) ?? "task_main_integrate";
  const normalizedRef = relPath.replace(/\\/g, "/");
  const timestamp = new Date().toISOString();
  const eventId = [
    "artifact",
    run.run_id,
    "agent_main",
    taskId,
    changeType,
    normalizedRef.replace(/[^a-zA-Z0-9._/-]+/g, "_"),
    Date.now()
  ].join("_");

  const summaryMap = {
    created: `파일 생성 감지: ${normalizedRef}`,
    updated: `파일 변경 감지: ${normalizedRef}`,
    deleted: `파일 삭제 감지: ${normalizedRef}`
  };

  store.appendEvent("artifact_event", {
    event_id: eventId,
    plan_id: plan.plan_id,
    run_id: run.run_id,
    agent_id: "agent_main",
    task_id: taskId,
    artifact_type: "file",
    artifact_ref: normalizedRef,
    summary: summaryMap[changeType] ?? `파일 변경 감지: ${normalizedRef}`,
    detail: `Dashboard workspace poller recorded a ${changeType} file event for main-agent visibility.`,
    validation_status: "unchecked",
    timestamp,
    schema_version: "1.0.0"
  });
}

function syncWorkspaceArtifactEvents() {
  try {
    withStore((store) => {
      const liveRuns = store
        .listRuns()
        .filter((run) => isLiveRunStatus(run.status))
        .map((run) => ({ run, plan: store.getPlanForRun(run) }))
        .filter(({ plan }) => plan?.agents?.some((agent) => agent.agent_id === "agent_main"));

      const liveRunIds = new Set(liveRuns.map(({ run }) => run.run_id));
      for (const trackedRunId of workspaceArtifactBaselines.keys()) {
        if (!liveRunIds.has(trackedRunId)) {
          workspaceArtifactBaselines.delete(trackedRunId);
        }
      }

      if (liveRuns.length === 0) {
        return;
      }

      const nextSnapshot = snapshotWorkspaceFiles(SERVER_WORKSPACE_ROOT);
      for (const { run, plan } of liveRuns) {
        const previousSnapshot = workspaceArtifactBaselines.get(run.run_id);
        if (!previousSnapshot) {
          workspaceArtifactBaselines.set(run.run_id, nextSnapshot);
          continue;
        }

        const changes = [];
        for (const [relPath, nextMeta] of nextSnapshot.entries()) {
          const previousMeta = previousSnapshot.get(relPath);
          if (!previousMeta) {
            changes.push({ relPath, changeType: "created" });
            continue;
          }
          if (previousMeta.mtimeMs !== nextMeta.mtimeMs || previousMeta.size !== nextMeta.size) {
            changes.push({ relPath, changeType: "updated" });
          }
        }

        for (const relPath of previousSnapshot.keys()) {
          if (!nextSnapshot.has(relPath)) {
            changes.push({ relPath, changeType: "deleted" });
          }
        }

        if (changes.length > 0) {
          for (const change of changes) {
            appendWorkspaceArtifactEvent(store, {
              run,
              plan,
              relPath: change.relPath,
              changeType: change.changeType
            });
          }
          writeDashboardLog("workspace_artifact_events_recorded", {
            run_id: run.run_id,
            count: changes.length,
            sample: changes.slice(0, 5)
          });
        }

        workspaceArtifactBaselines.set(run.run_id, nextSnapshot);
      }
    });
  } catch (error) {
    writeDashboardLog("workspace_artifact_poll_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getContentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function sendFile(response, filePath) {
  response.writeHead(200, { "content-type": getContentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function resolveFrontendFile(pathname) {
  const cleanPath = decodeURIComponent(pathname.split("?")[0] || "/");

  if (cleanPath === "/" || cleanPath === "/index.html") {
    const indexFile = resolve(FRONTEND_DIST_DIR, "index.html");
    return isFile(indexFile) ? indexFile : null;
  }

  const relativePath = cleanPath.replace(/^\/+/, "");
  const assetFile = resolve(FRONTEND_DIST_DIR, relativePath);
  return isFile(assetFile) ? assetFile : null;
}

if (!isFile(resolve(FRONTEND_DIST_DIR, "index.html"))) {
  console.warn(`sonol dashboard dist is missing at ${FRONTEND_DIST_DIR}. Restore the bundled dist assets under sonol-multi-agent/internal/dashboard/dist.`);
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function launchPlannerWorker(jobId, preferredLanguage) {
  const plannerConfig = resolvePlannerConfig({
    workspaceRoot: SERVER_WORKSPACE_ROOT
  });
  const workerScript = resolve(ROOT_DIR, "skills", "sonol-multi-agent", "scripts", "run-planner-job.mjs");
  const child = spawn(
    process.execPath,
    [
      workerScript,
      "--job-id",
      jobId,
      "--db",
      BINDING.db_path,
      "--workspace-root",
      SERVER_WORKSPACE_ROOT,
      "--dashboard-url",
      DASHBOARD_URL,
      "--language",
      preferredLanguage,
      "--planner-driver",
      plannerConfig.planner_driver
    ],
    {
      cwd: SERVER_WORKSPACE_ROOT,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SONOL_DB_PATH: BINDING.db_path,
        SONOL_WORKSPACE_ROOT: SERVER_WORKSPACE_ROOT,
        SONOL_RUNTIME_ROOT: BINDING.runtime_root,
        SONOL_INSTALL_ROOT: BINDING.install_root,
        SONOL_DASHBOARD_URL: DASHBOARD_URL,
        SONOL_PREFERRED_LANGUAGE: preferredLanguage,
        SONOL_PLANNER_DRIVER: plannerConfig.planner_driver
      }
    }
  );
  const rollbackPlannerLaunch = (message, code = "PLANNER_WORKER_LAUNCH_FAILED") => {
    try {
      withStore((store) => {
        const job = store.getPlannerJob(jobId);
        if (!job || !["queued", "running"].includes(job.status)) {
          return null;
        }
        store.updatePlannerJob(jobId, {
          status: "failed",
          ended_at: new Date().toISOString(),
          error_code: code,
          error_message: message
        });
        store.failPlanningRequest(message);
        return true;
      });
      broadcastSnapshot();
    } catch {
    }
  };
  child.once("error", (error) => {
    rollbackPlannerLaunch(
      `planner worker failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  child.once("exit", (code, signal) => {
    setTimeout(() => {
      rollbackPlannerLaunch(
        `planner worker exited before claim (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        "PLANNER_WORKER_EARLY_EXIT"
      );
    }, 1500);
  });
  child.unref();
}

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

function summarizeManualLaunch(plan, adapterDispatch, prefix) {
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
    plan.preferred_language,
    `${prefix} 새로운 raw spawn 프롬프트를 쓰지 말고, launch manifest의 run-scoped prompt 파일로 실제 하위 에이전트를 시작하세요.${manifestFile ? ` manifest 파일: ${manifestFile}.` : ""}${authorityFile ? ` authority 파일: ${authorityFile}.` : ""}${labels ? ` ${labels}` : ""}`,
    `${prefix} Do not write a fresh raw spawn prompt. Launch the real sub-agents from the launch manifest using the run-scoped prompt files.${manifestFile ? ` Manifest file: ${manifestFile}.` : ""}${authorityFile ? ` Authority file: ${authorityFile}.` : ""}${labels ? ` ${labels}` : ""}`
  );
}

function withStore(callback) {
  const store = openStore(DB_PATH, {
    workspaceRoot: SERVER_WORKSPACE_ROOT,
    startDir: SERVER_WORKSPACE_ROOT,
    runtimeRoot: BINDING.runtime_root
  });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function withReadStore(callback) {
  const store = openStoreWithOptions(DB_PATH, {
    readOnly: true,
    workspaceRoot: SERVER_WORKSPACE_ROOT,
    startDir: SERVER_WORKSPACE_ROOT,
    runtimeRoot: BINDING.runtime_root
  });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data, null, 2));
}

function requestOrigin(request) {
  return String(request.headers.origin ?? "").trim();
}

function isLocalOrigin(origin) {
  return origin === ""
    || origin === DASHBOARD_URL
    || origin === DASHBOARD_URL.replace("127.0.0.1", "localhost")
    || origin === DASHBOARD_URL.replace("localhost", "127.0.0.1");
}

function isAllowedBridgeOrigin(origin) {
  return isLocalOrigin(origin) || (REMOTE_DASHBOARD_ORIGIN && origin === REMOTE_DASHBOARD_ORIGIN);
}

function applyBridgeCors(request, response) {
  const origin = requestOrigin(request);
  if (!origin || !isAllowedBridgeOrigin(origin)) {
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  const wantsPrivateNetwork = String(request.headers["access-control-request-private-network"] ?? "").trim().toLowerCase() === "true";
  response.setHeader(
    "Vary",
    wantsPrivateNetwork
      ? "Origin, Access-Control-Request-Private-Network"
      : "Origin"
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sonol-Bridge-Token");
  response.setHeader("Access-Control-Allow-Credentials", "false");
  response.setHeader("Access-Control-Max-Age", "600");
  if (wantsPrivateNetwork) {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function isRemoteBridgeRequest(request) {
  const origin = requestOrigin(request);
  return Boolean(origin && REMOTE_DASHBOARD_ORIGIN && origin === REMOTE_DASHBOARD_ORIGIN);
}

function currentBridgeToken() {
  return readDashboardBridgeTokenRecord({
    runtimeRoot: BINDING.runtime_root,
    workspaceRoot: BINDING.workspace_root ?? process.cwd()
  })?.token ?? "";
}

function currentOperatorDashboardUrl() {
  return operatorDashboardUrlForWorkspace({
    runtimeRoot: BINDING.runtime_root,
    workspaceRoot: BINDING.workspace_root ?? process.cwd(),
    bridgeUrl: DASHBOARD_URL,
    bridgeToken: currentBridgeToken(),
    workspaceId: BINDING.workspace_id,
    bindingId: BINDING.binding_id
  });
}

function workspaceRootStillExists() {
  return Boolean(WORKSPACE_CONTEXT.workspace_root && existsSync(WORKSPACE_CONTEXT.workspace_root));
}

function bindingStillValid() {
  if (!workspaceRootStillExists()) {
    return false;
  }
  try {
    const currentBinding = resolveSonolBinding({
      workspaceRoot: WORKSPACE_CONTEXT.workspace_root,
      dbPath: DB_PATH,
      runtimeRoot: BINDING.runtime_root,
      startDir: SERVER_WORKSPACE_ROOT
    });
    return currentBinding.binding_id === BINDING.binding_id
      && currentBinding.workspace_id === BINDING.workspace_id
      && currentBinding.db_path === BINDING.db_path
      && currentBinding.runtime_root === BINDING.runtime_root;
  } catch {
    return false;
  }
}

function healthPayload() {
  const workspaceState = withReadStore((store) => store.getWorkspaceState());
  const workspaceRootExists = workspaceRootStillExists();
  const bindingValid = bindingStillValid();
  return {
    ok: true,
    dashboard_url: DASHBOARD_URL,
    operator_dashboard_url: currentOperatorDashboardUrl(),
    remote_dashboard_origin: REMOTE_DASHBOARD_ORIGIN,
    bridge_auth_required: Boolean(REMOTE_DASHBOARD_ORIGIN),
    authoritative_db_path: DB_PATH,
    runtime_root: BINDING.runtime_root,
    workspace_root: WORKSPACE_CONTEXT.workspace_root,
    workspace_id: WORKSPACE_CONTEXT.workspace_id,
    event_store: {
      table: "events",
      compatibility_views: ["runtime_events"]
    },
    workspace_root_exists: workspaceRootExists,
    binding_valid: bindingValid,
    workspace_state: workspaceState,
    binding: sanitizedBinding(BINDING, { exposePaths: true }),
    default_limits: {
      max_threads: 6,
      max_depth: 1
    },
    control_matrix: {
      provider_compatible_fields: PROVIDER_COMPATIBLE_FIELDS,
      compatibility_alias_fields: COMPATIBILITY_ALIAS_FIELDS,
      sonol_enforced_fields: SONOL_ENFORCED_FIELDS,
      advisory_fields: ADVISORY_FIELDS,
      unsupported_assumptions: UNSUPPORTED_CONTROL_ASSUMPTIONS
    },
    adapters: listAdapters(),
    supported_languages: SUPPORTED_LANGUAGES
  };
}

function scheduleInvalidBindingTermination() {
  setInterval(() => {
    const workspaceRootExists = workspaceRootStillExists();
    const bindingValid = workspaceRootExists && bindingStillValid();
    if (workspaceRootExists && bindingValid) {
      invalidBindingPollCount = 0;
      return;
    }
    invalidBindingPollCount += 1;
    writeDashboardLog("binding_invalid_poll", {
      workspace_root_exists: workspaceRootExists,
      binding_valid: bindingValid,
      poll_count: invalidBindingPollCount
    });
    if (invalidBindingPollCount < 3) {
      return;
    }
    writeDashboardLog("server_self_terminate_invalid_binding", {
      workspace_root_exists: workspaceRootExists,
      binding_valid: bindingValid,
      poll_count: invalidBindingPollCount
    });
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 250).unref?.();
  }, 10000).unref?.();
}

function bridgeTokenIsValid(request) {
  const expected = currentBridgeToken();
  return Boolean(expected) && String(request.headers["x-sonol-bridge-token"] ?? "") === expected;
}

function bridgeTokenFromRequestUrl(rawUrl = "") {
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    return String(
      parsed.searchParams.get("bridge_token")
      ?? parsed.searchParams.get("sonol_bridge_token")
      ?? ""
    );
  } catch {
    return "";
  }
}

function websocketBridgeTokenIsValid(request) {
  const expected = currentBridgeToken();
  const received = bridgeTokenFromRequestUrl(request.url ?? "");
  return Boolean(expected) && received === expected;
}

function remoteBridgeRouteAllowed(request, url) {
  if (!isRemoteBridgeRequest(request)) {
    return true;
  }
  if (request.method === "GET" && (
    url.pathname === "/api/health"
    || url.pathname === "/api/snapshot"
    || url.pathname === "/api/plans"
    || url.pathname === "/api/runs"
    || url.pathname === "/api/events"
  )) {
    return true;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/validate")) {
    return true;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/runs/") && (
    url.pathname.endsWith("/diagnostics")
    || url.pathname.endsWith("/adapter-status")
    || url.pathname.endsWith("/packet")
    || url.pathname.endsWith("/launch-manifest")
  )) {
    return true;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/focus")) {
    return true;
  }
  if (request.method === "PUT" && url.pathname.startsWith("/api/plans/")) {
    return true;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/approve")) {
    return true;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && (
    url.pathname.endsWith("/retry")
    || url.pathname.endsWith("/stop")
  )) {
    return true;
  }
  return false;
}

function redactRemoteBridgeBinding(binding) {
  return {
    ...binding,
    workspace_root: binding?.workspace_root ? "redacted" : binding?.workspace_root,
    db_path: binding?.db_path ? "redacted" : binding?.db_path,
    runtime_root: binding?.runtime_root ? "redacted" : binding?.runtime_root,
    install_root: binding?.install_root ? "redacted" : binding?.install_root
  };
}

function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (!raw) {
        resolvePromise({});
        return;
      }

      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on("error", rejectPromise);
  });
}

function readEnrichedSnapshot() {
  return enrichSnapshot(withReadStore((store) => store.getSnapshot()));
}

function readChangeFingerprint() {
  return withReadStore((store) => store.getChangeFingerprint());
}

function readRuntimePulse() {
  return withReadStore((store) => ({
    fingerprint: store.getChangeFingerprint(),
    liveActivity: store.hasLiveActivity()
  }));
}

function pathSegment(url, index) {
  return decodeURIComponent(url.pathname.split("/")[index] ?? "");
}

function toEditablePlan(currentPlan, draftPlan) {
  const mergedPlan = {
    ...currentPlan,
    ...draftPlan,
    agents: Array.isArray(draftPlan.agents) ? draftPlan.agents : currentPlan.agents,
    tasks: Array.isArray(draftPlan.tasks) ? draftPlan.tasks : currentPlan.tasks,
    dependency_edges: Array.isArray(draftPlan.dependency_edges) ? draftPlan.dependency_edges : currentPlan.dependency_edges
  };
  const isMulti = isStructurallyMultiAgentPlan(mergedPlan);

  return {
    ...mergedPlan,
    plan_id: currentPlan.plan_id,
    created_at: currentPlan.created_at,
    context_version: currentPlan.context_version + 1,
    latest_editor: "dashboard",
    dashboard_url: currentPlan.dashboard_url ?? DASHBOARD_URL,
    dashboard_approval_status: isMulti ? "pending" : "not_needed",
    terminal_confirmation_required: isMulti,
    terminal_confirmation_status: isMulti ? "not_requested" : "not_required",
    approval_status: isMulti ? "ready" : "ready"
  };
}

function hasConfiguredValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== null && value !== undefined && value !== "";
}

function summarizeAgentControls(agent) {
  const providerCompatible = PROVIDER_COMPATIBLE_FIELDS.filter((field) => hasConfiguredValue(agent[field]));
  const sonolEnforced = SONOL_ENFORCED_FIELDS.filter((field) => hasConfiguredValue(agent[field]));
  const advisory = ADVISORY_FIELDS.filter((field) => hasConfiguredValue(agent[field]));

  return {
    agent_id: agent.agent_id,
    role: agent.role,
    provider_compatible: providerCompatible,
    compatibility_aliases: COMPATIBILITY_ALIAS_FIELDS.filter((field) => hasConfiguredValue(agent[field])),
    sonol_enforced: sonolEnforced,
    advisory,
    writer: Array.isArray(agent.write_paths) && agent.write_paths.length > 0
  };
}

function computeOperatorAction(plan, run) {
  const preferredLanguage = plan?.preferred_language ?? "ko";
  const isMulti = isStructurallyMultiAgentPlan(plan);
  const validation = validatePlan(plan);
  const adapterCapabilities = run
    ? getAdapterCapabilities(run.adapter_type, run.adapter_backend)
    : { auto_launch_supported: false, remote_cancel_supported: false, remote_status_supported: false };
  const canRemoteStop = Boolean(adapterCapabilities.remote_cancel_supported);

  if (!plan) {
    return {
      recovery_state: "no_plan",
      reason_code: "NO_PLAN",
      next_action: localize(preferredLanguage, "아직 표시할 계획이 없습니다.", "There is no plan to show yet."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: false
    };
  }

  if (validation.errors.length > 0) {
    return {
      recovery_state: "blocked_validation",
      reason_code: "VALIDATION_ERRORS",
      next_action: localize(preferredLanguage, "대시보드에서 검증 오류를 수정한 뒤 다시 승인하세요.", "Fix validation errors in the dashboard, then approve again."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: false
    };
  }

  if (!isMulti) {
    return {
      recovery_state: "single_flow",
      reason_code: "SINGLE_AGENT_RECOMMENDED",
      next_action: localize(preferredLanguage, "이 요청은 일반 단일 에이전트 흐름으로 진행하는 편이 낫습니다.", "This request is better handled in the normal single-agent flow."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: Boolean(run && ["failed", "cancelled", "stale"].includes(run.status)),
      can_stop: Boolean(run && ["queued", "prepared", "running", "blocked"].includes(run.status) && canRemoteStop)
    };
  }

  if (plan.dashboard_approval_status !== "approved") {
    return {
      recovery_state: "awaiting_dashboard_approval",
      reason_code: "DASHBOARD_APPROVAL_REQUIRED",
      next_action: localize(preferredLanguage, "구성을 확인한 뒤 대시보드에서 승인하세요.", "Review the configuration, then approve it in the dashboard."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: true,
      can_retry: false,
      can_stop: false
    };
  }

  if (plan.terminal_confirmation_status !== "confirmed") {
    return {
      recovery_state: "awaiting_terminal_confirm",
      reason_code: "TERMINAL_CONFIRM_REQUIRED",
      next_action: localize(preferredLanguage, "현재 Sonol 터미널 세션에 승인이라고 입력하세요.", "Type 승인 in the current Sonol terminal session."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: false
    };
  }

  if (!run) {
    return {
      recovery_state: "launch_pending",
      reason_code: "RUN_NOT_VISIBLE_YET",
      next_action: localize(preferredLanguage, "터미널 승인이 반영되면 실행 상태가 곧 표시됩니다.", "The run state will appear once terminal confirmation is reflected."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: false
    };
  }

  if (run.status === "prepared") {
    return {
      recovery_state: "launch_prepared",
      reason_code: "RUN_LAUNCH_PREPARED",
      next_action: localize(preferredLanguage, "launch manifest가 준비됐습니다. 실제 서브에이전트 실행 또는 첫 runtime 보고를 기다리세요.", "The launch manifest is ready. Launch provider subagents or wait for the first runtime report."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: canRemoteStop
    };
  }

  if (run.status === "running" || run.status === "queued") {
    return {
      recovery_state: "monitoring",
      reason_code: "RUN_ACTIVE",
      next_action: canRemoteStop
        ? localize(preferredLanguage, "진행 상황을 확인하세요. 필요하면 이 화면에서 중지를 요청할 수 있습니다.", "Monitor progress. You can request a stop from this dashboard if needed.")
        : localize(preferredLanguage, "진행 상황을 확인하세요. 이 adapter는 원격 중지를 지원하지 않으므로 여기서는 상태만 볼 수 있습니다.", "Monitor progress. This adapter does not support remote cancellation, so the dashboard is view-only for this run."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: canRemoteStop
    };
  }

  if (run.status === "blocked") {
    return {
      recovery_state: "blocked_missing_report",
      reason_code: "RUN_BLOCKED",
      next_action: canRemoteStop
        ? localize(preferredLanguage, "막힌 이유를 확인하세요. 필요하면 원격 중지를 요청한 뒤 재승인으로 새 run을 시작하세요.", "Check the blocking reason. If needed, request a remote stop and then re-approve for a fresh run.")
        : localize(preferredLanguage, "막힌 이유를 확인하세요. 이 adapter는 원격 중지를 지원하지 않으므로, 현재 run은 관찰만 가능하고 다시 시작은 재승인 후 새 run으로 가야 합니다.", "Check the blocking reason. This adapter does not support remote cancellation, so this run is monitor-only and restart should go through re-approval and a fresh run."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: canRemoteStop
    };
  }

  if (run.status === "failed" || run.status === "cancelled" || run.status === "stale") {
    return {
      recovery_state: "reapproval_required",
      reason_code: "RUN_TERMINATED",
      next_action: localize(preferredLanguage, "대시보드에서 계획을 다시 승인한 뒤 현재 Sonol 터미널 세션에 승인이라고 입력하세요.", "Re-approve the plan in the dashboard, then type 승인 in the current Sonol terminal session."),
      resume_supported: false,
      reapproval_required: true,
      can_approve: true,
      can_retry: false,
      can_stop: false
    };
  }

  if (run.status === "completed") {
    return {
      recovery_state: "terminal",
      reason_code: "RUN_COMPLETED",
      next_action: localize(preferredLanguage, "작업이 끝났습니다. 결과와 통합 내용을 확인하세요.", "The run is complete. Review the outputs and final integration."),
      resume_supported: false,
      reapproval_required: false,
      can_approve: false,
      can_retry: false,
      can_stop: false
    };
  }

  return {
    recovery_state: "monitoring",
    reason_code: "RUN_ACTIVE",
    next_action: localize(preferredLanguage, "현재 상태를 확인하세요.", "Check the current status."),
    resume_supported: false,
    reapproval_required: false,
    can_approve: false,
    can_retry: false,
    can_stop: false
  };
}

function enrichPlan(plan, run) {
  const effectiveMaxThreads = plan.effective_max_threads ?? Math.min(plan.agents?.length ?? 1, 6);
  const effectiveMaxDepth = plan.effective_max_depth ?? 1;
  const agentControls = (plan.agents ?? []).map(summarizeAgentControls);
  const validation = validatePlan(plan);

  return {
    ...plan,
    terminal_confirm_command: null,
    effective_max_threads: effectiveMaxThreads,
    effective_max_depth: effectiveMaxDepth,
    validation,
    operator_action: computeOperatorAction(plan, run),
    control_surface: {
      effective_limits: {
        max_threads: effectiveMaxThreads,
        max_depth: effectiveMaxDepth,
        planned_agents: plan.agents?.length ?? 0,
        writable_agents: agentControls.filter((agent) => agent.writer).length,
        remaining_thread_capacity: Math.max(0, effectiveMaxThreads - (plan.agents?.length ?? 0))
      },
      provider_compatible_fields: PROVIDER_COMPATIBLE_FIELDS,
      compatibility_alias_fields: COMPATIBILITY_ALIAS_FIELDS,
      sonol_enforced_fields: SONOL_ENFORCED_FIELDS,
      advisory_fields: ADVISORY_FIELDS,
      agent_controls: agentControls
    }
  };
}

function enrichSnapshot(snapshot) {
  const { db_path: _dbPath, workspace_root: _workspaceRoot, ...restSnapshot } = snapshot;
  const basePlans = (snapshot.plans ?? [])
    .filter((plan) => !plan.workspace_id || plan.workspace_id === WORKSPACE_CONTEXT.workspace_id);
  const basePlanIds = new Set(basePlans.map((plan) => plan.plan_id));
  const runs = (snapshot.runs ?? []).filter((run) =>
    (!run.workspace_id || run.workspace_id === WORKSPACE_CONTEXT.workspace_id) &&
    basePlanIds.has(run.plan_id)
  );
  const latestRunByPlanId = new Map(
    runs
      .slice()
      .sort((left, right) => String(right.updated_at ?? right.created_at ?? "").localeCompare(String(left.updated_at ?? left.created_at ?? "")))
      .map((run) => [run.plan_id, run])
  );
  const plans = basePlans.map((plan) => enrichPlan(plan, latestRunByPlanId.get(plan.plan_id) ?? null));
  const enrichedPlanIds = new Set(plans.map((plan) => plan.plan_id));
  const runIds = new Set(runs.map((run) => run.run_id));
  const runMonitors = (snapshot.run_monitors ?? []).filter((monitor) => runIds.has(monitor.run_id));
  const plannerJobs = (snapshot.planner_jobs ?? []).filter((job) => job.workspace_id === WORKSPACE_CONTEXT.workspace_id);
  const recentEvents = (snapshot.recentEvents ?? []).filter((event) => {
    const runId = event?.payload?.run_id;
    const planId = event?.payload?.plan_id;
      return (typeof runId === "string" && runIds.has(runId)) || (typeof planId === "string" && enrichedPlanIds.has(planId));
  });
  const planEventsById = Object.fromEntries(
    Object.entries(snapshot.planEventsById ?? {}).filter(([planId]) => enrichedPlanIds.has(planId))
  );

  return {
    ...restSnapshot,
    ...(EXPOSE_BINDING_PATHS
      ? {
          db_path: DB_PATH,
          workspace_root: WORKSPACE_CONTEXT.workspace_root
        }
      : {}),
    plans,
    runs,
    run_monitors: runMonitors,
    planner_jobs: plannerJobs,
    recentEvents,
    planEventsById,
    workspace_id: WORKSPACE_CONTEXT.workspace_id,
    workspace_state: snapshot.workspace_state ?? null,
    workspace_registry: snapshot.workspace_registry ?? null,
    binding: sanitizedBinding(BINDING, { exposePaths: EXPOSE_BINDING_PATHS }),
    control_matrix: {
      provider_compatible_fields: PROVIDER_COMPATIBLE_FIELDS,
      compatibility_alias_fields: COMPATIBILITY_ALIAS_FIELDS,
      sonol_enforced_fields: SONOL_ENFORCED_FIELDS,
      advisory_fields: ADVISORY_FIELDS,
      unsupported_assumptions: UNSUPPORTED_CONTROL_ASSUMPTIONS
    },
    default_limits: {
      max_threads: 6,
      max_depth: 1
    }
  };
}

function hasLiveActivity(snapshot) {
  return (snapshot.runs ?? []).some((run) => ["queued", "prepared", "running", "blocked"].includes(run.status));
}

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    applyBridgeCors(request, response);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api")) {
      if (!isAllowedBridgeOrigin(requestOrigin(request))) {
        response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "origin not allowed" }, null, 2));
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname.startsWith("/api")) {
      const origin = requestOrigin(request);
      if (origin && !isAllowedBridgeOrigin(origin)) {
        sendJson(response, 403, { error: "origin not allowed" });
        return;
      }
      if (isRemoteBridgeRequest(request) && !bridgeTokenIsValid(request)) {
        sendJson(response, 401, { error: "invalid bridge token" });
        return;
      }
      if (!remoteBridgeRouteAllowed(request, url)) {
        sendJson(response, 403, { error: "remote dashboard bridge route not allowed" });
        return;
      }
    }

    if (request.method === "GET" && !url.pathname.startsWith("/api")) {
      const frontendFile = resolveFrontendFile(url.pathname);
      if (frontendFile) {
        sendFile(response, frontendFile);
        return;
      }

      const fallbackIndex = resolveFrontendFile("/");
      if (fallbackIndex) {
        sendFile(response, fallbackIndex);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Frontend build not found.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, healthPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/adapters") {
      sendJson(response, 200, {
        default_adapter: ADAPTER_DEFAULTS,
        adapters: listAdapters()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, {
        ...enrichSnapshot(withReadStore((store) => store.getSnapshot())),
        dashboard_url: DASHBOARD_URL,
        operator_dashboard_url: currentOperatorDashboardUrl(),
        authoritative_db_path: DB_PATH,
        runtime_root: BINDING.runtime_root,
        event_store: {
          table: "events",
          compatibility_views: ["runtime_events"]
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/plans") {
      sendJson(response, 200, withReadStore((store) => ({ plans: store.listPlans() })));
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/focus")) {
      const planId = pathSegment(url, 3);
      const focusedPlan = withStore((store) => {
        const plan = store.getPlan(planId);
        if (!plan) {
          return null;
        }
        store.setActivePlan(plan.plan_id);
        return plan;
      });

      if (!focusedPlan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      broadcastSnapshot();
      sendJson(response, 200, { ok: true, plan_id: focusedPlan.plan_id });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/validate")) {
      const planId = pathSegment(url, 3);
      const plan = withReadStore((store) => store.getPlan(planId));
      if (!plan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      sendJson(response, 200, { plan_id: planId, validation: validatePlan(plan) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/runs") {
      sendJson(response, 200, withReadStore((store) => ({ runs: store.listRuns(url.searchParams.get("plan_id")) })));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const runId = url.searchParams.get("run_id");
      const eventResponse = withReadStore((store) => {
        if (!runId) {
          return { statusCode: 400, data: { error: "run_id is required" } };
        }

        const run = store.getRun(runId);
        if (!run) {
          return { statusCode: 404, data: { error: "run not found" } };
        }

        return { statusCode: 200, data: { events: store.listEvents(runId) } };
      });
      sendJson(response, eventResponse.statusCode, eventResponse.data);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/diagnostics")) {
      const runId = pathSegment(url, 3);
      const diagnostics = withReadStore((store) => collectRunDiagnostics(store, runId));
      sendJson(response, diagnostics.found ? 200 : 404, diagnostics);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/adapter-status")) {
      const runId = pathSegment(url, 3);
      const adapterStatus = withReadStore((store) => {
        const run = store.getRun(runId);
        if (!run) {
          return { statusCode: 404, data: { error: "run not found" } };
        }
        return {
          statusCode: 200,
          data: collectAdapterStatusForRun(store, run, { log: false })
        };
      });
      sendJson(response, adapterStatus.statusCode, adapterStatus.data);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/packet")) {
      const runId = pathSegment(url, 3);
      const agentId = url.searchParams.get("agent_id");
      const packetResponse = withStore((store) => {
        const run = store.getRun(runId);
        if (!run) {
          return { statusCode: 404, data: { error: "run not found" } };
        }

        const plan = store.getPlan(run.plan_id);
        if (!plan) {
          return { statusCode: 404, data: { error: "plan not found" } };
        }

        const agent = plan.agents.find((candidate) => candidate.agent_id === agentId);
        if (!agent) {
          return { statusCode: 404, data: { error: "agent not found" } };
        }

        const runtimeFiles = prepareRunContextForRun(store, run);

        return {
          statusCode: 200,
          data: { packet: buildAgentPacketForRun(run, plan, agent, { runtimeFiles }) }
        };
      });

      sendJson(response, packetResponse.statusCode, packetResponse.data);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/launch-manifest")) {
      const runId = pathSegment(url, 3);
      const manifestResponse = withStore((store) => {
        const launchData = store.getRunLaunchCandidates?.(runId) ?? null;
        if (!launchData) {
          return { statusCode: 404, data: { error: "run not found" } };
        }

        return {
          statusCode: 200,
          data: buildLaunchManifestForRun(store, launchData.run)
        };
      });

      sendJson(response, manifestResponse.statusCode, manifestResponse.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/plans/recommend") {
      const preferredLanguage = normalizePreferredLanguage(request.headers["accept-language"] ?? "ko");
      sendJson(response, 400, {
        ok: false,
        error_code: "LOCAL_CREATIVE_DRAFT_REQUIRED",
        error: localize(
          preferredLanguage,
          "공개판에서는 대시보드가 초안을 직접 생성하지 않습니다. 현재 Codex/Claude 세션이 로컬에서 creative draft를 만든 뒤 present-proposal.mjs 또는 recommend-plan.mjs로 넘겨야 합니다.",
          "The public edition dashboard does not author drafts directly. The current Codex/Claude session must create a local creative draft first, then pass it to present-proposal.mjs or recommend-plan.mjs."
        ),
        expected_usage: {
          present_proposal: "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/present-proposal.mjs --creative-draft-file /abs/draft.json --request-summary \"request summary\"",
          recommend_plan: "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/recommend-plan.mjs --creative-draft-file /abs/draft.json --request-summary \"request summary\""
        }
      });
      return;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/plans/")) {
      const planId = pathSegment(url, 3);
      const currentPlan = withReadStore((store) => store.getPlan(planId));
      if (!currentPlan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      const body = await readBody(request);
      if (!body.plan || typeof body.plan !== "object") {
        sendJson(response, 400, { error: "plan object is required" });
        return;
      }
      const expectedContextVersion = Number.isInteger(body.base_context_version)
        ? body.base_context_version
        : Number.isInteger(body.plan?.context_version)
          ? body.plan.context_version
          : null;
      if (!Number.isInteger(expectedContextVersion)) {
        sendJson(response, 400, { error: "base_context_version is required" });
        return;
      }

      const updatedPlan = withStore((store) => {
        const latestPlan = store.getPlan(planId);
        if (!latestPlan) {
          throw new Error("plan not found");
        }
        const savedPlan = store.savePlan(toEditablePlan(latestPlan, body.plan), {
          expectedContextVersion
        });
        store.appendEvent("plan_updated", {
          event_id: `plan_updated_${savedPlan.plan_id}_${Date.now()}`,
          plan_id: savedPlan.plan_id,
          approval_status: savedPlan.approval_status,
          message: localize(savedPlan.preferred_language, "대시보드에서 계획을 수정했습니다. 터미널 확정에는 최신 저장 내용이 사용됩니다.", "Updated the plan in the dashboard. Terminal confirmation will use the latest saved state."),
          timestamp: new Date().toISOString(),
          schema_version: "1.0.0"
        });
        return savedPlan;
      });
      broadcastSnapshot();
      sendJson(response, 200, { plan: updatedPlan });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/approve")) {
      const planId = pathSegment(url, 3);
      const currentPlan = withReadStore((store) => store.getPlan(planId));
      if (!currentPlan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      const validation = validatePlan(currentPlan);
      if (!validation.valid) {
        sendJson(response, 409, {
          error: "approval blocked by validation errors",
          validation
        });
        return;
      }

      const approvedPlan = withStore((store) => {
        const requiresTerminalFlow = isStructurallyMultiAgentPlan(currentPlan);
        const savedPlan = store.savePlan({
          ...currentPlan,
          context_version: currentPlan.context_version + 1,
          single_or_multi: requiresTerminalFlow ? "multi" : "single",
          multi_agent_beneficial: requiresTerminalFlow,
          approval_status: "ready",
          dashboard_approval_status: requiresTerminalFlow ? "approved" : "not_needed",
          terminal_confirmation_required: requiresTerminalFlow,
          terminal_confirmation_status: requiresTerminalFlow ? "pending" : "not_required",
          latest_editor: "dashboard_approval"
        }, {
          expectedContextVersion: currentPlan.context_version
        });

        store.appendEvent("plan_updated", {
          event_id: `plan_updated_${savedPlan.plan_id}_${Date.now()}`,
          plan_id: savedPlan.plan_id,
          approval_status: savedPlan.approval_status,
          message: requiresTerminalFlow
            ? localize(savedPlan.preferred_language, `대시보드 승인 완료. 현재 Sonol 터미널 세션에 승인이라고 입력해 주세요. ${savedPlan.dashboard_url}`, `Dashboard approval recorded. Type 승인 in the current Sonol terminal session. ${savedPlan.dashboard_url}`)
            : localize(savedPlan.preferred_language, "단일 흐름이 확인되었습니다. 일반 방식으로 진행하면 됩니다.", "Single-agent flow confirmed. Proceed in the normal flow."),
          timestamp: new Date().toISOString(),
          schema_version: "1.0.0"
        });
        return savedPlan;
      });
      const approvalMessage = isStructurallyMultiAgentPlan(approvedPlan)
        ? localize(approvedPlan.preferred_language, `대시보드 승인 완료. 현재 Sonol 터미널 세션에 승인이라고 입력해 주세요. ${approvedPlan.dashboard_url}`, `Dashboard approval recorded. Type 승인 in the current Sonol terminal session. ${approvedPlan.dashboard_url}`)
        : localize(approvedPlan.preferred_language, "단일 흐름이 확인되었습니다. 일반 방식으로 진행하면 됩니다.", "Single-agent flow confirmed. Proceed in the normal flow.");
      broadcastSnapshot();
      sendJson(response, 200, { plan: approvedPlan, message: approvalMessage });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/plans/") && url.pathname.endsWith("/confirm-terminal")) {
      const planId = pathSegment(url, 3);
      const plan = withReadStore((store) => store.getPlan(planId));
      sendJson(response, 405, {
        error: "terminal confirmation must happen in the active Sonol terminal session",
        hint: localize(plan?.preferred_language, "현재 Sonol 터미널 세션에 승인이라고 입력하세요.", "Type `승인` in the current Sonol terminal session.")
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(request);
      const plan = withReadStore((store) => store.getPlan(body.plan_id));

      if (!plan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      if (isStructurallyMultiAgentPlan(plan)) {
        sendJson(response, 405, {
          error: "multi-agent launch must be initiated from terminal confirmation",
          hint: localize(plan.preferred_language, "대시보드 승인 후 현재 Sonol 터미널 세션에 승인이라고 입력하세요.", "After dashboard approval, type `승인` in the current Sonol terminal session.")
        });
        return;
      }

      const activeRun = withReadStore((store) => store.getActiveRunForPlan(plan.plan_id));
      if (activeRun) {
        sendJson(response, 409, {
          error: `an active run already exists for this plan: ${activeRun.run_id}`
        });
        return;
      }

      const run = withStore((store) => {
        const launchTimestamp = new Date().toISOString();
        const queuedRun = store.saveRun({
          ...createRunSnapshot(plan, {
            mode: body.mode ?? "dry-run",
            adapter_type: body.adapter_type ?? ADAPTER_DEFAULTS.adapter_type,
            adapter_backend: body.adapter_backend ?? ADAPTER_DEFAULTS.adapter_backend
          }),
          status: "queued",
          started_at: null
        });

        const adapterDispatch = launchRunWithAdapter(store, queuedRun);
        const nextRunStatus = adapterDispatch?.dispatch_mode === "manifest_only" && adapterDispatch?.auto_launch_supported === false
          ? "prepared"
          : "running";
        const savedRun = store.updateRunStatus(queuedRun.run_id, nextRunStatus, {
          started_at: nextRunStatus === "running" ? launchTimestamp : null,
          ended_at: null,
          cancel_reason: null
        });

        store.appendEvent("session_updated", {
          event_id: `session_updated_${savedRun.run_id}_${Date.now()}`,
          run_id: savedRun.run_id,
          status: savedRun.status,
          message: savedRun.status === "prepared"
            ? localize(plan.preferred_language, "실행 manifest를 만들었습니다.", "Prepared the launch manifest for the run.")
            : localize(plan.preferred_language, "새 실행을 만들었습니다.", "Created a new run."),
          detail: savedRun.status === "prepared"
            ? summarizeManualLaunch(plan, adapterDispatch, localize(plan.preferred_language, "실행 manifest가 준비되었습니다.", "The launch manifest is ready."))
            : "",
          timestamp: launchTimestamp,
          schema_version: "1.0.0"
        });
        const mainAgent = plan.agents.find((agent) => isMainAgent(agent));
        if (mainAgent && (savedRun.status === "running" || savedRun.status === "prepared")) {
          const payload = {
            event_id: `session_updated_${savedRun.run_id}_${mainAgent.agent_id}_${Date.now()}`,
            run_id: savedRun.run_id,
            agent_id: mainAgent.agent_id,
            status: savedRun.status === "prepared" ? "queued" : "running",
            message: savedRun.status === "prepared"
              ? localize(plan.preferred_language, "manifest launch를 기다립니다.", "Waiting for manifest launch.")
              : localize(plan.preferred_language, "전체 흐름을 시작합니다.", "Starting overall coordination."),
            detail: savedRun.status === "prepared"
              ? summarizeManualLaunch(plan, adapterDispatch, localize(plan.preferred_language, "실행 manifest가 준비되었습니다.", "The launch manifest is ready."))
              : "",
            timestamp: launchTimestamp,
            schema_version: "1.0.0"
          };
          const mainTaskId = resolveMainTaskId(plan);
          if (mainTaskId) {
            payload.task_id = mainTaskId;
          }
          store.appendEvent("session_updated", payload);
        }
        return {
          run: savedRun,
          adapter_dispatch: adapterDispatch
        };
      });
      broadcastSnapshot();
      sendJson(response, 201, run);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/status")) {
      const runId = pathSegment(url, 3);
      const body = await readBody(request);
      const status = String(body.status ?? "");
      const run = withStore((store) => {
        const updatedRun = store.updateRunStatus(runId, status, {
          cancel_reason: body.cancel_reason ?? null,
          started_at: body.started_at ?? undefined,
          ended_at: body.ended_at ?? undefined
        });
        const plan = store.getPlan(updatedRun.plan_id);
        if (!["completed", "failed", "cancelled", "stale"].includes(updatedRun.status)) {
          store.appendEvent("session_updated", {
            event_id: `session_updated_${updatedRun.run_id}_${Date.now()}`,
            run_id: updatedRun.run_id,
            status: updatedRun.status,
            message: body.message ?? localize(plan?.preferred_language, `실행 상태가 ${updatedRun.status}(으)로 바뀌었습니다.`, `Run status changed to ${updatedRun.status}.`),
            timestamp: new Date().toISOString(),
            schema_version: "1.0.0"
          });
        }
        return updatedRun;
      });
      broadcastSnapshot();
      sendJson(response, 200, { run });
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/retry")) {
      const runId = pathSegment(url, 3);
      const previousRun = withStore((store) => store.getRun(runId));
      if (!previousRun) {
        sendJson(response, 404, { error: "run not found" });
        return;
      }

      const plan = withStore((store) => store.getPlanForRun(previousRun));
      if (!plan) {
        sendJson(response, 404, { error: "plan not found" });
        return;
      }

      if (isStructurallyMultiAgentPlan(plan)) {
        sendJson(response, 405, {
          error: "multi-agent retry is disabled; re-approve in the dashboard and confirm again from terminal",
          hint: localize(plan.preferred_language, "대시보드에서 다시 승인한 뒤 현재 Sonol 터미널 세션에 승인이라고 입력하세요.", "Approve again in the dashboard, then type `승인` in the current Sonol terminal session.")
        });
        return;
      }

      const activeRun = withStore((store) => store.getActiveRunForPlan(plan.plan_id));
      if (activeRun) {
        sendJson(response, 409, {
          error: `retry is blocked because an active run already exists for this plan: ${activeRun.run_id}`
        });
        return;
      }

      const retryRun = withStore((store) => {
        const launchTimestamp = new Date().toISOString();
        const queuedRun = store.saveRun({
          ...createRunSnapshot(store.getPlanForRun(previousRun), {
            mode: previousRun.mode,
            adapter_type: previousRun.adapter_type,
            adapter_backend: previousRun.adapter_backend,
            retry_of: previousRun.run_id
          }),
          status: "queued",
          started_at: null
        });
        const adapterDispatch = launchRunWithAdapter(store, queuedRun);
        const nextRunStatus = adapterDispatch?.dispatch_mode === "manifest_only" && adapterDispatch?.auto_launch_supported === false
          ? "prepared"
          : "running";
        const savedRun = store.updateRunStatus(queuedRun.run_id, nextRunStatus, {
          started_at: nextRunStatus === "running" ? launchTimestamp : null,
          ended_at: null,
          cancel_reason: null
        });

        store.appendEvent("session_updated", {
          event_id: `session_updated_${savedRun.run_id}_${Date.now()}`,
          run_id: savedRun.run_id,
          status: savedRun.status,
          message: savedRun.status === "prepared"
            ? localize(plan.preferred_language, `${previousRun.run_id} 기준 retry manifest를 만들었습니다.`, `Prepared a retry launch manifest from ${previousRun.run_id}.`)
            : localize(plan.preferred_language, `${previousRun.run_id} 기준으로 다시 실행을 만들었습니다.`, `Created a retry run from ${previousRun.run_id}.`),
          detail: savedRun.status === "prepared"
            ? summarizeManualLaunch(plan, adapterDispatch, localize(plan.preferred_language, `${previousRun.run_id} 기준 retry manifest가 준비되었습니다.`, `The retry launch manifest from ${previousRun.run_id} is ready.`))
            : "",
          timestamp: launchTimestamp,
          schema_version: "1.0.0"
        });
        const mainAgent = plan.agents.find((agent) => isMainAgent(agent));
        if (mainAgent && (savedRun.status === "running" || savedRun.status === "prepared")) {
          const payload = {
            event_id: `session_updated_${savedRun.run_id}_${mainAgent.agent_id}_${Date.now()}`,
            run_id: savedRun.run_id,
            agent_id: mainAgent.agent_id,
            status: savedRun.status === "prepared" ? "queued" : "running",
            message: savedRun.status === "prepared"
              ? localize(plan.preferred_language, "manifest launch를 기다립니다.", "Waiting for manifest launch.")
              : localize(plan.preferred_language, "전체 흐름을 다시 시작합니다.", "Restarting overall coordination."),
            detail: savedRun.status === "prepared"
              ? summarizeManualLaunch(plan, adapterDispatch, localize(plan.preferred_language, `${previousRun.run_id} 기준 retry manifest가 준비되었습니다.`, `The retry launch manifest from ${previousRun.run_id} is ready.`))
              : "",
            timestamp: launchTimestamp,
            schema_version: "1.0.0"
          };
          const mainTaskId = resolveMainTaskId(plan);
          if (mainTaskId) {
            payload.task_id = mainTaskId;
          }
          store.appendEvent("session_updated", payload);
        }
        return {
          run: savedRun,
          adapter_dispatch: adapterDispatch
        };
      });
      broadcastSnapshot();
      sendJson(response, 201, retryRun);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/stop")) {
      const runId = pathSegment(url, 3);
      const body = await readBody(request);
      const existingRun = withReadStore((store) => store.getRun(runId));
      if (!existingRun) {
        sendJson(response, 404, { error: "run not found" });
        return;
      }
      const previewCancellation = withReadStore((store) =>
        cancelRunWithAdapter(store, existingRun, {
          message: body.message ?? "Run stopped from dashboard.",
          log: false
        })
      );
      if (!previewCancellation?.cancel_supported) {
        sendJson(response, 409, {
          error: "remote stop is not supported by the current adapter",
          adapter_cancellation: previewCancellation
        });
        return;
      }
      const run = withStore((store) => {
        const adapterCancellation = cancelRunWithAdapter(store, existingRun, {
          message: body.message ?? "Run stopped from dashboard."
        });
        const updatedRun = store.updateRunStatus(runId, "cancelled", {
          cancel_reason: body.message ?? "Run stopped from dashboard."
        });
        return {
          run: updatedRun,
          adapter_cancellation: adapterCancellation
        };
      });
      broadcastSnapshot();
      sendJson(response, 200, run);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("plan context conflict:")) {
      sendJson(response, 409, { error: message });
      return;
    }
    sendJson(response, 500, {
      error: message
    });
  }
});

const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.shouldHandle = function shouldHandle(request) {
  const origin = requestOrigin(request);
  if (!origin) {
    return false;
  }
  if (isLocalOrigin(origin)) {
    return true;
  }
  if (REMOTE_DASHBOARD_ORIGIN && origin === REMOTE_DASHBOARD_ORIGIN) {
    return websocketBridgeTokenIsValid(request);
  }
  return false;
};

function broadcastMessage(payload) {
  const message = JSON.stringify(payload);
  let delivered = 0;
  let failed = 0;

  for (const client of websocketServer.clients) {
    if (client.readyState === 1) {
      try {
        client.send(message);
        delivered += 1;
      } catch (error) {
        failed += 1;
        writeDashboardLog("ws_client_send_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          client.terminate();
        } catch {
        }
      }
    }
  }

  return { delivered, failed };
}

function broadcastSnapshot(snapshot = null) {
  try {
    const nextSnapshot = snapshot ?? readEnrichedSnapshot();
    const { delivered, failed } = broadcastMessage({
      type: "snapshot",
      data: nextSnapshot
    });

    writeDashboardLog("ws_broadcast_snapshot", {
      clients: websocketServer.clients.size,
      delivered,
      failed,
      latest_event: nextSnapshot.recentEvents.at(-1)?.payload?.event_id ?? null,
      runs: nextSnapshot.runs.length,
      plans: nextSnapshot.plans.length
    });
  } catch (error) {
    writeDashboardLog("ws_broadcast_snapshot_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

websocketServer.on("connection", (socket) => {
  const socketId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  socket.isAlive = true;
  writeDashboardLog("ws_connection_open", { socket_id: socketId, clients: websocketServer.clients.size });

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("close", (code) => {
    writeDashboardLog("ws_connection_close", { socket_id: socketId, code, clients: websocketServer.clients.size });
  });

  socket.on("error", (error) => {
    writeDashboardLog("ws_connection_error", {
      socket_id: socketId,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  try {
    socket.send(JSON.stringify({
      type: "snapshot",
      data: readEnrichedSnapshot()
    }));
  } catch (error) {
    writeDashboardLog("ws_initial_snapshot_failed", {
      socket_id: socketId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

let lastFingerprint = "";
let lastLiveBroadcastAt = 0;
setInterval(() => {
  syncWorkspaceArtifactEvents();
}, 1500);

setInterval(() => {
  try {
    const { fingerprint, liveActivity } = readRuntimePulse();
    const liveTickDue = liveActivity && Date.now() - lastLiveBroadcastAt >= 1000;

    if (fingerprint !== lastFingerprint || liveTickDue) {
      const snapshot = readEnrichedSnapshot();
      broadcastSnapshot(snapshot);
      lastFingerprint = fingerprint;
      lastLiveBroadcastAt = Date.now();
    }
  } catch (error) {
    writeDashboardLog("snapshot_poll_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}, 200);

setInterval(() => {
  if (websocketServer.clients.size === 0) {
    return;
  }

  try {
    broadcastMessage({
      type: "heartbeat",
      data: { generated_at: new Date().toISOString() }
    });
  } catch (error) {
    writeDashboardLog("ws_heartbeat_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}, 3000);

setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (socket.isAlive === false) {
      writeDashboardLog("ws_connection_terminated", {});
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, 15000);

withStore(() => true);

httpServer.listen(PORT, HOST, () => {
  console.log(`sonol dashboard listening on ${DASHBOARD_URL}`);
  console.log(`database: ${DB_PATH}`);
  writeDashboardLog("server_started", { host: HOST, port: PORT, dashboard_url: DASHBOARD_URL, db_path: DB_PATH });
});

scheduleInvalidBindingTermination();
