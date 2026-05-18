import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import { appendStructuredLog } from "./sonol-log.mjs";
import { detectPreferredLanguage, localize, runtimeDefaultPhrases } from "./sonol-language.mjs";
import { SONOL_PLANNER_BACKEND, SONOL_PLANNER_DRIVER } from "./sonol-planner-driver.mjs";
import {
  defaultDbPath as resolveDefaultDbPath,
  defaultRuntimeRoot as resolveDefaultRuntimeRoot,
  detectWorkspaceRoot,
  normalizeWorkspacePath,
  workspaceContextForDbPath,
  workspaceScopeId
} from "./sonol-runtime-paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const SCHEMA_DIR = resolve(ROOT_DIR, "schemas");

const EVENT_SCHEMA_MAP = {
  progress_event: "progress-event.schema.json",
  artifact_event: "artifact-event.schema.json",
  completion_event: "completion-event.schema.json",
  session_updated: "session-updated.schema.json",
  plan_updated: "plan-updated.schema.json"
};
const MISSING_SUBAGENT_REPORT_GRACE_MS = 90_000;
const BLOCKED_RUN_STALE_MS = 15 * 60_000;
const PLANNER_PENDING_STALE_MS = 10 * 60_000;
const PLANNER_JOB_STALE_MS = 10 * 60_000;
const MAX_PLAN_HISTORY = 10;
const activeLaunchDispatches = new Set();
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "prepared", "running", "blocked"]);
const RUN_STATUS_TRANSITIONS = {
  queued: new Set(["queued", "prepared", "running", "failed", "cancelled", "stale"]),
  prepared: new Set(["prepared", "running", "failed", "cancelled", "stale"]),
  running: new Set(["running", "blocked", "completed", "failed", "cancelled", "stale"]),
  blocked: new Set(["blocked", "running", "completed", "failed", "cancelled", "stale"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  stale: new Set(["stale"])
};

function normalizeEventRecord(_db, eventType, payload = {}) {
  if (!payload || typeof payload !== "object") {
    return { event_type: eventType, payload };
  }
  return { event_type: eventType, payload: { ...payload } };
}

function defaultWorkspaceState(workspace, activePlanId = null) {
  return {
    workspace_id: workspace?.workspace_id ?? null,
    workspace_root: workspace?.workspace_root ?? null,
    active_plan_id: activePlanId ?? null,
    pending_request_summary: null,
    pending_request_started_at: null,
    pending_request_error: null,
    pending_previous_plan_id: null,
    updated_at: nowIso()
  };
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schemaFiles = [
    "agent-definition.schema.json",
    "plan.schema.json",
    "run.schema.json",
    "progress-event.schema.json",
    "artifact-event.schema.json",
    "completion-event.schema.json",
    "session-updated.schema.json",
    "plan-updated.schema.json"
  ];

  for (const file of schemaFiles) {
    const schema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, file), "utf8"));
    ajv.addSchema(schema);
  }

  return ajv;
}

const ajv = createAjv();

