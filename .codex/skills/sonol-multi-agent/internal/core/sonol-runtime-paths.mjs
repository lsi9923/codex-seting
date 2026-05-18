import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const PROJECT_MARKERS = [
  ".sonol",
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "Makefile"
];

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function realpathIfExists(pathname) {
  if (!existsSync(pathname)) {
    return null;
  }
  try {
    return realpathSync.native?.(pathname) ?? realpathSync(pathname);
  } catch {
    return pathname;
  }
}

export function normalizeWorkspacePath(dirPath) {
  const resolved = resolve(dirPath ?? "");
  const directRealpath = realpathIfExists(resolved);
  if (directRealpath) {
    return directRealpath;
  }

  const lowerMountedPath = /^\/mnt\/[a-zA-Z]\//.test(resolved)
    ? resolved.toLowerCase()
    : null;
  const loweredRealpath = lowerMountedPath && lowerMountedPath !== resolved
    ? realpathIfExists(lowerMountedPath)
    : null;
  if (loweredRealpath) {
    return loweredRealpath;
  }

  return resolved;
}

function workspaceIdentityPath(dirPath) {
  const resolved = normalizeWorkspacePath(dirPath);
  if (/^\/mnt\/[a-zA-Z]\//.test(resolved)) {
    return resolved.toLowerCase();
  }
  return resolved;
}

function stableHash(value) {
  return stableHashNumber(value).toString(36);
}

function stableHashNumber(value) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function normalizedDashboardHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
}

function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function windowsMountCaseVariants(dirPath) {
  const resolved = resolve(dirPath ?? "");
  if (!resolved.startsWith("/mnt/")) {
    return [];
  }

  const lower = resolved.toLowerCase();
  const normalized = normalizeWorkspacePath(resolved);
  return unique([
    lower !== resolved ? lower : null,
    normalized !== resolved && normalized !== lower ? normalized : null
  ]);
}

function tryWritableDir(dirPath) {
  try {
    mkdirSync(dirPath, { recursive: true });
    accessSync(dirPath, constants.W_OK);
    return dirPath;
  } catch {
    return null;
  }
}

function pathExists(pathname) {
  try {
    return existsSync(pathname);
  } catch {
    return false;
  }
}

function hasProjectMarker(dirPath) {
  return PROJECT_MARKERS.some((marker) => pathExists(resolve(dirPath, marker)));
}

function existingLegacyWorkspaceDataDir(workspaceRoot) {
  const dataDir = resolve(workspaceRoot, ".sonol", "data");
  const dbPath = resolve(dataDir, "sonol-multi-agent.sqlite");
  return pathExists(dbPath) ? dataDir : null;
}

function existingLegacyWorkspaceRuntimeRoot(workspaceRoot) {
  const runtimeRoot = resolve(workspaceRoot, ".sonol", "runtime");
  return pathExists(runtimeRoot) ? runtimeRoot : null;
}

