import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function workspaceAuthorityPath(workspaceRoot) {
  return resolve(workspaceRoot, ".sonol", "authority.json");
}

export function dashboardAuthorityPath(runtimeRoot) {
  return resolve(runtimeRoot, "dashboard", "authority.json");
}

export function readWorkspaceAuthorityRecord(options = {}) {
  if (!options.workspaceRoot) {
    return null;
  }
  const filePath = workspaceAuthorityPath(options.workspaceRoot);
  if (!existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

export function writeDashboardAuthorityArtifacts(options = {}) {
  const binding = options.binding ?? {};
  const workspaceRoot = binding.workspace_root ?? options.workspaceRoot ?? null;
  const runtimeRoot = binding.runtime_root ?? options.runtimeRoot ?? null;
  if (!workspaceRoot && !runtimeRoot) {
    return null;
  }

  const payload = {
    schema_version: "1.0.0",
    kind: "dashboard_authority",
    generated_at: nowIso(),
    workspace_id: binding.workspace_id ?? null,
    workspace_root: workspaceRoot,
    binding_id: binding.binding_id ?? null,
    authoritative_db_path: binding.db_path ?? null,
    runtime_root: runtimeRoot,
    dashboard_url: options.dashboardUrl ?? null,
    event_store_table: "events",
    compatibility_views: ["runtime_events"],
    source: options.source ?? "dashboard_start"
  };

  const written = {};
  if (workspaceRoot) {
    written.workspace_authority_file = workspaceAuthorityPath(workspaceRoot);
    writeJson(written.workspace_authority_file, payload);
  }
  if (runtimeRoot) {
    written.dashboard_authority_file = dashboardAuthorityPath(runtimeRoot);
    writeJson(written.dashboard_authority_file, payload);
  }
  return written;
}

export function writeRunAuthorityArtifacts(options = {}) {
  const run = options.run ?? {};
  const dispatch = options.dispatch ?? {};
  const runtimeContext = dispatch.runtime_context ?? {};
  const rootDir = runtimeContext.root_dir ?? null;
  if (!rootDir) {
    return null;
  }

  const written = {};
  const authorityPayload = {
    schema_version: "1.0.0",
    kind: "run_authority",
    generated_at: nowIso(),
    run_id: run.run_id ?? null,
    plan_id: run.plan_id ?? null,
    workspace_id: run.workspace_id ?? null,
    workspace_root: run.workspace_root ?? null,
    authoritative_db_path: runtimeContext.db_path ?? run.runtime_bindings?.db_path ?? null,
    runtime_root: rootDir,
    adapter_type: run.adapter_type ?? null,
    adapter_backend: run.adapter_backend ?? null,
    dispatch_mode: dispatch.dispatch_mode ?? null,
    auto_launch_supported: dispatch.auto_launch_supported ?? null,
    next_action: dispatch.next_action ?? null,
    event_store_table: "events",
    compatibility_views: ["runtime_events"],
    manifest_file: dispatch.manifest ? resolve(rootDir, "launch-manifest.json") : null
  };

  written.authority_file = resolve(rootDir, "authority.json");
  writeJson(written.authority_file, authorityPayload);

  if (dispatch.manifest) {
    written.launch_manifest_file = resolve(rootDir, "launch-manifest.json");
    writeJson(written.launch_manifest_file, dispatch.manifest);
  }

  return written;
}
