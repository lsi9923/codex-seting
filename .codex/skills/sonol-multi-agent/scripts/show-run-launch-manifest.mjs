#!/usr/bin/env node
import { resolve } from "node:path";
import { buildLaunchManifestForRun } from "../internal/core/sonol-adapters.mjs";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { openStore } from "../internal/core/sonol-store.mjs";

const args = {
  dbPath: null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  dashboardUrl: null,
  allowDbMismatch: false
};
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--dashboard-url") {
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--allow-db-mismatch") {
    args.allowDbMismatch = true;
  }
}

if (!args.runId) {
  console.error("Usage: node show-run-launch-manifest.mjs --run-id <run_id> [--workspace-root <workspace_root>] [--db path] [--dashboard-url <url>] [--allow-db-mismatch]");
  process.exit(1);
}

const authority = await resolveCliAuthoritativeBinding({
  workspaceRoot: args.workspaceRoot,
  dbPath: args.dbPath,
  dashboardUrl: args.dashboardUrl,
  startDir: args.workspaceRoot
});
if (authority.authority_mismatch && !args.allowDbMismatch) {
  console.error(formatAuthorityMismatchMessage(authority));
  process.exit(1);
}
const store = openStore(authority.binding.db_path, {
  workspaceRoot: authority.binding.workspace_root ?? args.workspaceRoot,
  startDir: authority.binding.workspace_root ?? args.workspaceRoot
});
const launchData = store.getRunLaunchCandidates?.(args.runId) ?? null;
if (!launchData) {
  console.error(`Run not found: ${args.runId}`);
  process.exit(1);
}

const { run } = launchData;
const manifest = buildLaunchManifestForRun(store, run);

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
