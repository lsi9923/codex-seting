#!/usr/bin/env node
import { resolve } from "node:path";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { collectRunDiagnostics } from "../internal/core/sonol-diagnostics.mjs";
import { openStoreWithOptions } from "../internal/core/sonol-store.mjs";

const args = {
  dbPath: null,
  logLimit: 60,
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
  } else if (token === "--log-limit") {
    args.logLimit = Number(process.argv[index + 1]);
    index += 1;
  }
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
const store = openStoreWithOptions(authority.binding.db_path, {
  readOnly: true,
  workspaceRoot: authority.binding.workspace_root ?? args.workspaceRoot,
  startDir: authority.binding.workspace_root ?? args.workspaceRoot
});
try {
  const runId = args.runId ?? store.listRuns().find((run) =>
    ["queued", "prepared", "running", "blocked"].includes(run.status)
  )?.run_id;
  if (!runId) {
    throw new Error("No target run found. Use --run-id or create/launch a run first.");
  }

  const diagnostics = collectRunDiagnostics(store, runId, { logLimit: args.logLimit });
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
} finally {
  store.close();
}
