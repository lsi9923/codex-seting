#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectWorkspaceRoot } from "../internal/core/sonol-runtime-paths.mjs";

const SKILL_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKILLS_ROOT = resolve(SKILL_ROOT, "..");
const RUNTIME_SKILL_ROOT = resolve(SKILLS_ROOT, "sonol-agent-runtime");
const DASHBOARD_DIST = resolve(SKILL_ROOT, "internal", "dashboard", "dist", "index.html");
const AJV_PACKAGE = resolve(SKILL_ROOT, "node_modules", "ajv", "package.json");
const WS_PACKAGE = resolve(SKILL_ROOT, "node_modules", "ws", "package.json");
const AJV_ENTRY = resolve(SKILL_ROOT, "node_modules", "ajv", "dist", "2020.js");
const WS_ENTRY = resolve(SKILL_ROOT, "node_modules", "ws", "wrapper.mjs");
const REPORT_PROGRESS_SCRIPT = resolve(RUNTIME_SKILL_ROOT, "scripts", "report-progress.mjs");
const REPORT_COMPLETION_SCRIPT = resolve(RUNTIME_SKILL_ROOT, "scripts", "report-completion.mjs");

function parseMajor(version) {
  const match = String(version ?? "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function canImport(modulePath) {
  try {
    await import(pathToFileURL(modulePath).href);
    return true;
  } catch {
    return false;
  }
}

const workspaceRoot = process.env.SONOL_WORKSPACE_ROOT ?? detectWorkspaceRoot(process.cwd());
const expectedWorkspaceDbPath = resolve(workspaceRoot, ".sonol", "data", "sonol-multi-agent.sqlite");
const expectedWorkspaceRuntimeRoot = resolve(workspaceRoot, ".sonol", "runtime");
const result = {
  ok: true,
  node_version: process.version,
  workspace_root: workspaceRoot,
  resolved_db_path: process.env.SONOL_DB_PATH ?? expectedWorkspaceDbPath,
  resolved_runtime_root: process.env.SONOL_RUNTIME_ROOT ?? expectedWorkspaceRuntimeRoot,
  checks: []
};

function pushCheck(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  if (!ok) {
    result.ok = false;
  }
}

pushCheck("node_version", parseMajor(process.version) >= 22, "Node.js >= 22 is required because Sonol uses node:sqlite.");
pushCheck("runtime_skill_root", existsSync(RUNTIME_SKILL_ROOT), `Expected sibling runtime skill at ${RUNTIME_SKILL_ROOT}`);
pushCheck("runtime_progress_script", existsSync(REPORT_PROGRESS_SCRIPT), `Expected runtime reporter entrypoint at ${REPORT_PROGRESS_SCRIPT}`);
pushCheck("runtime_completion_script", existsSync(REPORT_COMPLETION_SCRIPT), `Expected runtime reporter entrypoint at ${REPORT_COMPLETION_SCRIPT}`);
pushCheck("vendored_ajv", existsSync(AJV_PACKAGE), `Expected bundled Ajv at ${AJV_PACKAGE}`);
pushCheck("vendored_ws", existsSync(WS_PACKAGE), `Expected bundled ws at ${WS_PACKAGE}`);
pushCheck("dashboard_dist", existsSync(DASHBOARD_DIST), `Expected built dashboard dist at ${DASHBOARD_DIST}`);
pushCheck("ajv_dependency", await canImport(AJV_ENTRY), `Portable skill bundle must be able to import bundled Ajv from ${AJV_ENTRY}.`);
pushCheck("ws_dependency", await canImport(WS_ENTRY), `Portable dashboard server must be able to import bundled ws from ${WS_ENTRY}.`);
pushCheck(
  "workspace_local_db_preferred",
  !existsSync(expectedWorkspaceDbPath) || result.resolved_db_path === expectedWorkspaceDbPath,
  existsSync(expectedWorkspaceDbPath)
    ? `Expected workspace-local DB at ${expectedWorkspaceDbPath} to be preferred when it already exists.`
    : `Workspace-local DB not present at ${expectedWorkspaceDbPath}; use --workspace-root or SONOL_WORKSPACE_ROOT if you expected workspace-local binding.`
);
pushCheck(
  "workspace_local_runtime_preferred",
  !existsSync(expectedWorkspaceRuntimeRoot) || result.resolved_runtime_root === expectedWorkspaceRuntimeRoot,
  existsSync(expectedWorkspaceRuntimeRoot)
    ? `Expected workspace-local runtime root at ${expectedWorkspaceRuntimeRoot} to be preferred when it already exists.`
    : `Workspace-local runtime root not present at ${expectedWorkspaceRuntimeRoot}; use --workspace-root or SONOL_WORKSPACE_ROOT if you expected workspace-local binding.`
);
pushCheck(
  "filesystem_mnt_path_preserved",
  !expectedWorkspaceDbPath.startsWith("/mnt/") || result.resolved_db_path === expectedWorkspaceDbPath,
  "Resolved DB path should preserve the active workspace filesystem path on WSL-style mounts."
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
