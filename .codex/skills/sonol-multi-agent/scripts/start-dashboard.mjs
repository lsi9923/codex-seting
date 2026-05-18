#!/usr/bin/env node
import { resolve } from "node:path";
import { writeDashboardAuthorityArtifacts } from "../internal/core/sonol-authority-artifacts.mjs";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { dashboardPortForWorkspace, dashboardUrlForWorkspace } from "../internal/core/sonol-runtime-paths.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";

const args = {
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ?? process.cwd(),
  dbPath: process.env.SONOL_DB_PATH ?? null,
  dashboardUrl: null,
  allowDbMismatch: false
};
const allowedFlags = new Set(["--workspace-root", "--db", "--dashboard-url", "--allow-db-mismatch"]);
let hasExplicitWorkspaceRoot = false;
let hasExplicitDbPath = false;

function buildGuidance(errorCode, message, extra = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    expected_usage: [
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs --workspace-root /abs/workspace",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs --workspace-root /abs/workspace --db /abs/sonol.sqlite",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs --workspace-root /abs/workspace --dashboard-url http://127.0.0.1:18081"
    ],
    rules: [
      "--workspace-root is recommended when launching the dashboard for another workspace",
      "By default the dashboard URL is derived from the workspace binding; use --dashboard-url only to override it intentionally",
      "If you use a custom DB path, pass the same --workspace-root and --db pair used by present-proposal.mjs"
    ],
    ...extra
  };
}

function failWithGuidance(errorCode, message, extra = {}) {
  const guidance = buildGuidance(errorCode, message, extra);
  console.error(message);
  console.error("");
  console.error("Expected format:");
  for (const line of guidance.expected_usage) {
    console.error(`- ${line}`);
  }
  console.error("");
  console.error(JSON.stringify(guidance, null, 2));
  process.exit(1);
}

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--help") {
    const guidance = buildGuidance("HELP", "Show start-dashboard usage.");
    for (const line of guidance.expected_usage) {
      console.error(line);
    }
    process.exit(0);
  }
  if (token.startsWith("--") && !allowedFlags.has(token)) {
    failWithGuidance("UNKNOWN_FLAG", `Unsupported flag: ${token}`, { unsupported_flag: token });
  }
  if (token === "--workspace-root") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --workspace-root", { flag: "--workspace-root" });
    }
    args.workspaceRoot = process.argv[index + 1];
    hasExplicitWorkspaceRoot = true;
    index += 1;
  } else if (token === "--db") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --db", { flag: "--db" });
    }
    args.dbPath = process.argv[index + 1];
    hasExplicitDbPath = true;
    index += 1;
  } else if (token === "--dashboard-url") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --dashboard-url", { flag: "--dashboard-url" });
    }
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--allow-db-mismatch") {
    args.allowDbMismatch = true;
  }
}

const authority = await resolveCliAuthoritativeBinding({
  workspaceRoot: hasExplicitWorkspaceRoot ? args.workspaceRoot : null,
  dbPath: hasExplicitDbPath ? args.dbPath : null,
  dashboardUrl: args.dashboardUrl,
  startDir: process.cwd()
});
if (authority.authority_mismatch && !args.allowDbMismatch) {
  failWithGuidance("AUTHORITATIVE_DB_MISMATCH", formatAuthorityMismatchMessage(authority), {
    authority_mismatch: authority.authority_mismatch
  });
}
const binding = authority.binding;
args.dashboardUrl = args.dashboardUrl ?? authority.dashboard_url;

if (hasExplicitWorkspaceRoot) {
  if (binding.workspace_root) {
    process.env.SONOL_WORKSPACE_ROOT = binding.workspace_root;
  } else {
    delete process.env.SONOL_WORKSPACE_ROOT;
  }
} else {
  if (binding.workspace_root) {
    process.env.SONOL_WORKSPACE_ROOT ??= binding.workspace_root;
  }
}
if (hasExplicitDbPath) {
  process.env.SONOL_DB_PATH = binding.db_path;
} else {
  process.env.SONOL_DB_PATH ??= binding.db_path;
}
const dashboardUrl = dashboardUrlForWorkspace({
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  dashboardUrl: args.dashboardUrl,
  preferEnv: false
});
const dashboardPort = dashboardPortForWorkspace({
  workspaceRoot: binding.workspace_root ?? args.workspaceRoot,
  dashboardUrl,
  preferEnv: false
});
process.env.SONOL_RUNTIME_ROOT = binding.runtime_root;
process.env.SONOL_INSTALL_ROOT ??= binding.install_root;
process.env.SONOL_DASHBOARD_URL = dashboardUrl;
process.env.SONOL_DASHBOARD_PORT = String(dashboardPort);

const bootstrapStore = openStore(binding.db_path, {
  workspaceRoot: binding.workspace_root ?? process.cwd(),
  startDir: binding.workspace_root ?? process.cwd(),
  runtimeRoot: binding.runtime_root
});
bootstrapStore.upsertWorkspaceRegistry?.({
  workspace_id: binding.workspace_id,
  workspace_root: binding.workspace_root,
  preferred_db_path: binding.db_path,
  preferred_runtime_root: binding.runtime_root,
  binding_id: binding.binding_id,
  source: binding.source
});
bootstrapStore.close();
writeDashboardAuthorityArtifacts({
  binding,
  dashboardUrl,
  source: "start-dashboard"
});

await import("../internal/dashboard/server.mjs");
