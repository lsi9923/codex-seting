import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultDbPath,
  defaultRuntimeRoot,
  detectWorkspaceRoot,
  normalizeWorkspacePath,
  sonolInstallRoot,
  workspaceContextForDbPath,
  getWorkspaceContext
} from "./sonol-runtime-paths.mjs";
import { openStoreWithOptions } from "./sonol-store.mjs";

function stableHash(value) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function pickFirst(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function sanitizeSource(source) {
  return {
    workspace_root: source.workspace_root ?? "detected",
    db_path: source.db_path ?? "default",
    runtime_root: source.runtime_root ?? "default",
    install_root: source.install_root ?? "detected"
  };
}

function registryPathIsUsable(value) {
  return typeof value === "string" && value.trim() && existsSync(resolve(value));
}

function readRegistry(dbPath, workspaceRoot) {
  if (!dbPath || !existsSync(dbPath)) {
    return null;
  }
  let store = null;
  try {
    store = openStoreWithOptions(dbPath, {
      readOnly: true,
      workspaceRoot: workspaceRoot ?? null,
      startDir: workspaceRoot ?? process.cwd()
    });
    return store.getWorkspaceRegistryEntry?.() ?? null;
  } catch {
    return null;
  } finally {
    store?.close?.();
  }
}

export function resolveSonolBinding(options = {}) {
  const env = options.env ?? process.env;
  const startDir = resolve(options.startDir ?? process.cwd());
  const explicitWorkspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : null;
  const explicitDbPath = options.dbPath ? resolve(options.dbPath) : null;
  const explicitRuntimeRoot = options.runtimeRoot ? resolve(options.runtimeRoot) : null;
  const envWorkspaceRoot = env.SONOL_WORKSPACE_ROOT ? resolve(env.SONOL_WORKSPACE_ROOT) : null;
  const envDbPath = env.SONOL_DB_PATH ? resolve(env.SONOL_DB_PATH) : null;
  const envRuntimeRoot = env.SONOL_RUNTIME_ROOT ? resolve(env.SONOL_RUNTIME_ROOT) : null;
  const installRoot = env.SONOL_INSTALL_ROOT ? resolve(env.SONOL_INSTALL_ROOT) : sonolInstallRoot();

  let workspaceRoot = null;
  let source = {
    workspace_root: "detected",
    db_path: "default",
    runtime_root: "default",
    install_root: env.SONOL_INSTALL_ROOT ? "env" : "detected"
  };

  if (explicitWorkspaceRoot) {
    workspaceRoot = normalizeWorkspacePath(explicitWorkspaceRoot);
    source.workspace_root = "flag";
  } else if (envWorkspaceRoot) {
    workspaceRoot = normalizeWorkspacePath(envWorkspaceRoot);
    source.workspace_root = "env";
  } else {
    workspaceRoot = detectWorkspaceRoot(startDir);
  }

  let provisionalDbPath = null;
  if (explicitDbPath) {
    provisionalDbPath = explicitDbPath;
    source.db_path = "flag";
  } else if (envDbPath) {
    provisionalDbPath = envDbPath;
    source.db_path = "env";
  } else {
    provisionalDbPath = defaultDbPath({ workspaceRoot, startDir: workspaceRoot ?? startDir });
  }

  const dbContext = workspaceContextForDbPath(provisionalDbPath, {
    workspaceRoot,
    startDir: workspaceRoot ?? startDir
  });
  const registry = readRegistry(provisionalDbPath, pickFirst(workspaceRoot, dbContext.workspace_root));
  const registryWorkspaceRoot = registry?.workspace_root ? normalizeWorkspacePath(registry.workspace_root) : null;
  const provisionalWorkspace = workspaceRoot
    ? getWorkspaceContext({ workspaceRoot })
    : {
        workspace_id: registry?.workspace_id ?? dbContext.workspace_id,
        workspace_root: workspaceRoot ?? null
      };
  const registryMatchesWorkspace = Boolean(registry) && (
    (!provisionalWorkspace.workspace_id || registry.workspace_id === provisionalWorkspace.workspace_id)
    && (!workspaceRoot || !registryWorkspaceRoot || registryWorkspaceRoot === normalizeWorkspacePath(workspaceRoot))
  );

  if (!explicitWorkspaceRoot && !envWorkspaceRoot && !workspaceRoot && registryWorkspaceRoot && registryMatchesWorkspace) {
    workspaceRoot = registryWorkspaceRoot;
    source.workspace_root = "registry";
  }

  const finalWorkspace = workspaceRoot
    ? getWorkspaceContext({ workspaceRoot })
    : {
        workspace_id: registry?.workspace_id ?? dbContext.workspace_id,
        workspace_root: null
      };
  const allowRegistryPreferredPaths = !explicitWorkspaceRoot && !envWorkspaceRoot && !explicitDbPath && !envDbPath && !explicitRuntimeRoot && !envRuntimeRoot;

  const dbPath = normalizeWorkspacePath(explicitDbPath
    ?? envDbPath
    ?? (allowRegistryPreferredPaths && registryMatchesWorkspace && registryPathIsUsable(registry?.preferred_db_path) ? registry?.preferred_db_path : null)
    ?? defaultDbPath({ workspaceRoot: finalWorkspace.workspace_root ?? workspaceRoot ?? startDir, startDir: finalWorkspace.workspace_root ?? startDir }));
  if (allowRegistryPreferredPaths && registryMatchesWorkspace && registryPathIsUsable(registry?.preferred_db_path)) {
    source.db_path = "registry";
  }

  const runtimeRoot = normalizeWorkspacePath(explicitRuntimeRoot
    ?? envRuntimeRoot
    ?? (allowRegistryPreferredPaths && registryMatchesWorkspace && registryPathIsUsable(registry?.preferred_runtime_root) ? registry?.preferred_runtime_root : null)
    ?? defaultRuntimeRoot({
      workspaceRoot: finalWorkspace.workspace_root ?? workspaceRoot ?? startDir,
      startDir: finalWorkspace.workspace_root ?? startDir
    }));
  if (explicitRuntimeRoot) {
    source.runtime_root = "flag";
  } else if (envRuntimeRoot) {
    source.runtime_root = "env";
  } else if (allowRegistryPreferredPaths && registryMatchesWorkspace && registryPathIsUsable(registry?.preferred_runtime_root)) {
    source.runtime_root = "registry";
  }

  const binding = {
    binding_id: `binding_${stableHash([
      finalWorkspace.workspace_id,
      finalWorkspace.workspace_root ?? "",
      dbPath,
      runtimeRoot,
      installRoot
    ].join("|")).slice(0, 16)}`,
    workspace_id: finalWorkspace.workspace_id,
    workspace_root: finalWorkspace.workspace_root ?? null,
    db_path: resolve(dbPath),
    runtime_root: resolve(runtimeRoot),
    install_root: resolve(installRoot),
    source: sanitizeSource(source)
  };

  return binding;
}

export function sanitizedBinding(binding, { exposePaths = false } = {}) {
  return {
    binding_id: binding.binding_id,
    workspace_id: binding.workspace_id,
    ...(exposePaths ? {
      workspace_root: binding.workspace_root,
      db_path: binding.db_path,
      runtime_root: binding.runtime_root,
      install_root: binding.install_root
    } : {}),
    source: sanitizeSource(binding.source ?? {})
  };
}
