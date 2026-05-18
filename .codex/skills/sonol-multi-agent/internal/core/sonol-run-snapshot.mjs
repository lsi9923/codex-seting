import { defaultAdapterConfig } from "./sonol-adapters.mjs";

function nowIso() {
  return new Date().toISOString();
}

function asciiSlug(input, limit = 18) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit) || "x";
}

function stableHash(input) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(input ?? ""), "utf8");
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

export function createRunSnapshot(plan, options = {}) {
  const now = options.nowIso ?? nowIso();
  const resolvedMode = options.mode && options.mode !== "auto" ? options.mode : "dry-run";
  const runSeed = `${plan.plan_id}-${plan.context_version}-${now}`;
  const runLabel = asciiSlug(plan.plan_title ?? plan.request_summary, 12);
  const runHash = stableHash(runSeed).slice(0, 8);
  const planSnapshot = JSON.parse(JSON.stringify(plan));
  const adapterDefaults = defaultAdapterConfig({ workspaceRoot: plan.workspace_root ?? null });

  return {
    run_id: `run_${runLabel}_${runHash}`,
    plan_id: plan.plan_id,
    workspace_id: plan.workspace_id ?? null,
    workspace_root: plan.workspace_root ?? null,
    plan_snapshot_version: plan.context_version,
    plan_snapshot: planSnapshot,
    source_plan_updated_at: plan.updated_at ?? now,
    source_approval_status: plan.approval_status,
    mode: resolvedMode,
    resolved_mode: resolvedMode,
    adapter_type: options.adapter_type ?? adapterDefaults.adapter_type,
    adapter_backend: options.adapter_backend ?? adapterDefaults.adapter_backend,
    provider_refs: {
      provider_run_id: null,
      conversation_id: null,
      thread_id: null,
      session_id: null,
      main_provider_session_kind: null,
      main_provider_session_id: null,
      main_provider_session_thread_id: null,
      main_provider_session_file: null,
      launch_truth_source: "none",
      status_truth_source: "none",
      launch_surface: null,
      dispatch_mode: null,
      status_transport: null,
      remote_status_supported: false,
      remote_cancel_supported: false
    },
    runtime_bindings: {
      binding_id: null,
      workspace_id: plan.workspace_id ?? null,
      db_path: null,
      runtime_root: null
    },
    status: "queued",
    started_at: null,
    ended_at: null,
    retry_of: options.retry_of ?? null,
    cancel_reason: null,
    active_agent_ids: plan.agents.map((agent) => agent.agent_id),
    created_at: now,
    updated_at: now
  };
}