export function detectWorkspaceRoot(startDir = process.cwd()) {
  const explicitWorkspaceRoot = process.env.SONOL_WORKSPACE_ROOT;
  if (explicitWorkspaceRoot) {
    return normalizeWorkspacePath(explicitWorkspaceRoot);
  }

  const initialDir = normalizeWorkspacePath(startDir ?? process.cwd());
  let currentDir = initialDir;
  let projectRoot = null;

  while (true) {
    if (pathExists(resolve(currentDir, ".sonol"))) {
      return currentDir;
    }

    if (!projectRoot && hasProjectMarker(currentDir)) {
      projectRoot = currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return normalizeWorkspacePath(projectRoot ?? initialDir);
}

export function workspaceScopeId(workspaceRoot = detectWorkspaceRoot()) {
  return `ws_${stableHash(workspaceIdentityPath(workspaceRoot)).slice(0, 12)}`;
}

export function getWorkspaceContext(options = {}) {
  const workspaceRoot = options.workspaceRoot
    ? normalizeWorkspacePath(options.workspaceRoot)
    : detectWorkspaceRoot(options.startDir);

  return {
    workspace_root: workspaceRoot,
    workspace_id: workspaceScopeId(workspaceRoot)
  };
}

export function workspaceContextForDbPath(dbPath, options = {}) {
  const resolvedDbPath = normalizeWorkspacePath(dbPath ?? "");
  const localMarker = "/.sonol/data/sonol-multi-agent.sqlite";
  const localIndex = resolvedDbPath.lastIndexOf(localMarker);
  if (localIndex > 0) {
    const workspaceRoot = normalizeWorkspacePath(resolvedDbPath.slice(0, localIndex));
    return {
      workspace_root: workspaceRoot,
      workspace_id: workspaceScopeId(workspaceRoot)
    };
  }

  const match = resolvedDbPath.match(/[/\\]workspaces[/\\](ws_[^/\\]+)[/\\]data[/\\]sonol-multi-agent\.sqlite$/);
  if (match) {
    const explicitWorkspaceRoot = options.workspaceRoot
      ? normalizeWorkspacePath(options.workspaceRoot)
      : null;
    return {
      workspace_root: explicitWorkspaceRoot,
      workspace_id: match[1]
    };
  }

  return getWorkspaceContext(options);
}

function defaultGlobalSonolRoot() {
  const explicitHome = process.env.SONOL_HOME_DIR;
  if (explicitHome) {
    const writable = tryWritableDir(resolve(explicitHome));
    if (writable) {
      return writable;
    }
  }

  const xdgStateHome = process.env.XDG_STATE_HOME
    ? resolve(process.env.XDG_STATE_HOME, "sonol")
    : null;
  const xdgDataHome = process.env.XDG_DATA_HOME
    ? resolve(process.env.XDG_DATA_HOME, "sonol")
    : null;
  const candidates = unique([
    xdgStateHome,
    xdgDataHome,
    resolve(homedir(), ".local", "state", "sonol"),
    resolve(homedir(), ".codex", "sonol"),
    resolve(tmpdir(), "sonol-runtime")
  ]);

  for (const candidate of candidates) {
    const writable = tryWritableDir(candidate);
    if (writable) {
      return writable;
    }
  }

  throw new Error("Could not find a writable global Sonol home directory.");
}

export function sonolInstallRoot() {
  return ROOT_DIR;
}

export function skillScriptPath(skillName, scriptName) {
  return resolve(ROOT_DIR, "skills", skillName, "scripts", scriptName);
}

export function defaultDataDir(options = {}) {
  const explicitDataDir = process.env.SONOL_DATA_DIR;
  if (explicitDataDir) {
    const writable = tryWritableDir(resolve(explicitDataDir));
    if (writable) {
      return writable;
    }
  }

  const workspace = getWorkspaceContext(options);
  const legacyWorkspaceDataDir = existingLegacyWorkspaceDataDir(workspace.workspace_root);
  if (legacyWorkspaceDataDir) {
    const writable = tryWritableDir(legacyWorkspaceDataDir);
    if (writable) {
      return writable;
    }
  }

  const globalRoot = defaultGlobalSonolRoot();
  const candidateRoots = unique([
    normalizeWorkspacePath(resolve(workspace.workspace_root, ".sonol")),
    ...windowsMountCaseVariants(resolve(workspace.workspace_root, ".sonol")),
    normalizeWorkspacePath(resolve(globalRoot, "workspaces", workspace.workspace_id)),
    ...windowsMountCaseVariants(resolve(globalRoot, "workspaces", workspace.workspace_id)),
    normalizeWorkspacePath(resolve(tmpdir(), "sonol-runtime", "workspaces", workspace.workspace_id))
  ]);

  for (const rootDir of candidateRoots) {
    const writable = tryWritableDir(resolve(rootDir, "data"));
    if (writable) {
      return writable;
    }
  }

  throw new Error("Could not find a writable Sonol data directory.");
}

export function defaultDbPath(options = {}) {
  if (process.env.SONOL_DB_PATH) {
    return resolve(process.env.SONOL_DB_PATH);
  }

  return resolve(defaultDataDir(options), "sonol-multi-agent.sqlite");
}

export function defaultLogDir(options = {}) {
  if (process.env.SONOL_LOG_DIR) {
    const writable = tryWritableDir(resolve(process.env.SONOL_LOG_DIR));
    if (writable) {
      return writable;
    }
  }

  const logDir = resolve(defaultDataDir(options), "logs");
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

export function defaultRuntimeRoot(options = {}) {
  if (process.env.SONOL_RUNTIME_ROOT) {
    const writable = tryWritableDir(resolve(process.env.SONOL_RUNTIME_ROOT));
    if (writable) {
      return writable;
    }
  }

  const workspace = getWorkspaceContext(options);
  const legacyRuntimeRoot = existingLegacyWorkspaceRuntimeRoot(workspace.workspace_root);
  if (legacyRuntimeRoot) {
    const writable = tryWritableDir(legacyRuntimeRoot);
    if (writable) {
      return writable;
    }
  }

  const globalRoot = defaultGlobalSonolRoot();
  const candidateRoots = unique([
    normalizeWorkspacePath(resolve(workspace.workspace_root, ".sonol", "runtime")),
    ...windowsMountCaseVariants(resolve(workspace.workspace_root, ".sonol", "runtime")),
    normalizeWorkspacePath(resolve(defaultDataDir(options), "..", "runtime")),
    normalizeWorkspacePath(resolve(globalRoot, "workspaces", workspace.workspace_id, "runtime")),
    ...windowsMountCaseVariants(resolve(globalRoot, "workspaces", workspace.workspace_id, "runtime"))
  ]);

  for (const rootDir of candidateRoots) {
    const writable = tryWritableDir(rootDir);
    if (writable) {
      return writable;
    }
  }

  throw new Error("Could not find a writable Sonol runtime directory.");
}

export function dashboardHost(options = {}) {
  return String(
    options.host
    ?? (options.preferEnv !== false ? process.env.SONOL_DASHBOARD_HOST : null)
    ?? "127.0.0.1"
  );
}

export function dashboardPortForWorkspace(options = {}) {
  if (options.dashboardUrl) {
    try {
      const parsed = new URL(options.dashboardUrl);
      if (parsed.port) {
        return Number(parsed.port);
      }
      return parsed.protocol === "https:" ? 443 : 80;
    } catch {
    }
  }

  if (options.port != null) {
    return resolvePositiveInteger(options.port, 18081);
  }

  if (options.preferEnv !== false && process.env.SONOL_DASHBOARD_PORT) {
    return resolvePositiveInteger(process.env.SONOL_DASHBOARD_PORT, 18081);
  }

  const workspace = getWorkspaceContext(options);
  const basePort = resolvePositiveInteger(
    options.basePort ?? process.env.SONOL_DASHBOARD_PORT_BASE,
    18081
  );
  const span = resolvePositiveInteger(
    options.portSpan ?? process.env.SONOL_DASHBOARD_PORT_SPAN,
    20000
  );

  return basePort + (stableHashNumber(workspace.workspace_id) % span);
}

export function dashboardUrlForWorkspace(options = {}) {
  if (options.dashboardUrl) {
    return String(options.dashboardUrl);
  }

  if (options.preferEnv !== false && process.env.SONOL_DASHBOARD_URL) {
    return String(process.env.SONOL_DASHBOARD_URL);
  }

  const host = dashboardHost(options);
  const port = dashboardPortForWorkspace(options);
  return `http://${normalizedDashboardHost(host)}:${port}`;
}