function validateBySchemaId(schemaId, payload, label) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`Validator not found for ${label}`);
  }

  if (!validate(payload)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`${label} validation failed: ${detail}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(length = 8) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function stableHash(value) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function sqlitePathFallbacks(dbPath) {
  return [normalizeWorkspacePath(dbPath ?? "")];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function omitBlankOptionalString(value) {
  return isNonEmptyString(value) ? value : undefined;
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExecutionTarget(target) {
  if (!isObjectRecord(target)) {
    return undefined;
  }
  if (!isNonEmptyString(target.provider) || !isNonEmptyString(target.backend)) {
    return undefined;
  }
  return {
    provider: target.provider,
    backend: target.backend,
    ...(target.profile !== undefined ? { profile: target.profile ?? null } : {}),
    ...(Array.isArray(target.capabilities) ? { capabilities: target.capabilities.filter(isNonEmptyString) } : {})
  };
}

function normalizeRuntimeSkillName(value) {
  return String(value ?? "")
    .replaceAll("sonol-agent-runtime-codex", "sonol-agent-runtime")
    .replaceAll("sonol-agent-runtime@1.0.0", "sonol-runtime-reporting@1.0.0")
    .replaceAll("sonol-agent-runtime-codex@1.0.0", "sonol-runtime-reporting@1.0.0");
}

function canTransitionRunStatus(currentStatus, nextStatus) {
  if (!isNonEmptyString(currentStatus) || !isNonEmptyString(nextStatus)) {
    return false;
  }
  const allowed = RUN_STATUS_TRANSITIONS[currentStatus];
  return allowed ? allowed.has(nextStatus) : false;
}

function preferWorkspaceRoot(...candidates) {
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toMillis(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isReadyDependencyState(state) {
  return state === "completed" || state === "idle";
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

function workspaceMatches(record, workspaceId) {
  if (!workspaceId) {
    return true;
  }
  const recordWorkspaceId = record?.workspace_id ?? record?.plan_snapshot?.workspace_id ?? null;
  return !recordWorkspaceId || recordWorkspaceId === workspaceId;
}

function buildBaseAgentState(agentId, updatedAt, role = "Unknown") {
  return {
    agent_id: agentId,
    role,
    state: "queued",
    message: "",
    task_id: null,
    step_index: null,
    total_steps: null,
    blocked_reason: null,
    updated_at: updatedAt,
    last_event_type: "run_snapshot",
    artifact_count: 0,
    last_artifact_summary: null
  };
}

function buildAgentStates(plan, run, events) {
  const states = new Map();

  if (plan) {
    for (const agent of plan.agents) {
      states.set(agent.agent_id, buildBaseAgentState(agent.agent_id, run.updated_at, agent.role));
    }
  }

  for (const event of events) {
    const payload = event.payload ?? {};
    if (!payload.agent_id) {
      continue;
    }

    const previous = states.get(payload.agent_id) ?? buildBaseAgentState(payload.agent_id, run.updated_at);
    states.set(payload.agent_id, summarizeAgentEvent(previous, event.event_type, payload));
  }

  return states;
}

function isTerminalAgentState(state) {
  return ["completed", "failed", "cancelled"].includes(state);
}

function deriveRunStatusFromAgentStates(run, agentStates) {
  const statusSource = run.status === "prepared"
    ? agentStates.filter((state) => state.agent_id !== "agent_main")
    : agentStates;
  let nextStatus = run.status === "prepared" ? "prepared" : "queued";
  if (statusSource.some((state) => state.state === "failed")) {
    nextStatus = "failed";
  } else if (statusSource.some((state) => state.state === "cancelled")) {
    nextStatus = "cancelled";
  } else if (statusSource.some((state) => state.state === "blocked")) {
    nextStatus = "blocked";
  } else if (statusSource.length > 0 && statusSource.every((state) => state.state === "completed")) {
    nextStatus = "completed";
  } else if (statusSource.some((state) => state.state === "running" || state.state === "completed" || state.state === "idle")) {
    nextStatus = "running";
  } else if (run.status === "stale") {
    nextStatus = "stale";
  }
  return nextStatus;
}

function latestExplicitRunStatus(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = event?.payload ?? {};
    if (event?.event_type !== "session_updated") {
      continue;
    }
    if (payload.agent_id) {
      continue;
    }
    if (typeof payload.status === "string" && payload.status.length > 0) {
      return payload.status;
    }
  }

  return null;
}

function deriveEffectiveRunStatus(run, agentStates, events) {
  if (["cancelled", "completed", "failed", "stale"].includes(run.status)) {
    return run.status;
  }

  const derivedStatus = deriveRunStatusFromAgentStates(run, agentStates);
  if ((derivedStatus === "queued" || derivedStatus === "prepared") && run.status === "running") {
    return "running";
  }
  if (derivedStatus === "queued" && run.status === "prepared") {
    return "prepared";
  }

  return derivedStatus;
}

function applyMissingReportPolicy(plan, run, states) {
  if (!plan || !["queued", "prepared", "running", "blocked"].includes(run.status)) {
    return states;
  }

  const now = Date.now();
  const activeIds = new Set(run.active_agent_ids ?? []);
  const startedAtMs = toMillis(run.started_at ?? run.created_at ?? run.updated_at) ?? now;

  for (const agent of plan.agents) {
    if (isMainAgent(agent)) {
      continue;
    }

    if (activeIds.size > 0 && !activeIds.has(agent.agent_id)) {
      continue;
    }

    const current = states.get(agent.agent_id) ?? buildBaseAgentState(agent.agent_id, run.updated_at, agent.role);
    if (!["queued", "running"].includes(current.state)) {
      continue;
    }

    if (current.last_event_type !== "session_updated") {
      continue;
    }

    const dependencyIds = agent.depends_on ?? [];
    const dependenciesReady = dependencyIds.every((dependencyId) => {
      const dependencyState = states.get(dependencyId);
      return dependencyState ? isReadyDependencyState(dependencyState.state) : false;
    });

    if (dependencyIds.length > 0 && !dependenciesReady) {
      continue;
    }

    const launchBaselineMs = toMillis(current.updated_at) ?? startedAtMs;

    const readySince = dependencyIds.length > 0
      ? Math.max(
          launchBaselineMs,
          ...dependencyIds.map((dependencyId) =>
            toMillis(states.get(dependencyId)?.updated_at) ?? startedAtMs
          )
        )
      : launchBaselineMs;

    if (now - readySince < MISSING_SUBAGENT_REPORT_GRACE_MS) {
      continue;
    }

    states.set(agent.agent_id, {
      ...current,
      role: agent.role,
      state: "blocked",
      message: runtimeDefaultPhrases(plan.preferred_language).missingReportMessage,
      blocked_reason: runtimeDefaultPhrases(plan.preferred_language).missingReportReason,
      updated_at: new Date(readySince).toISOString(),
      last_event_type: "auto_missing_report"
    });
  }

  return states;
}

function applyTerminalRunProjection(plan, run, states) {
  if (!plan || !["completed", "failed", "cancelled"].includes(run.status)) {
    return states;
  }

  const mainAgent = (plan.agents ?? []).find((agent) => isMainAgent(agent));
  if (!mainAgent) {
    return states;
  }

  const current = states.get(mainAgent.agent_id) ?? buildBaseAgentState(mainAgent.agent_id, run.updated_at, mainAgent.role);
  if (isTerminalAgentState(current.state)) {
    return states;
  }

  const projectedState = run.status === "completed"
    ? "completed"
    : run.status === "failed"
      ? "failed"
      : "cancelled";
  const projectedMessage = current.message || (
    run.status === "completed"
      ? localize(plan.preferred_language, "최종 통합 완료", "Main integration completed.")
      : run.status === "failed"
        ? localize(plan.preferred_language, "실행이 실패로 종료되었습니다.", "The run ended in failure.")
        : localize(plan.preferred_language, "실행이 취소되었습니다.", "The run was cancelled.")
  );

  states.set(mainAgent.agent_id, {
    ...current,
    role: mainAgent.role,
    state: projectedState,
    message: projectedMessage,
    task_id: current.task_id ?? mainAgent.current_task_id ?? mainAgent.assigned_task_ids?.[0] ?? null,
    updated_at: run.ended_at ?? run.updated_at ?? current.updated_at,
    last_event_type: "run_terminal_projection"
  });

  return states;
}

function collectLaunchCandidates(plan, run, states) {
  if (!plan || !["queued", "prepared", "running", "blocked"].includes(run.status)) {
    return [];
  }

  const launchableAgents = [];
  for (const agent of plan.agents) {
    if (isMainAgent(agent)) {
      continue;
    }

    const current = states.get(agent.agent_id) ?? buildBaseAgentState(agent.agent_id, run.updated_at, agent.role);
    if (current.last_event_type !== "run_snapshot" || current.state !== "queued") {
      continue;
    }

    const dependencyIds = agent.depends_on ?? [];
    const dependenciesReady = dependencyIds.every((dependencyId) => {
      const dependencyState = states.get(dependencyId);
      return dependencyState ? isReadyDependencyState(dependencyState.state) : false;
    });

    if (dependencyIds.length > 0 && !dependenciesReady) {
      continue;
    }

    launchableAgents.push({ agent, current });
  }

  return launchableAgents;
}

function applyLaunchPolicy(_appendEventFn, _plan, _run, states) {
  return states;
}

function summarizeAgentEvent(existing, eventType, payload) {
  const next = {
    agent_id: payload.agent_id,
    state: existing?.state ?? "queued",
    message: existing?.message ?? "",
    task_id: existing?.task_id ?? null,
    step_index: existing?.step_index ?? null,
    total_steps: existing?.total_steps ?? null,
    blocked_reason: existing?.blocked_reason ?? null,
    updated_at: payload.timestamp ?? nowIso(),
    last_event_type: eventType,
    artifact_count: existing?.artifact_count ?? 0,
    last_artifact_summary: existing?.last_artifact_summary ?? null
  };

  if (eventType === "progress_event") {
    next.state = payload.state ?? next.state;
    next.message = payload.message ?? next.message;
    next.task_id = payload.task_id ?? next.task_id;
    next.step_index = payload.step_index ?? next.step_index;
    next.total_steps = payload.total_steps ?? next.total_steps;
  } else if (eventType === "session_updated") {
    next.state = payload.status ?? next.state;
    next.message = payload.message ?? next.message;
    next.task_id = payload.task_id ?? next.task_id;
    next.blocked_reason = payload.blocked_reason ?? next.blocked_reason;
  } else if (eventType === "completion_event") {
    next.state = payload.result === "failure" ? "failed" : "completed";
    next.message = payload.summary ?? next.message;
    next.task_id = payload.task_id ?? next.task_id;
    if (Array.isArray(payload.next_actions) && payload.next_actions.includes("reconciled-by-main")) {
      next.last_event_type = "auto_completed_by_main";
    }
  } else if (eventType === "artifact_event") {
    next.artifact_count += 1;
    next.last_artifact_summary = payload.summary ?? next.last_artifact_summary;
    next.message = payload.summary ?? next.message;
  }

  return next;
}

function ensureParentDirectory(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
}

function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(status);
}

function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

function shouldAutoStaleRun(run) {
  if (run?.status !== "blocked") {
    return false;
  }
  const updatedMs = toMillis(run.updated_at ?? run.started_at ?? run.created_at ?? "");
  if (updatedMs === null) {
    return false;
  }
  return Date.now() - updatedMs >= BLOCKED_RUN_STALE_MS;
}

function normalizeRunForRead(run) {
  if (!run) {
    return run;
  }
  if (!shouldAutoStaleRun(run)) {
    return run;
  }
  return {
    ...run,
    status: "stale",
    ended_at: run.ended_at ?? nowIso()
  };
}

function deriveRuntimeStatusForRead(plan, run, events) {
  let states = buildAgentStates(plan, run, events);
  const agentStates = Array.from(applyMissingReportPolicy(plan, run, states).values());
  let nextStatus = deriveEffectiveRunStatus(run, agentStates, events);
  if (nextStatus === "blocked") {
    const latestAgentUpdate = agentStates
      .map((state) => toMillis(state.updated_at))
      .filter((value) => value !== null)
      .sort((left, right) => right - left)[0];
    const blockBaseline = latestAgentUpdate ?? toMillis(run.updated_at ?? run.started_at ?? run.created_at ?? "") ?? Date.now();
    if (Date.now() - blockBaseline >= BLOCKED_RUN_STALE_MS) {
      nextStatus = "stale";
    }
  }
  return nextStatus;
}

function hydratePlanRecord(plan, fallbackWorkspace = null) {
  const preferredLanguage = plan.preferred_language ?? detectPreferredLanguage(plan.request_summary, "ko");
  const workspaceId = plan.workspace_id ?? fallbackWorkspace?.workspace_id ?? workspaceScopeId(detectWorkspaceRoot());
  const sameWorkspaceFallback =
    fallbackWorkspace?.workspace_id && workspaceId === fallbackWorkspace.workspace_id
      ? fallbackWorkspace.workspace_root
      : null;
  const workspaceRoot = preferWorkspaceRoot(
    plan.workspace_root,
    sameWorkspaceFallback,
    fallbackWorkspace?.workspace_root,
    detectWorkspaceRoot()
  );
  const planningBackend = normalizeText(plan.planning_backend, "");
  const planningDriver = normalizeText(plan.planning_driver, "");
  const normalizeLegacyPlannerMetadata = Boolean(planningBackend && planningBackend !== SONOL_PLANNER_BACKEND && !planningDriver);
  const normalizedPlanningBackend = normalizeLegacyPlannerMetadata
    ? SONOL_PLANNER_BACKEND
    : planningBackend || null;
  const normalizedPlanningDriver = normalizeLegacyPlannerMetadata
    ? SONOL_PLANNER_DRIVER
    : planningDriver || null;
  const authoritativeDbPath = normalizeText(
    plan.authoritative_db_path,
    resolveDefaultDbPath({ workspaceRoot })
  );
  return {
    ...plan,
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
    preferred_language: preferredLanguage,
    authoritative_db_path: authoritativeDbPath,
    ...(normalizedPlanningBackend ? { planning_backend: normalizedPlanningBackend } : {}),
    ...(normalizedPlanningDriver ? { planning_driver: normalizedPlanningDriver } : {}),
    agents: (plan.agents ?? []).map((agent) => {
      const normalizedAssignedTaskIds = Array.isArray(agent.assigned_task_ids)
        ? agent.assigned_task_ids.filter(isNonEmptyString).slice(0, 1)
        : [];
      const normalizedCurrentTaskId = omitBlankOptionalString(agent.current_task_id)
        ?? normalizedAssignedTaskIds[0]
        ?? null;
      return {
        ...agent,
        role_label: agent.role_label ?? agent.role,
        execution_class: normalizeExecutionClass(agent),
        ...(omitBlankOptionalString(agent.workstream_id) ? { workstream_id: agent.workstream_id } : {}),
        ...(omitBlankOptionalString(agent.selection_rationale) ? { selection_rationale: agent.selection_rationale } : {}),
        preferred_language: agent.preferred_language ?? preferredLanguage,
        provider_agent_type: agent.provider_agent_type ?? agent.codex_agent_type ?? "default",
        ...(omitBlankOptionalString(agent.codex_agent_type) ? { codex_agent_type: agent.codex_agent_type } : {}),
        ...(normalizeExecutionTarget(agent.execution_target) ? { execution_target: normalizeExecutionTarget(agent.execution_target) } : {}),
        reporting_contract: normalizeRuntimeSkillName(agent.reporting_contract ?? "sonol-runtime-reporting@1.0.0"),
        skills_config: Array.from(new Set([
          ...(Array.isArray(agent.skills_config)
            ? agent.skills_config.map((entry) => normalizeRuntimeSkillName(entry))
            : []),
          ...(isMainAgent(agent) ? [] : ["sonol-agent-runtime"])
        ])),
        assigned_task_ids: normalizedAssignedTaskIds,
        current_task_id: normalizedCurrentTaskId,
        developer_instructions: agent.developer_instructions ?? "",
        operational_constraints: Array.isArray(agent.operational_constraints)
          ? [...agent.operational_constraints]
          : []
      };
    })
  };
}

function hydrateRunRecord(run, fallbackWorkspace = null) {
  const planSnapshot = run?.plan_snapshot && typeof run.plan_snapshot === "object"
    ? hydratePlanRecord(run.plan_snapshot, fallbackWorkspace)
    : null;
  const workspaceId = run.workspace_id ?? planSnapshot?.workspace_id ?? fallbackWorkspace?.workspace_id ?? null;
  const sameWorkspaceFallback =
    fallbackWorkspace?.workspace_id && workspaceId === fallbackWorkspace.workspace_id
      ? fallbackWorkspace.workspace_root
      : null;
  const workspaceRoot = preferWorkspaceRoot(
    run.workspace_root,
    planSnapshot?.workspace_root,
    sameWorkspaceFallback,
    fallbackWorkspace?.workspace_root,
    null
  );
  const resolvedMode = run.resolved_mode ?? run.mode ?? "dry-run";
  return {
    ...run,
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
    source_plan_updated_at: run.source_plan_updated_at ?? planSnapshot?.updated_at ?? run.updated_at ?? run.created_at ?? nowIso(),
    source_approval_status: run.source_approval_status ?? planSnapshot?.approval_status ?? "draft",
    resolved_mode: resolvedMode,
    cancel_reason: run.cancel_reason ?? null,
    active_agent_ids: Array.isArray(run.active_agent_ids)
      ? run.active_agent_ids.filter(isNonEmptyString)
      : (planSnapshot?.agents ?? []).map((agent) => agent.agent_id),
    provider_refs: normalizeProviderRefs(run.provider_refs),
    runtime_bindings: run.runtime_bindings ?? {
      binding_id: null,
      workspace_id: workspaceId,
      db_path: null,
      runtime_root: null
    },
    plan_snapshot: planSnapshot
  };
}

function normalizeProviderRefs(value) {
  const refs = value && typeof value === "object" ? value : {};
  const normalizeTruth = (input, fallback, allowed) => {
    const normalized = normalizeText(input, fallback);
    return allowed.has(normalized) ? normalized : fallback;
  };
  return {
    provider_run_id: normalizeText(refs.provider_run_id, "") || null,
    conversation_id: normalizeText(refs.conversation_id, "") || null,
    thread_id: normalizeText(refs.thread_id, "") || null,
    session_id: normalizeText(refs.session_id, "") || null,
    main_provider_session_kind: normalizeText(refs.main_provider_session_kind, "") || null,
    main_provider_session_id: normalizeText(refs.main_provider_session_id, "") || null,
    main_provider_session_thread_id: normalizeText(refs.main_provider_session_thread_id, "") || null,
    main_provider_session_file: normalizeText(refs.main_provider_session_file, "") || null,
    launch_truth_source: normalizeTruth(refs.launch_truth_source, "none", new Set(["none", "manifest_only", "provider_native"])),
    status_truth_source: normalizeTruth(refs.status_truth_source, "none", new Set(["none", "local_projection", "provider_native"])),
    launch_surface: normalizeText(refs.launch_surface, "") || null,
    dispatch_mode: normalizeText(refs.dispatch_mode, "") || null,
    status_transport: normalizeText(refs.status_transport, "") || null,
    remote_status_supported: typeof refs.remote_status_supported === "boolean" ? refs.remote_status_supported : false,
    remote_cancel_supported: typeof refs.remote_cancel_supported === "boolean" ? refs.remote_cancel_supported : false
  };
}

function normalizeComparablePath(value) {
  const normalized = normalizeText(value, "");
  return normalized ? resolve(normalized).toLowerCase() : null;
}

function validateReportMainReporterIdentity(run, options = {}) {
  const refs = normalizeProviderRefs(run?.provider_refs);
  const expectedKind = refs.main_provider_session_kind ?? null;
  const expectedSessionId = refs.main_provider_session_id ?? null;
  const expectedThreadId = refs.main_provider_session_thread_id ?? null;
  const expectedFile = normalizeComparablePath(refs.main_provider_session_file);
  const reporterKind = normalizeText(options.reporter_session_kind, "") || null;
  const reporterSessionId = normalizeText(options.reporter_session_id, "") || null;
  const reporterThreadId = normalizeText(options.reporter_session_thread_id, "") || null;
  const reporterFile = normalizeComparablePath(options.reporter_session_file);
  const matchedClaudeTranscript = expectedKind === "claude-code"
    && Boolean(expectedFile)
    && Boolean(reporterFile)
    && reporterFile === expectedFile;
  const effectiveReporterSessionId = expectedKind === "claude-code"
    ? (reporterSessionId || (matchedClaudeTranscript ? expectedSessionId : null))
    : reporterSessionId;

  const missingCodexIdentity = expectedKind === "codex" && !expectedThreadId;
  const missingClaudeIdentity = expectedKind === "claude-code" && !expectedSessionId && !expectedFile;
  if (!expectedKind || missingCodexIdentity || missingClaudeIdentity) {
    throw new Error(
      `Run ${run.run_id} is missing main session identity. Re-confirm or retry the run before using report-main.`
    );
  }

  if (reporterKind !== expectedKind) {
    throw new Error(
      `report-main caller kind mismatch for run ${run.run_id}: expected ${expectedKind}, received ${reporterKind ?? "missing"}.`
    );
  }

  if (expectedKind === "codex" && reporterThreadId !== expectedThreadId) {
    throw new Error(
      `report-main caller thread mismatch for run ${run.run_id}: expected ${expectedThreadId}, received ${reporterThreadId ?? "missing"}.`
    );
  }

  if (expectedKind === "claude-code" && expectedSessionId && effectiveReporterSessionId !== expectedSessionId) {
    throw new Error(
      `report-main caller session mismatch for run ${run.run_id}: expected ${expectedSessionId}, received ${reporterSessionId ?? "missing"}.`
    );
  }

  if (expectedFile && reporterFile && reporterFile !== expectedFile) {
    throw new Error(
      `report-main caller transcript mismatch for run ${run.run_id}: expected ${refs.main_provider_session_file}, received ${options.reporter_session_file}.`
    );
  }
}

export function openStore(dbPath = resolveDefaultDbPath(), options = {}) {
  return openStoreWithOptions(dbPath, options);
}

export function openStoreWithOptions(dbPath = resolveDefaultDbPath(), options = {}) {
  const resolvedDbPath = resolve(dbPath ?? "");
  const candidateDbPaths = sqlitePathFallbacks(resolvedDbPath);
  if (!options.readOnly) {
    ensureParentDirectory(resolvedDbPath);
  }
  let storeWorkspace = workspaceContextForDbPath(resolvedDbPath, {
    startDir: options.startDir ?? process.cwd(),
    workspaceRoot: options.workspaceRoot ?? null
  });
  const dbAlreadyExists = candidateDbPaths.some((candidate) => existsSync(candidate));
  let db = null;
  let openedDbPath = candidateDbPaths[0];
  let openError = null;
  for (const candidate of candidateDbPaths) {
    try {
      if (!options.readOnly) {
        ensureParentDirectory(candidate);
      }
      db = new DatabaseSync(candidate, options.readOnly ? { readOnly: true } : {});
      openedDbPath = candidate;
      break;
    } catch (error) {
      openError = error;
    }
  }
  if (!db) {
    throw openError;
  }
  let transactionDepth = 0;
  db.exec(`
    PRAGMA busy_timeout = 15000;
    PRAGMA temp_store = MEMORY;
  `);

  const existingTables = new Set(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('plans', 'runs', 'events', 'audit_log')
    `).all().map((row) => row.name)
  );

  const missingCoreTables =
    !existingTables.has("plans") ||
    !existingTables.has("runs") ||
    !existingTables.has("events") ||
    !existingTables.has("audit_log");

  if (!options.readOnly && (!dbAlreadyExists || missingCoreTables)) {
    db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS plans (
      plan_id TEXT PRIMARY KEY,
      request_summary TEXT NOT NULL,
      single_or_multi TEXT NOT NULL,
      approval_status TEXT NOT NULL,
      context_version INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_snapshot_version INTEGER NOT NULL,
      mode TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      retry_of TEXT,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      state TEXT,
      message TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ref_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  }

  if (!options.readOnly) {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS plan_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        context_version INTEGER NOT NULL,
        approval_status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plans_updated_at ON plans(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plans_workspace_json ON plans(json_extract(data_json, '$.workspace_id'));
      CREATE INDEX IF NOT EXISTS idx_runs_plan_status ON runs(plan_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_workspace_json ON runs(json_extract(data_json, '$.workspace_id'));

      CREATE TABLE IF NOT EXISTS workspace_state (
        workspace_id TEXT PRIMARY KEY,
        workspace_root TEXT,
        active_plan_id TEXT,
        pending_request_summary TEXT,
        pending_request_started_at TEXT,
        pending_request_error TEXT,
        pending_previous_plan_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_registry (
        workspace_id TEXT PRIMARY KEY,
        workspace_root TEXT,
        preferred_db_path TEXT NOT NULL,
        preferred_runtime_root TEXT NOT NULL,
        binding_id TEXT,
        source_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planner_jobs (
        job_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        planner_backend TEXT NOT NULL,
        planner_driver TEXT NOT NULL,
        binding_id TEXT,
        binding_json TEXT,
        started_at TEXT,
        heartbeat_at TEXT,
        ended_at TEXT,
        error_code TEXT,
        error_message TEXT,
        stdout_tail TEXT,
        stderr_tail TEXT,
        result_plan_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_state_active_plan ON workspace_state(active_plan_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_registry_updated_at ON workspace_registry(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_planner_jobs_workspace_created ON planner_jobs(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_planner_jobs_workspace_status ON planner_jobs(workspace_id, status, updated_at DESC);
      DROP INDEX IF EXISTS idx_planner_jobs_single_flight;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_jobs_running_request
      ON planner_jobs(workspace_id, request_hash)
      WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS idx_events_run_created ON events(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_plan_json ON events(json_extract(payload_json, '$.plan_id'));
      CREATE VIEW IF NOT EXISTS runtime_events AS
      SELECT
        event_id,
        run_id,
        agent_id,
        event_type,
        state,
        message,
        payload_json,
        created_at
      FROM events;
      CREATE INDEX IF NOT EXISTS idx_audit_ref_created ON audit_log(ref_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_unique ON plan_revisions(plan_id, context_version);
      CREATE INDEX IF NOT EXISTS idx_plan_revisions_saved_at ON plan_revisions(saved_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_revisions_unique ON run_revisions(run_id, saved_at);
      CREATE INDEX IF NOT EXISTS idx_run_revisions_plan_saved_at ON run_revisions(plan_id, saved_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_runs_plan_exists_insert
      BEFORE INSERT ON runs
      FOR EACH ROW
      WHEN (SELECT COUNT(1) FROM plans WHERE plan_id = NEW.plan_id) = 0
      BEGIN
        SELECT RAISE(ABORT, 'runs.plan_id must reference an existing plan');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_runs_plan_exists_update
      BEFORE UPDATE OF plan_id ON runs
      FOR EACH ROW
      WHEN (SELECT COUNT(1) FROM plans WHERE plan_id = NEW.plan_id) = 0
      BEGIN
        SELECT RAISE(ABORT, 'runs.plan_id must reference an existing plan');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_events_run_exists_insert
      BEFORE INSERT ON events
      FOR EACH ROW
      WHEN NEW.run_id IS NOT NULL AND (SELECT COUNT(1) FROM runs WHERE run_id = NEW.run_id) = 0
      BEGIN
        SELECT RAISE(ABORT, 'events.run_id must reference an existing run');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_events_run_exists_update
      BEFORE UPDATE OF run_id ON events
      FOR EACH ROW
      WHEN NEW.run_id IS NOT NULL AND (SELECT COUNT(1) FROM runs WHERE run_id = NEW.run_id) = 0
      BEGIN
        SELECT RAISE(ABORT, 'events.run_id must reference an existing run');
      END;
    `);
  } else {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = ON;
    `);
  }

  function withImmediateTransaction(work) {
    if (transactionDepth > 0) {
      transactionDepth += 1;
      try {
        return work();
      } finally {
        transactionDepth -= 1;
      }
    }

    db.exec("BEGIN IMMEDIATE");
    transactionDepth += 1;
    try {
      const result = work();
      transactionDepth -= 1;
      db.exec("COMMIT");
      return result;
    } catch (error) {
      transactionDepth = Math.max(0, transactionDepth - 1);
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }

  function tableExists(tableName) {
    const row = db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName);
    return Boolean(row);
  }

  function columnExists(tableName, columnName) {
    if (!tableExists(tableName)) {
      return false;
    }
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => row.name === columnName);
  }

  function appendAudit(kind, refId, message) {
    db.prepare(`
      INSERT INTO audit_log (kind, ref_id, message, created_at)
      VALUES (?, ?, ?, ?)
    `).run(kind, refId, message, nowIso());
    appendStructuredLog("sonol-runtime", {
      action: "audit_log_written",
      audit_kind: kind,
      ref_id: refId,
      message
    });
  }

  function latestPlanIdForWorkspace(workspaceId = storeWorkspace.workspace_id) {
    const row = db.prepare(`
      SELECT plan_id
      FROM plans
      WHERE json_extract(data_json, '$.workspace_id') = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(workspaceId);
    return row?.plan_id ?? null;
  }

  function getWorkspaceState() {
    const row = db.prepare(`
      SELECT workspace_id, workspace_root, active_plan_id, pending_request_summary,
             pending_request_started_at, pending_request_error, pending_previous_plan_id, updated_at
      FROM workspace_state
      WHERE workspace_id = ?
    `).get(storeWorkspace.workspace_id);

    const fallbackActivePlanId = latestPlanIdForWorkspace(storeWorkspace.workspace_id);

    if (!row) {
      return defaultWorkspaceState(storeWorkspace, fallbackActivePlanId);
    }

    const next = {
      workspace_id: row.workspace_id ?? storeWorkspace.workspace_id,
      workspace_root: row.workspace_id === storeWorkspace.workspace_id
        ? preferWorkspaceRoot(storeWorkspace.workspace_root, row.workspace_root)
        : preferWorkspaceRoot(row.workspace_root, storeWorkspace.workspace_root),
      active_plan_id: row.active_plan_id ?? null,
      pending_request_summary: row.pending_request_summary ?? null,
      pending_request_started_at: row.pending_request_started_at ?? null,
      pending_request_error: row.pending_request_error ?? null,
      pending_previous_plan_id: row.pending_previous_plan_id ?? null,
      updated_at: row.updated_at ?? nowIso()
    };

    if (next.active_plan_id) {
      const planExists = db.prepare("SELECT 1 FROM plans WHERE plan_id = ?").get(next.active_plan_id);
      if (!planExists) {
        next.active_plan_id = fallbackActivePlanId;
      }
    } else if (!next.pending_request_summary) {
      next.active_plan_id = fallbackActivePlanId;
    }

    if (next.pending_previous_plan_id) {
      const previousPlanExists = db.prepare("SELECT 1 FROM plans WHERE plan_id = ?").get(next.pending_previous_plan_id);
      if (!previousPlanExists) {
        next.pending_previous_plan_id = null;
      }
    }

    return next;
  }

  function saveWorkspaceState(partialState = {}) {
    return withImmediateTransaction(() => {
      const current = getWorkspaceState();
      const next = {
        ...current,
        ...partialState,
        workspace_id: storeWorkspace.workspace_id,
        workspace_root: preferWorkspaceRoot(
          partialState.workspace_root,
          current.workspace_root,
          storeWorkspace.workspace_root
        ),
        updated_at: nowIso()
      };

      db.prepare(`
        INSERT INTO workspace_state (
          workspace_id, workspace_root, active_plan_id, pending_request_summary,
          pending_request_started_at, pending_request_error, pending_previous_plan_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          workspace_root = excluded.workspace_root,
          active_plan_id = excluded.active_plan_id,
          pending_request_summary = excluded.pending_request_summary,
          pending_request_started_at = excluded.pending_request_started_at,
          pending_request_error = excluded.pending_request_error,
          pending_previous_plan_id = excluded.pending_previous_plan_id,
          updated_at = excluded.updated_at
      `).run(
        next.workspace_id,
        next.workspace_root,
        next.active_plan_id,
        next.pending_request_summary,
        next.pending_request_started_at,
        next.pending_request_error,
        next.pending_previous_plan_id,
        next.updated_at
      );

      appendStructuredLog("sonol-runtime", {
        action: "workspace_state_saved",
        workspace_id: next.workspace_id,
        active_plan_id: next.active_plan_id,
        pending_request_summary: next.pending_request_summary
      });
      return next;
    });
  }

  function reconcileWorkspaceRoots() {
    const targetWorkspaceRoot = preferWorkspaceRoot(storeWorkspace.workspace_root, getWorkspaceState().workspace_root);
    if (!targetWorkspaceRoot) {
      return;
    }
    return withImmediateTransaction(() => {
      const planRows = db.prepare(`
        SELECT plan_id, data_json
        FROM plans
        WHERE json_extract(data_json, '$.workspace_id') = ?
      `).all(storeWorkspace.workspace_id);

      for (const row of planRows) {
        try {
          const plan = hydratePlanRecord(JSON.parse(row.data_json), storeWorkspace);
          if (plan.workspace_root === targetWorkspaceRoot) {
            continue;
          }
          const normalized = {
            ...plan,
            workspace_root: targetWorkspaceRoot,
            updated_at: plan.updated_at ?? nowIso()
          };
          db.prepare(`
            UPDATE plans
            SET data_json = ?, updated_at = ?
            WHERE plan_id = ?
          `).run(JSON.stringify(normalized), normalized.updated_at, row.plan_id);
        } catch {
        }
      }

      const runRows = db.prepare(`
        SELECT run_id, data_json
        FROM runs
        WHERE json_extract(data_json, '$.workspace_id') = ?
      `).all(storeWorkspace.workspace_id);

      for (const row of runRows) {
        try {
          const run = hydrateRunRecord(JSON.parse(row.data_json), storeWorkspace);
          const nextPlanSnapshot = run.plan_snapshot
            ? {
                ...run.plan_snapshot,
                workspace_root: targetWorkspaceRoot
              }
            : run.plan_snapshot;
          const normalized = {
            ...run,
            workspace_root: targetWorkspaceRoot,
            plan_snapshot: nextPlanSnapshot,
            updated_at: run.updated_at ?? nowIso()
          };
          db.prepare(`
            UPDATE runs
            SET data_json = ?, updated_at = ?
            WHERE run_id = ?
          `).run(JSON.stringify(normalized), normalized.updated_at, row.run_id);
        } catch {
        }
      }

      db.prepare(`
        UPDATE workspace_state
        SET workspace_root = ?, updated_at = ?
        WHERE workspace_id = ?
      `).run(targetWorkspaceRoot, nowIso(), storeWorkspace.workspace_id);
    });
  }

  function ensureWorkspaceStateSeeded() {
    const existing = db.prepare("SELECT 1 FROM workspace_state WHERE workspace_id = ?").get(storeWorkspace.workspace_id);
    if (existing) {
      return getWorkspaceState();
    }
    return saveWorkspaceState({
      active_plan_id: latestPlanIdForWorkspace(storeWorkspace.workspace_id),
      pending_request_summary: null,
      pending_request_started_at: null,
      pending_request_error: null,
      pending_previous_plan_id: null
    });
  }

  function reclaimStalePlanningActivity() {
    const cutoffIso = new Date(Date.now() - PLANNER_JOB_STALE_MS).toISOString();
    return withImmediateTransaction(() => {
      if (tableExists("planner_jobs")) {
        db.prepare(`
          UPDATE planner_jobs
          SET status = 'timed_out',
              heartbeat_at = COALESCE(heartbeat_at, ?),
              ended_at = COALESCE(ended_at, ?),
              error_code = COALESCE(error_code, 'PLANNER_STALE_TIMEOUT'),
              error_message = COALESCE(error_message, 'planner job timed out without heartbeat'),
              updated_at = ?
          WHERE workspace_id = ?
            AND status IN ('queued', 'running')
            AND COALESCE(heartbeat_at, started_at, created_at, updated_at) <= ?
        `).run(cutoffIso, cutoffIso, nowIso(), storeWorkspace.workspace_id, cutoffIso);
      }

      const state = getWorkspaceState();
      const pendingStartedAtMs = toMillis(state.pending_request_started_at ?? "");
      const hasLiveJob = tableExists("planner_jobs")
        ? Boolean(db.prepare(`
            SELECT 1
            FROM planner_jobs
            WHERE workspace_id = ?
              AND status IN ('queued', 'running')
              AND COALESCE(heartbeat_at, started_at, created_at, updated_at) > ?
            LIMIT 1
          `).get(storeWorkspace.workspace_id, cutoffIso))
        : false;

      const pendingIsStale = pendingStartedAtMs !== null && (Date.now() - pendingStartedAtMs) >= PLANNER_PENDING_STALE_MS;
      if (state.pending_request_summary && pendingIsStale && !hasLiveJob) {
        saveWorkspaceState({
          active_plan_id: state.pending_previous_plan_id ?? state.active_plan_id ?? latestPlanIdForWorkspace(storeWorkspace.workspace_id),
          pending_request_summary: null,
          pending_request_started_at: null,
          pending_request_error: localize("ko", "오래된 planner 요청을 정리했습니다.", "Reclaimed a stale planner request."),
          pending_previous_plan_id: null
        });
      }
    });
  }

  function setActivePlan(planId) {
    return saveWorkspaceState({
      active_plan_id: planId ?? null,
      pending_request_error: null
    });
  }

  function beginPlanningRequest(requestSummary) {
    reclaimStalePlanningActivity();
    const current = getWorkspaceState();
    return saveWorkspaceState({
      active_plan_id: null,
      pending_request_summary: normalizeText(requestSummary),
      pending_request_started_at: nowIso(),
      pending_request_error: null,
      pending_previous_plan_id: current.active_plan_id ?? null
    });
  }

  function claimPlanningRequest(requestSummary) {
    return withImmediateTransaction(() => {
      reclaimStalePlanningActivity();
      const current = getWorkspaceState();
      const normalizedSummary = normalizeText(requestSummary);
      const pendingSummary = normalizeText(current.pending_request_summary, "");
      if (pendingSummary) {
        return {
          ok: false,
          code: pendingSummary === normalizedSummary ? "DUPLICATE_PENDING_REQUEST" : "ANOTHER_PENDING_REQUEST",
          pending_request_summary: pendingSummary,
          workspace_state: current
        };
      }
      const next = saveWorkspaceState({
        active_plan_id: null,
        pending_request_summary: normalizedSummary,
        pending_request_started_at: nowIso(),
        pending_request_error: null,
        pending_previous_plan_id: current.active_plan_id ?? null
      });
      return {
        ok: true,
        workspace_state: next
      };
    });
  }

  function completePlanningRequest(planId) {
    return saveWorkspaceState({
      active_plan_id: planId ?? null,
      pending_request_summary: null,
      pending_request_started_at: null,
      pending_request_error: null,
      pending_previous_plan_id: null
    });
  }

  function failPlanningRequest(message) {
    const current = getWorkspaceState();
    return saveWorkspaceState({
      active_plan_id: current.pending_previous_plan_id ?? current.active_plan_id ?? latestPlanIdForWorkspace(storeWorkspace.workspace_id),
      pending_request_summary: null,
      pending_request_started_at: null,
      pending_request_error: normalizeText(message, "planning failed"),
      pending_previous_plan_id: null
    });
  }

  function getWorkspaceRegistryEntry(workspaceId = storeWorkspace.workspace_id) {
    if (!tableExists("workspace_registry")) {
      return null;
    }
    const row = db.prepare(`
      SELECT workspace_id, workspace_root, preferred_db_path, preferred_runtime_root, binding_id, source_json, updated_at
      FROM workspace_registry
      WHERE workspace_id = ?
    `).get(workspaceId);

    if (!row) {
      return null;
    }

    let source = null;
    try {
      source = row.source_json ? JSON.parse(row.source_json) : null;
    } catch {
      source = null;
    }

    return {
      workspace_id: row.workspace_id,
      workspace_root: row.workspace_root ?? null,
      preferred_db_path: row.preferred_db_path,
      preferred_runtime_root: row.preferred_runtime_root,
      binding_id: row.binding_id ?? null,
      source,
      updated_at: row.updated_at ?? nowIso()
    };
  }

  function upsertWorkspaceRegistry(entry = {}) {
    const next = {
      workspace_id: entry.workspace_id ?? storeWorkspace.workspace_id,
      workspace_root: preferWorkspaceRoot(entry.workspace_root, storeWorkspace.workspace_root),
      preferred_db_path: resolve(entry.preferred_db_path ?? openedDbPath),
      preferred_runtime_root: resolve(
        entry.preferred_runtime_root
          ?? options.runtimeRoot
          ?? resolveDefaultRuntimeRoot({
            workspaceRoot: preferWorkspaceRoot(entry.workspace_root, storeWorkspace.workspace_root),
            startDir: preferWorkspaceRoot(entry.workspace_root, storeWorkspace.workspace_root, options.startDir)
          })
      ),
      binding_id: normalizeText(entry.binding_id, "") || null,
      source: entry.source ?? null,
      updated_at: nowIso()
    };

    return withImmediateTransaction(() => {
      db.prepare(`
        INSERT INTO workspace_registry (
          workspace_id, workspace_root, preferred_db_path, preferred_runtime_root, binding_id, source_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          workspace_root = excluded.workspace_root,
          preferred_db_path = excluded.preferred_db_path,
          preferred_runtime_root = excluded.preferred_runtime_root,
          binding_id = excluded.binding_id,
          source_json = excluded.source_json,
          updated_at = excluded.updated_at
      `).run(
        next.workspace_id,
        next.workspace_root,
        next.preferred_db_path,
        next.preferred_runtime_root,
        next.binding_id,
        next.source ? JSON.stringify(next.source) : null,
        next.updated_at
      );
      return getWorkspaceRegistryEntry(next.workspace_id);
    });
  }

  function getPlannerJob(jobId) {
    if (!tableExists("planner_jobs")) {
      return null;
    }
    const hasPlannerDriver = columnExists("planner_jobs", "planner_driver");
    const row = db.prepare(`
      SELECT job_id, workspace_id, request_hash, request_summary, status, planner_backend${hasPlannerDriver ? ", planner_driver" : ""},
             binding_id, binding_json, started_at, heartbeat_at, ended_at, error_code,
             error_message, stdout_tail, stderr_tail, result_plan_id, created_at, updated_at
      FROM planner_jobs
      WHERE job_id = ?
    `).get(jobId);

    if (!row) {
      return null;
    }

    let binding = null;
    try {
      binding = row.binding_json ? JSON.parse(row.binding_json) : null;
    } catch {
      binding = null;
    }

    return {
      job_id: row.job_id,
      workspace_id: row.workspace_id,
      request_hash: row.request_hash,
      request_summary: row.request_summary,
      status: row.status,
      planner_backend: row.planner_backend,
      planner_driver: row.planner_driver ?? row.planner_backend,
      binding_id: row.binding_id ?? null,
      binding,
      started_at: row.started_at ?? null,
      heartbeat_at: row.heartbeat_at ?? null,
      ended_at: row.ended_at ?? null,
      error_code: row.error_code ?? null,
      error_message: row.error_message ?? null,
      stdout_tail: row.stdout_tail ?? null,
      stderr_tail: row.stderr_tail ?? null,
      result_plan_id: row.result_plan_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  function listPlannerJobs(workspaceId = storeWorkspace.workspace_id, { limit = 20 } = {}) {
    if (!tableExists("planner_jobs")) {
      return [];
    }
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 20;
    return db.prepare(`
      SELECT job_id
      FROM planner_jobs
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workspaceId, safeLimit).map((row) => getPlannerJob(row.job_id)).filter(Boolean);
  }

  function createPlannerJob(payload = {}) {
    const timestamp = nowIso();
    const requestSummary = normalizeText(payload.request_summary, "");
    const requestHash = normalizeText(payload.request_hash, "") || stableHash(`${storeWorkspace.workspace_id}:${requestSummary}`);
    const initialStatus = payload.status ?? "queued";
    const initialStartedAt = payload.started_at ?? (initialStatus === "running" ? timestamp : null);
    const initialHeartbeatAt = payload.heartbeat_at ?? (initialStatus === "running" ? timestamp : null);
    const job = {
      job_id: payload.job_id ?? `planner_${Date.now().toString(36)}_${randomToken(6)}`,
      workspace_id: payload.workspace_id ?? storeWorkspace.workspace_id,
      request_hash: requestHash,
      request_summary: requestSummary,
      status: initialStatus,
      planner_backend: normalizeText(payload.planner_backend, "schema_constrained_cli"),
      planner_driver: normalizeText(payload.planner_driver, SONOL_PLANNER_DRIVER),
      binding_id: normalizeText(payload.binding_id, "") || null,
      binding: payload.binding ?? null,
      started_at: initialStartedAt,
      heartbeat_at: initialHeartbeatAt,
      ended_at: payload.ended_at ?? null,
      error_code: payload.error_code ?? null,
      error_message: payload.error_message ?? null,
      stdout_tail: payload.stdout_tail ?? null,
      stderr_tail: payload.stderr_tail ?? null,
      result_plan_id: payload.result_plan_id ?? null,
      created_at: payload.created_at ?? timestamp,
      updated_at: payload.updated_at ?? timestamp
    };

    return withImmediateTransaction(() => {
      db.prepare(`
        INSERT INTO planner_jobs (
          job_id, workspace_id, request_hash, request_summary, status, planner_backend, planner_driver, binding_id, binding_json,
          started_at, heartbeat_at, ended_at, error_code, error_message, stdout_tail, stderr_tail,
          result_plan_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.job_id,
        job.workspace_id,
        job.request_hash,
        job.request_summary,
        job.status,
        job.planner_backend,
        job.planner_driver,
        job.binding_id,
        job.binding ? JSON.stringify(job.binding) : null,
        job.started_at,
        job.heartbeat_at,
        job.ended_at,
        job.error_code,
        job.error_message,
        job.stdout_tail,
        job.stderr_tail,
        job.result_plan_id,
        job.created_at,
        job.updated_at
      );
      return getPlannerJob(job.job_id);
    });
  }

  function updatePlannerJob(jobId, patch = {}) {
    const current = getPlannerJob(jobId);
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      binding: Object.prototype.hasOwnProperty.call(patch, "binding") ? patch.binding : current.binding,
      updated_at: nowIso()
    };

    return withImmediateTransaction(() => {
      db.prepare(`
        UPDATE planner_jobs
        SET status = ?, planner_backend = ?, planner_driver = ?, binding_id = ?, binding_json = ?, started_at = ?, heartbeat_at = ?,
            ended_at = ?, error_code = ?, error_message = ?, stdout_tail = ?, stderr_tail = ?, result_plan_id = ?, updated_at = ?
        WHERE job_id = ?
      `).run(
        next.status,
        next.planner_backend,
        next.planner_driver,
        next.binding_id,
        next.binding ? JSON.stringify(next.binding) : null,
        next.started_at,
        next.heartbeat_at,
        next.ended_at,
        next.error_code,
        next.error_message,
        next.stdout_tail,
        next.stderr_tail,
        next.result_plan_id,
        next.updated_at,
        jobId
      );
      return getPlannerJob(jobId);
    });
  }

  function completePlannerJob(jobId, patch = {}) {
    return updatePlannerJob(jobId, {
      status: patch.status ?? "succeeded",
      heartbeat_at: nowIso(),
      ended_at: patch.ended_at ?? nowIso(),
      error_code: null,
      error_message: null,
      stdout_tail: patch.stdout_tail ?? null,
      stderr_tail: patch.stderr_tail ?? null,
      result_plan_id: patch.result_plan_id ?? null
    });
  }

  function failPlannerJob(jobId, patch = {}) {
    return updatePlannerJob(jobId, {
      status: patch.status ?? "failed",
      heartbeat_at: nowIso(),
      ended_at: patch.ended_at ?? nowIso(),
      error_code: patch.error_code ?? "PLANNER_FAILED",
      error_message: patch.error_message ?? "planner failed",
      stdout_tail: patch.stdout_tail ?? null,
      stderr_tail: patch.stderr_tail ?? null
    });
  }

  function claimPlannerJob(jobId) {
    return withImmediateTransaction(() => {
      reclaimStalePlanningActivity();
      const timestamp = nowIso();
      const result = db.prepare(`
        UPDATE planner_jobs
        SET status = 'running',
            started_at = COALESCE(started_at, ?),
            heartbeat_at = ?,
            ended_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'queued'
      `).run(timestamp, timestamp, timestamp, jobId);
      if ((result?.changes ?? 0) < 1) {
        return null;
      }
      return getPlannerJob(jobId);
    });
  }

  function touchPlannerJob(jobId, patch = {}) {
    const current = getPlannerJob(jobId);
    if (!current || current.status !== "running") {
      return current;
    }
    return updatePlannerJob(jobId, {
      heartbeat_at: nowIso(),
      stdout_tail: patch.stdout_tail ?? current.stdout_tail ?? null,
      stderr_tail: patch.stderr_tail ?? current.stderr_tail ?? null
    });
  }

  function appendPlanRevision(plan) {
    db.prepare(`
      INSERT INTO plan_revisions (plan_id, context_version, approval_status, data_json, saved_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, context_version) DO NOTHING
    `).run(
      plan.plan_id,
      plan.context_version,
      plan.approval_status,
      JSON.stringify(plan),
      plan.updated_at
    );
  }

  function appendRunRevision(run) {
    db.prepare(`
      INSERT INTO run_revisions (run_id, plan_id, status, data_json, saved_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, saved_at) DO NOTHING
    `).run(
      run.run_id,
      run.plan_id,
      run.status,
      JSON.stringify(run),
      run.updated_at
    );
  }

  function backfillRevisionHistory() {
    const planRows = db.prepare("SELECT data_json FROM plans").all();
    for (const row of planRows) {
      try {
        const plan = hydratePlanRecord(JSON.parse(row.data_json), storeWorkspace);
        appendPlanRevision(plan);
      } catch {
      }
    }

    const runRows = db.prepare("SELECT data_json FROM runs").all();
    for (const row of runRows) {
      try {
        const run = hydrateRunRecord(JSON.parse(row.data_json), storeWorkspace);
        appendRunRevision(run);
      } catch {
      }
    }
  }

  function deleteRunCascade(runId, reason = "retention_policy") {
    if (!runId) {
      return;
    }

    const eventIds = db.prepare("SELECT event_id FROM events WHERE run_id = ?").all(runId).map((row) => row.event_id);
    db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
    if (eventIds.length > 0) {
      const placeholders = eventIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM audit_log WHERE ref_id IN (${placeholders})`).run(...eventIds);
    }
    db.prepare("DELETE FROM audit_log WHERE ref_id = ?").run(runId);
    db.prepare("DELETE FROM run_revisions WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);

    appendStructuredLog("sonol-runtime", {
      action: "run_deleted",
      run_id: runId,
      reason
    });
  }

  function deletePlanCascade(planId, reason = "retention_policy") {
    if (!planId) {
      return;
    }

    const runRows = db.prepare("SELECT run_id FROM runs WHERE plan_id = ?").all(planId);
    for (const row of runRows) {
      deleteRunCascade(row.run_id, reason);
    }

    const planEventIds = db.prepare(`
      SELECT event_id
      FROM events
      WHERE json_extract(payload_json, '$.plan_id') = ?
    `).all(planId).map((row) => row.event_id);
    db.prepare(`
      DELETE FROM events
      WHERE json_extract(payload_json, '$.plan_id') = ?
    `).run(planId);
    if (planEventIds.length > 0) {
      const placeholders = planEventIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM audit_log WHERE ref_id IN (${placeholders})`).run(...planEventIds);
    }
    db.prepare("DELETE FROM audit_log WHERE ref_id = ?").run(planId);
    db.prepare("DELETE FROM plan_revisions WHERE plan_id = ?").run(planId);
    db.prepare("DELETE FROM plans WHERE plan_id = ?").run(planId);
    db.prepare("UPDATE workspace_state SET active_plan_id = NULL WHERE active_plan_id = ?").run(planId);
    db.prepare("UPDATE workspace_state SET pending_previous_plan_id = NULL WHERE pending_previous_plan_id = ?").run(planId);

    appendStructuredLog("sonol-runtime", {
      action: "plan_deleted",
      plan_id: planId,
      deleted_run_count: runRows.length,
      reason
    });
  }

  function cleanupLegacyWorkspaceRows() {
    const legacyPlanIds = [];
    const existingPlanIds = new Set();
    const planRows = db.prepare("SELECT plan_id, data_json FROM plans").all();
    for (const row of planRows) {
      try {
        const plan = JSON.parse(row.data_json);
        if (!isNonEmptyString(plan?.workspace_id)) {
          legacyPlanIds.push(row.plan_id);
          continue;
        }
        existingPlanIds.add(row.plan_id);
      } catch {
        legacyPlanIds.push(row.plan_id);
      }
    }

    for (const planId of legacyPlanIds) {
      deletePlanCascade(planId, "legacy_workspace_cleanup");
    }

    const legacyRunIds = [];
    const runRows = db.prepare("SELECT run_id, plan_id, data_json FROM runs").all();
    for (const row of runRows) {
      try {
        const run = JSON.parse(row.data_json);
        if (!isNonEmptyString(run?.workspace_id) || !existingPlanIds.has(row.plan_id)) {
          legacyRunIds.push(row.run_id);
        }
      } catch {
        legacyRunIds.push(row.run_id);
      }
    }

    for (const runId of legacyRunIds) {
      deleteRunCascade(runId, "legacy_workspace_cleanup");
    }

    const orphanEventRunIds = db.prepare(`
      SELECT DISTINCT run_id
      FROM events
      WHERE run_id IS NOT NULL
        AND run_id NOT IN (SELECT run_id FROM runs)
    `).all().map((row) => row.run_id).filter(Boolean);

    for (const runId of orphanEventRunIds) {
      const eventIds = db.prepare("SELECT event_id FROM events WHERE run_id = ?").all(runId).map((row) => row.event_id);
      db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
      if (eventIds.length > 0) {
        const placeholders = eventIds.map(() => "?").join(", ");
        db.prepare(`DELETE FROM audit_log WHERE ref_id IN (${placeholders})`).run(...eventIds);
      }
      appendStructuredLog("sonol-runtime", {
        action: "orphan_events_deleted",
        run_id: runId,
        reason: "legacy_workspace_cleanup"
      });
    }

    const orphanPlanEventIds = db.prepare(`
      SELECT event_id
      FROM events
      WHERE run_id IS NULL
        AND json_extract(payload_json, '$.plan_id') IS NOT NULL
        AND json_extract(payload_json, '$.plan_id') NOT IN (SELECT plan_id FROM plans)
    `).all().map((row) => row.event_id);
    if (orphanPlanEventIds.length > 0) {
      const placeholders = orphanPlanEventIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM events WHERE event_id IN (${placeholders})`).run(...orphanPlanEventIds);
      db.prepare(`DELETE FROM audit_log WHERE ref_id IN (${placeholders})`).run(...orphanPlanEventIds);
    }

    db.prepare(`
      DELETE FROM audit_log
      WHERE kind = 'event_saved'
        AND ref_id IS NOT NULL
        AND ref_id NOT IN (SELECT event_id FROM events)
    `).run();

    db.prepare(`
      DELETE FROM plan_revisions
      WHERE plan_id NOT IN (SELECT plan_id FROM plans)
    `).run();

    db.prepare(`
      DELETE FROM run_revisions
      WHERE run_id NOT IN (SELECT run_id FROM runs)
    `).run();

    return {
      deleted_plan_count: legacyPlanIds.length,
      deleted_run_count: legacyRunIds.length,
      deleted_orphan_event_groups: orphanEventRunIds.length,
      deleted_orphan_plan_events: orphanPlanEventIds.length
    };
  }

  function prunePlanHistory(maxPlans = MAX_PLAN_HISTORY, protectedPlanIds = [], workspaceId = null) {
    const protectedSet = new Set(protectedPlanIds);
    const activeRunPlanIds = new Set(
      db.prepare(`
        SELECT DISTINCT plan_id
        FROM runs
        WHERE status IN ('queued', 'prepared', 'running', 'blocked')
      `).all().map((row) => row.plan_id)
    );

    const planRows = db.prepare(`
      SELECT plan_id, data_json, updated_at
      FROM plans
      ORDER BY updated_at DESC
    `).all();

    const keptPlanIds = new Set();
    const stalePlanIds = [];

    for (const row of planRows) {
      let plan = null;
      try {
        plan = JSON.parse(row.data_json);
      } catch {
        stalePlanIds.push(row.plan_id);
        continue;
      }

      if (workspaceId && plan.workspace_id !== workspaceId) {
        continue;
      }
      const isProtected =
        protectedSet.has(row.plan_id) ||
        activeRunPlanIds.has(row.plan_id);

      if (isProtected || keptPlanIds.size < maxPlans) {
        keptPlanIds.add(row.plan_id);
        continue;
      }

      stalePlanIds.push(row.plan_id);
    }

    for (const planId of stalePlanIds) {
      deletePlanCascade(planId, "plan_history_prune");
    }
  }

  function enforceRetentionPolicy({ workspaceId = storeWorkspace.workspace_id, keepPlanIds = [] } = {}) {
    const cleanupResult = cleanupLegacyWorkspaceRows();
    prunePlanHistory(MAX_PLAN_HISTORY, keepPlanIds, workspaceId);
    appendStructuredLog("sonol-runtime", {
      action: "retention_policy_enforced",
      workspace_id: workspaceId,
      keep_plan_ids: keepPlanIds,
      ...cleanupResult
    });
  }

  function listPlans() {
    return db.prepare("SELECT data_json FROM plans ORDER BY updated_at DESC").all()
      .map((row) => hydratePlanRecord(JSON.parse(row.data_json), storeWorkspace))
      .filter((plan) => workspaceMatches(plan, storeWorkspace.workspace_id));
  }

  function getPlan(planId) {
    const row = db.prepare("SELECT data_json FROM plans WHERE plan_id = ?").get(planId);
    if (!row) {
      return null;
    }
    const plan = hydratePlanRecord(JSON.parse(row.data_json), storeWorkspace);
    return workspaceMatches(plan, storeWorkspace.workspace_id) ? plan : null;
  }

  function savePlan(plan, saveOptions = {}) {
    try {
      return withImmediateTransaction(() => {
        const currentTime = nowIso();
        const data = {
          ...hydratePlanRecord(plan, storeWorkspace),
          updated_at: currentTime,
          created_at: plan.created_at ?? currentTime
        };
        if (!workspaceMatches(data, storeWorkspace.workspace_id)) {
          throw new Error(`plan workspace mismatch: ${data.plan_id}`);
        }

        const current = getPlan(data.plan_id);
        if (saveOptions.expectedContextVersion !== undefined && saveOptions.expectedContextVersion !== null) {
          const currentVersion = current?.context_version ?? null;
          if (currentVersion !== saveOptions.expectedContextVersion) {
            throw new Error(`plan context conflict: expected ${saveOptions.expectedContextVersion}, found ${currentVersion ?? "missing"}`);
          }
        }

        validateBySchemaId("https://sonol.local/schemas/plan.schema.json", data, "plan");

        db.prepare(`
          INSERT INTO plans (
            plan_id, request_summary, single_or_multi, approval_status, context_version,
            data_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(plan_id) DO UPDATE SET
            request_summary = excluded.request_summary,
            single_or_multi = excluded.single_or_multi,
            approval_status = excluded.approval_status,
            context_version = excluded.context_version,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
        `).run(
          data.plan_id,
          data.request_summary,
          data.single_or_multi,
          data.approval_status,
          data.context_version,
          JSON.stringify(data),
          data.created_at,
          data.updated_at
        );
        appendPlanRevision(data);

        appendAudit("plan_saved", data.plan_id, `Saved plan ${data.plan_id}`);
        appendStructuredLog("sonol-runtime", {
          action: "plan_saved",
          plan_id: data.plan_id,
          approval_status: data.approval_status,
          context_version: data.context_version
        });
        enforceRetentionPolicy({
          workspaceId: data.workspace_id ?? storeWorkspace.workspace_id,
          keepPlanIds: [data.plan_id]
        });
        return data;
      });
    } catch (error) {
      appendStructuredLog("sonol-runtime", {
        action: "plan_save_failed",
        plan_id: plan?.plan_id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  function listRuns(planId = null) {
    const rows = planId
      ? db.prepare("SELECT data_json FROM runs WHERE plan_id = ? ORDER BY created_at DESC").all(planId)
      : db.prepare("SELECT data_json FROM runs ORDER BY created_at DESC").all();

    return rows
      .map((row) => hydrateRunRecord(JSON.parse(row.data_json), storeWorkspace))
      .map((run) => normalizeRunForRead(run))
      .filter((run) => workspaceMatches(run, storeWorkspace.workspace_id));
  }

  function getRun(runId) {
    const row = db.prepare("SELECT data_json FROM runs WHERE run_id = ?").get(runId);
    if (!row) {
      return null;
    }
    const run = normalizeRunForRead(hydrateRunRecord(JSON.parse(row.data_json), storeWorkspace));
    return workspaceMatches(run, storeWorkspace.workspace_id) ? run : null;
  }

  function getActiveRunForPlan(planId) {
    const runs = listRuns(planId);
    for (const run of runs) {
      const plan = getPlanForRun(run);
      if (!plan) {
        continue;
      }
      const events = listEvents(run.run_id);
      const derivedStatus = deriveRuntimeStatusForRead(plan, run, events);
      if (["queued", "prepared", "running", "blocked"].includes(derivedStatus)) {
        return {
          ...run,
          status: derivedStatus
        };
      }
    }
    return null;
  }

  function getPlanForRun(runOrId) {
    const run = typeof runOrId === "string" ? getRun(runOrId) : hydrateRunRecord(runOrId, storeWorkspace);
    if (!run) {
      return null;
    }

    if (run.plan_snapshot && typeof run.plan_snapshot === "object") {
      return hydratePlanRecord(run.plan_snapshot, {
        workspace_id: run.workspace_id ?? storeWorkspace.workspace_id,
        workspace_root: run.workspace_root ?? storeWorkspace.workspace_root
      });
    }

    return getPlan(run.plan_id);
  }

  function saveRun(run, saveOptions = {}) {
    try {
      return withImmediateTransaction(() => {
        const currentTime = nowIso();
        const data = {
          ...hydrateRunRecord(run, storeWorkspace),
          updated_at: currentTime,
          created_at: run.created_at ?? currentTime
        };
        if (!workspaceMatches(data, storeWorkspace.workspace_id)) {
          throw new Error(`run workspace mismatch: ${data.run_id}`);
        }

        const current = getRun(data.run_id);
        if (saveOptions.expectedUpdatedAt !== undefined && saveOptions.expectedUpdatedAt !== null) {
          const currentUpdatedAt = current?.updated_at ?? null;
          if (currentUpdatedAt !== saveOptions.expectedUpdatedAt) {
            throw new Error(`run state conflict: expected ${saveOptions.expectedUpdatedAt}, found ${currentUpdatedAt ?? "missing"}`);
          }
        }

        if (current && !canTransitionRunStatus(current.status, data.status)) {
          throw new Error(`invalid run status transition: ${current.status} -> ${data.status}`);
        }

        if (isActiveRunStatus(data.status)) {
          const conflicting = listRuns(data.plan_id).find((candidate) => candidate.run_id !== data.run_id && isActiveRunStatus(candidate.status));
          if (conflicting) {
            throw new Error(`active run already exists for plan ${data.plan_id}: ${conflicting.run_id}`);
          }
        }

        validateBySchemaId("https://sonol.local/schemas/run.schema.json", data, "run");

        db.prepare(`
          INSERT INTO runs (
            run_id, plan_id, plan_snapshot_version, mode, adapter_type, status,
            started_at, ended_at, retry_of, data_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            plan_id = excluded.plan_id,
            plan_snapshot_version = excluded.plan_snapshot_version,
            mode = excluded.mode,
            adapter_type = excluded.adapter_type,
            status = excluded.status,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            retry_of = excluded.retry_of,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
        `).run(
          data.run_id,
          data.plan_id,
          data.plan_snapshot_version,
          data.mode,
          data.adapter_type,
          data.status,
          data.started_at,
          data.ended_at,
          data.retry_of,
          JSON.stringify(data),
          data.created_at,
          data.updated_at
        );
        appendRunRevision(data);

        appendAudit("run_saved", data.run_id, `Saved run ${data.run_id}`);
        appendStructuredLog("sonol-runtime", {
          action: "run_saved",
          run_id: data.run_id,
          plan_id: data.plan_id,
          status: data.status,
          mode: data.mode
        });
        if (["completed", "failed", "cancelled", "stale"].includes(data.status)) {
          enforceRetentionPolicy({
            workspaceId: data.workspace_id ?? storeWorkspace.workspace_id,
            keepPlanIds: [data.plan_id]
          });
        }
        return data;
      });
    } catch (error) {
      appendStructuredLog("sonol-runtime", {
        action: "run_save_failed",
        run_id: run?.run_id ?? null,
        plan_id: run?.plan_id ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  function updateRunStatus(runId, status, extra = {}) {
    try {
      const run = getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      const isTerminalStatus = ["completed", "failed", "cancelled", "stale"].includes(status);

      const updated = {
        ...run,
        status,
        ...extra,
        active_agent_ids: isTerminalStatus
          ? []
          : Array.isArray(extra.active_agent_ids)
            ? extra.active_agent_ids.filter(isNonEmptyString)
            : run.active_agent_ids,
        ended_at:
          isTerminalStatus
            ? extra.ended_at ?? nowIso()
            : run.ended_at ?? null
      };

      const savedWithConflictCheck = saveRun(updated, {
        expectedUpdatedAt: run.updated_at ?? null
      });
      appendStructuredLog("sonol-runtime", {
        action: "run_status_updated",
        run_id: savedWithConflictCheck.run_id,
        status: savedWithConflictCheck.status,
        cancel_reason: savedWithConflictCheck.cancel_reason ?? null
      });
      return savedWithConflictCheck;
    } catch (error) {
      appendStructuredLog("sonol-runtime", {
        action: "run_status_update_failed",
        run_id: runId,
        target_status: status,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  function validateEvent(eventType, payload) {
    const schemaFile = EVENT_SCHEMA_MAP[eventType];
    if (!schemaFile) {
      throw new Error(`Unsupported event type: ${eventType}`);
    }

    const schema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, schemaFile), "utf8"));
    const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);

    if (!validate(payload)) {
      const detail = (validate.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(`Schema validation failed for ${eventType}: ${detail}`);
    }
  }

  function getCurrentAgentState(runId, agentId, fallbackUpdatedAt = null, role = null) {
    if (!runId || !agentId) {
      return null;
    }
    const rows = db.prepare(`
      SELECT event_type, payload_json
      FROM events
      WHERE run_id = ? AND agent_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(runId, agentId);
    let current = buildBaseAgentState(agentId, fallbackUpdatedAt ?? nowIso(), role);
    for (const row of rows) {
      try {
        current = summarizeAgentEvent(current, row.event_type, JSON.parse(row.payload_json));
      } catch {
      }
    }
    return current;
  }

  function appendEvent(eventType, payload, options = {}) {
    try {
      return withImmediateTransaction(() => {
        validateEvent(eventType, payload);

        let normalizedTimestamp = nowIso();
        const parsedTimestamp = Date.parse(payload.timestamp ?? "");
        if (Number.isFinite(parsedTimestamp)) {
          normalizedTimestamp = new Date(parsedTimestamp).toISOString();
        }
        const normalizedPayload = {
          ...payload,
          timestamp: normalizedTimestamp
        };

        let targetRun = null;
        let targetPlan = null;
        if (normalizedPayload.run_id) {
          targetRun = getRun(normalizedPayload.run_id);
          if (!targetRun) {
            throw new Error(`Run not found for event: ${normalizedPayload.run_id}`);
          }
          if (isTerminalRunStatus(targetRun.status)) {
            throw new Error(`Run ${normalizedPayload.run_id} is already ${targetRun.status}; refusing late event.`);
          }
          targetPlan = getPlanForRun(targetRun);
          if (!targetPlan) {
            throw new Error(`Plan not found for run: ${targetRun.plan_id}`);
          }
          if (!normalizedPayload.plan_id) {
            throw new Error(`plan_id is required for run-scoped event ${eventType}`);
          }
          if (normalizedPayload.plan_id !== targetPlan.plan_id) {
            throw new Error(`plan_id mismatch for run ${normalizedPayload.run_id}: expected ${targetPlan.plan_id}, received ${normalizedPayload.plan_id}`);
          }
          if (options.source_script === "report-main") {
            validateReportMainReporterIdentity(targetRun, options);
          }
          if (normalizedPayload.agent_id) {
            if (
              normalizedPayload.agent_id === "agent_main"
              && options.source_script !== "report-main"
              && options.internal_control !== true
            ) {
              throw new Error(
                "agent_main runtime events must be written through report-main.mjs. Generic subagent reporters cannot publish agent_main events."
              );
            }
            const plannedAgent = targetPlan.agents.find((agent) => agent.agent_id === normalizedPayload.agent_id);
            if (!plannedAgent) {
              throw new Error(`Agent ${normalizedPayload.agent_id} is not part of plan ${targetPlan.plan_id}`);
            }
            const currentAgentState = getCurrentAgentState(
              normalizedPayload.run_id,
              normalizedPayload.agent_id,
              targetRun.updated_at,
              plannedAgent.role
            );
            if (currentAgentState && isTerminalAgentState(currentAgentState.state)) {
              throw new Error(`Agent ${normalizedPayload.agent_id} is already ${currentAgentState.state}; refusing late ${eventType}.`);
            }
            const enforcedTaskId = omitBlankOptionalString(plannedAgent.current_task_id);
            const assignedTaskIds = new Set(
              (Array.isArray(plannedAgent.assigned_task_ids) ? plannedAgent.assigned_task_ids : []).filter(isNonEmptyString)
            );
            const eventTaskRequired = ["progress_event", "artifact_event", "completion_event"].includes(eventType);
            if (eventTaskRequired && enforcedTaskId && !normalizedPayload.task_id) {
              throw new Error(`task_id is required for ${eventType} from agent ${normalizedPayload.agent_id}`);
            }
            if (normalizedPayload.task_id) {
              const planTaskIds = new Set((targetPlan.tasks ?? []).map((task) => task.task_id));
              if (!planTaskIds.has(normalizedPayload.task_id)) {
                throw new Error(`Task ${normalizedPayload.task_id} is not part of plan ${targetPlan.plan_id}`);
              }
              if (assignedTaskIds.size > 0 && !assignedTaskIds.has(normalizedPayload.task_id)) {
                throw new Error(`Task ${normalizedPayload.task_id} is not assigned to agent ${normalizedPayload.agent_id}`);
              }
              if (enforcedTaskId && normalizedPayload.task_id !== enforcedTaskId) {
                throw new Error(`Task ${normalizedPayload.task_id} does not match current_task_id ${enforcedTaskId} for agent ${normalizedPayload.agent_id}`);
              }
            }
          }
        }

        const existing = db.prepare("SELECT payload_json FROM events WHERE event_id = ?").get(normalizedPayload.event_id);
        if (existing) {
          try {
            const existingPayload = JSON.parse(existing.payload_json);
            if (JSON.stringify(existingPayload) === JSON.stringify(normalizedPayload)) {
              return normalizedPayload;
            }
          } catch {
          }
          throw new Error(`Duplicate event_id: ${normalizedPayload.event_id}`);
        }

        db.prepare(`
          INSERT INTO events (
            event_id, run_id, agent_id, event_type, state, message, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedPayload.event_id,
          normalizedPayload.run_id ?? null,
          normalizedPayload.agent_id ?? null,
          eventType,
          normalizedPayload.state ?? normalizedPayload.status ?? null,
          normalizedPayload.message ?? normalizedPayload.summary ?? null,
          JSON.stringify(normalizedPayload),
          normalizedTimestamp
        );

        appendAudit("event_saved", normalizedPayload.event_id, `Saved ${eventType}`);
        appendStructuredLog("sonol-runtime", {
          action: "event_saved",
          run_id: normalizedPayload.run_id ?? null,
          agent_id: normalizedPayload.agent_id ?? null,
          event_id: normalizedPayload.event_id ?? null,
          event_type: eventType,
          state: normalizedPayload.state ?? normalizedPayload.status ?? null,
          message: normalizedPayload.message ?? normalizedPayload.summary ?? null
        });
        if (normalizedPayload.run_id && transactionDepth === 1) {
          syncRunStatusFromEvents(normalizedPayload.run_id);
        }
        return normalizedPayload;
      });
    } catch (error) {
      appendStructuredLog("sonol-runtime", {
        action: "event_save_failed",
        run_id: payload?.run_id ?? null,
        agent_id: payload?.agent_id ?? null,
        event_id: payload?.event_id ?? null,
        event_type: eventType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  function listEvents(runId = null, options = {}) {
    const limit = Number.isFinite(Number(options?.limit)) ? Math.max(1, Number(options.limit)) : null;
    const descending = options?.order === "desc";
    const sortDirection = descending ? "DESC" : "ASC";
    const limitClause = limit ? ` LIMIT ${limit}` : "";
    const rows = runId
      ? db.prepare(`SELECT event_type, payload_json FROM events WHERE run_id = ? ORDER BY created_at ${sortDirection}, rowid ${sortDirection}${limitClause}`).all(runId)
      : db.prepare(`SELECT event_type, payload_json FROM events ORDER BY created_at ${sortDirection}, rowid ${sortDirection}${limitClause}`).all();

    const events = rows.map((row) => normalizeEventRecord(db, row.event_type, JSON.parse(row.payload_json)));

    return descending ? events : events;
  }

  function listPlanEvents(planId, options = {}) {
    if (!planId) {
      return [];
    }

    const limit = Number.isFinite(Number(options?.limit)) ? Math.max(1, Number(options.limit)) : 200;
    const descending = options?.order === "desc";
    const sortDirection = descending ? "DESC" : "ASC";
    const rows = db.prepare(`
      SELECT event_type, payload_json
      FROM events
      WHERE json_extract(payload_json, '$.plan_id') = ?
      ORDER BY created_at ${sortDirection}, rowid ${sortDirection}
      LIMIT ${limit}
    `).all(planId);

    return rows.map((row) => normalizeEventRecord(db, row.event_type, JSON.parse(row.payload_json)));
  }

  function listScopedEventsForPlan(planId, options = {}) {
    if (!planId) {
      return [];
    }

    const limit = Number.isFinite(Number(options?.limit)) ? Math.max(1, Number(options.limit)) : 400;
    const descending = options?.order === "desc";
    const rows = db.prepare(`
      SELECT event_type, payload_json
      FROM events
      WHERE run_id IN (SELECT run_id FROM runs WHERE plan_id = ?)
         OR json_extract(payload_json, '$.plan_id') = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit}
    `).all(planId, planId);
    const orderedRows = descending ? rows : [...rows].reverse();
    return orderedRows.map((row) => normalizeEventRecord(db, row.event_type, JSON.parse(row.payload_json)));
  }

  function getChangeFingerprint() {
    const planRow = db.prepare(`
      SELECT
        COUNT(*) AS count,
        MAX(updated_at) AS updated_at,
        MAX(context_version) AS max_context_version
      FROM plans
    `).get();
    const runRow = db.prepare(`
      SELECT
        COUNT(*) AS count,
        MAX(updated_at) AS updated_at
      FROM runs
    `).get();
    const eventRow = db.prepare(`
      SELECT
        COUNT(*) AS count,
        MAX(created_at) AS created_at,
        MAX(rowid) AS max_rowid
      FROM events
    `).get();
    const latestEvents = db.prepare(`
      SELECT event_id
      FROM events
      ORDER BY created_at DESC, rowid DESC
      LIMIT 12
    `).all().map((row) => row.event_id);
    const workspaceState = getWorkspaceState();

    return JSON.stringify({
      plans: {
        count: planRow?.count ?? 0,
        updated_at: planRow?.updated_at ?? null,
        max_context_version: planRow?.max_context_version ?? null
      },
      runs: {
        count: runRow?.count ?? 0,
        updated_at: runRow?.updated_at ?? null
      },
      events: {
        count: eventRow?.count ?? 0,
        created_at: eventRow?.created_at ?? null,
        max_rowid: eventRow?.max_rowid ?? null,
        latest_ids: latestEvents
      },
      workspace_state: {
        active_plan_id: workspaceState.active_plan_id ?? null,
        pending_request_summary: workspaceState.pending_request_summary ?? null,
        pending_request_started_at: workspaceState.pending_request_started_at ?? null,
        pending_request_error: workspaceState.pending_request_error ?? null,
        updated_at: workspaceState.updated_at ?? null
      }
    });
  }

  function listRunMonitors() {
    const plansById = new Map(listPlans().map((plan) => [plan.plan_id, plan]));
    return listRuns().map((run) => {
      const plan = getPlanForRun(run) ?? plansById.get(run.plan_id) ?? null;
      const events = listEvents(run.run_id);
      let latestMessage = "";

      for (const event of events) {
        const payload = event.payload ?? {};
        if (payload.message) {
          latestMessage = payload.message;
        } else if (payload.summary) {
          latestMessage = payload.summary;
        }

      }

      const baseStates = buildAgentStates(plan, run, events);
      const launchableAgents = collectLaunchCandidates(plan, run, baseStates);
      const states = applyTerminalRunProjection(plan, run, applyMissingReportPolicy(plan, run, baseStates));
      const autoBlocked = Array.from(states.values()).find((state) => state.last_event_type === "auto_missing_report");
      if (autoBlocked) {
        latestMessage = autoBlocked.message;
      }
      const runStatus = deriveRuntimeStatusForRead(plan, run, events);

      return {
        run_id: run.run_id,
        plan_id: run.plan_id,
        run_status: runStatus,
        latest_message: latestMessage,
        agent_states: Array.from(states.values()),
        launchable_agent_ids: launchableAgents.map(({ agent }) => agent.agent_id),
        updated_at: run.updated_at
      };
    });
  }

  function getRunLaunchCandidates(runId) {
    const run = getRun(runId);
    if (!run) {
      return null;
    }
    const plan = getPlanForRun(run);
    if (!plan) {
      return null;
    }
    const events = listEvents(runId);
    const states = buildAgentStates(plan, run, events);
    const candidates = collectLaunchCandidates(plan, run, states).map(({ agent }) => {
      const state = states.get(agent.agent_id) ?? buildBaseAgentState(agent.agent_id, run.updated_at, agent.role);
      return {
        agent_id: agent.agent_id,
        role: agent.role,
        role_label: agent.role_label ?? agent.role,
        current_task_id: agent.current_task_id ?? agent.assigned_task_ids?.[0] ?? null,
        assigned_task_ids: Array.isArray(agent.assigned_task_ids) ? [...agent.assigned_task_ids] : [],
        depends_on: Array.isArray(agent.depends_on) ? [...agent.depends_on] : [],
        state: state.state,
        last_event_type: state.last_event_type,
        updated_at: state.updated_at
      };
    });
    return {
      run,
      plan,
      candidates
    };
  }

  function syncRunStatusFromEvents(runId) {
    const run = getRun(runId);
    if (!run) {
      return null;
    }

    const plan = getPlanForRun(run);
    const events = listEvents(runId);
    const timestamps = events
      .map((event) => event.payload?.timestamp)
      .filter((value) => typeof value === "string" && value.length > 0);
    const firstTimestamp = timestamps[0] ?? nowIso();

    if (!plan || !events.length) {
      return run;
    }

    if (["completed", "failed", "cancelled", "stale"].includes(run.status)) {
      return run;
    }

    let states = buildAgentStates(plan, run, events);
    states = applyLaunchPolicy(appendEvent, plan, run, states);
    const agentStates = Array.from(applyMissingReportPolicy(plan, run, states).values());
    let nextStatus = deriveEffectiveRunStatus(run, agentStates, events);
    if (nextStatus === "blocked") {
      const latestAgentUpdate = agentStates
        .map((state) => toMillis(state.updated_at))
        .filter((value) => value !== null)
        .sort((left, right) => right - left)[0];
      const blockBaseline = latestAgentUpdate ?? toMillis(run.updated_at) ?? Date.now();
      if (Date.now() - blockBaseline >= BLOCKED_RUN_STALE_MS) {
        nextStatus = "stale";
      }
    }

    const startedAt = run.started_at ?? firstTimestamp;
    const endedAt = ["completed", "failed", "cancelled", "stale"].includes(nextStatus) ? nowIso() : null;
    const activeAgentIds = ["completed", "failed", "cancelled", "stale"].includes(nextStatus)
      ? []
      : Array.from(new Set(
          agentStates
            .filter((state) => !isTerminalAgentState(state.state))
            .map((state) => state.agent_id)
            .filter(isNonEmptyString)
        ));
    return saveRun({
      ...run,
      status: nextStatus,
      active_agent_ids: activeAgentIds,
      started_at: nextStatus === "queued" || nextStatus === "prepared" ? run.started_at : startedAt,
      ended_at: endedAt ?? run.ended_at ?? null
    }, {
      expectedUpdatedAt: run.updated_at ?? null
    });
  }

  function getSnapshot() {
    const plans = listPlans();
    const runs = listRuns();
    const recentEvents = listEvents(null, { limit: 500, order: "desc" }).reverse();
    const planEventsById = Object.fromEntries(
      plans.map((plan) => [plan.plan_id, listScopedEventsForPlan(plan.plan_id, { limit: 400, order: "asc" })])
    );

    return {
      db_path: openedDbPath,
      workspace_state: getWorkspaceState(),
      workspace_registry: getWorkspaceRegistryEntry(),
      plans,
      runs,
      planner_jobs: listPlannerJobs(),
      run_monitors: listRunMonitors(),
      recentEvents,
      planEventsById,
      generated_at: nowIso()
    };
  }

  function hasLiveActivity() {
    return listRuns().some((run) => {
      const plan = getPlanForRun(run);
      if (!plan) {
        return false;
      }
      const derivedStatus = deriveRuntimeStatusForRead(plan, run, listEvents(run.run_id));
      return isActiveRunStatus(derivedStatus);
    });
  }

  if (!options.readOnly) {
    if (tableExists("planner_jobs") && !columnExists("planner_jobs", "planner_driver")) {
      withImmediateTransaction(() => {
        db.exec(`
          ALTER TABLE planner_jobs ADD COLUMN planner_driver TEXT NOT NULL DEFAULT 'remote_http';
        `);
      });
    }

    const workspaceStateTable = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'workspace_state'
    `).get();
    if (workspaceStateTable?.sql?.includes("workspace_root TEXT NOT NULL")) {
      withImmediateTransaction(() => {
        db.exec(`
          ALTER TABLE workspace_state RENAME TO workspace_state_old;
          CREATE TABLE workspace_state (
            workspace_id TEXT PRIMARY KEY,
            workspace_root TEXT,
            active_plan_id TEXT,
            pending_request_summary TEXT,
            pending_request_started_at TEXT,
            pending_request_error TEXT,
            pending_previous_plan_id TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO workspace_state (
            workspace_id, workspace_root, active_plan_id, pending_request_summary,
            pending_request_started_at, pending_request_error, pending_previous_plan_id, updated_at
          )
          SELECT
            workspace_id, workspace_root, active_plan_id, pending_request_summary,
            pending_request_started_at, pending_request_error, pending_previous_plan_id, updated_at
          FROM workspace_state_old;
          DROP TABLE workspace_state_old;
          CREATE INDEX IF NOT EXISTS idx_workspace_state_active_plan ON workspace_state(active_plan_id);
        `);
      });
    }

    if (!isNonEmptyString(storeWorkspace.workspace_root)) {
      const persistedWorkspaceRoot =
        db.prepare(`
          SELECT workspace_root
          FROM workspace_state
          WHERE workspace_id = ?
        `).get(storeWorkspace.workspace_id)?.workspace_root
        ?? db.prepare(`
          SELECT json_extract(data_json, '$.workspace_root') AS workspace_root
          FROM plans
          WHERE json_extract(data_json, '$.workspace_id') = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(storeWorkspace.workspace_id)?.workspace_root
        ?? db.prepare(`
          SELECT json_extract(data_json, '$.workspace_root') AS workspace_root
          FROM runs
          WHERE json_extract(data_json, '$.workspace_id') = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(storeWorkspace.workspace_id)?.workspace_root
        ?? preferWorkspaceRoot(options.workspaceRoot, options.startDir);
      storeWorkspace = {
        ...storeWorkspace,
        workspace_root: preferWorkspaceRoot(persistedWorkspaceRoot, storeWorkspace.workspace_root)
      };
    }

    upsertWorkspaceRegistry({
      workspace_id: storeWorkspace.workspace_id,
      workspace_root: storeWorkspace.workspace_root,
      preferred_db_path: openedDbPath,
      preferred_runtime_root: options.runtimeRoot ?? resolveDefaultRuntimeRoot({
        workspaceRoot: storeWorkspace.workspace_root,
        startDir: preferWorkspaceRoot(storeWorkspace.workspace_root, options.startDir)
      })
    });

    enforceRetentionPolicy({
      workspaceId: storeWorkspace.workspace_id,
      keepPlanIds: []
    });
    reconcileWorkspaceRoots();
    backfillRevisionHistory();
    reclaimStalePlanningActivity();
    ensureWorkspaceStateSeeded();
  }

  return {
    db,
    dbPath: openedDbPath,
    close() {
      db.close();
    },
    getPlan,
    getWorkspaceState,
    getWorkspaceRegistryEntry,
    getRun,
    getActiveRunForPlan,
    getPlanForRun,
    listPlans,
    listRuns,
    listEvents,
    listPlanEvents,
    listScopedEventsForPlan,
    getChangeFingerprint,
    setActivePlan,
    beginPlanningRequest,
    claimPlanningRequest,
    completePlanningRequest,
    failPlanningRequest,
    reclaimStalePlanningActivity,
    upsertWorkspaceRegistry,
    getPlannerJob,
    listPlannerJobs,
    createPlannerJob,
    claimPlannerJob,
    touchPlannerJob,
    updatePlannerJob,
    completePlannerJob,
    failPlannerJob,
    savePlan,
    saveRun,
    updateRunStatus,
    appendEvent,
    getRunLaunchCandidates,
    getSnapshot,
    hasLiveActivity
  };
}

export function defaultDbPath(options = {}) {
  return resolveDefaultDbPath(options);
}
