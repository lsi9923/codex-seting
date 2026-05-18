#!/usr/bin/env node
import { resolve } from "node:path";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";
import { openStoreWithOptions } from "../internal/core/sonol-store.mjs";

let workspaceRoot = process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd();
let dbPath = null;
let dashboardUrl = null;
let allowDbMismatch = false;
const usageText = "Usage: node show-snapshot.mjs [--workspace-root <workspace_root>] [--db path] [--dashboard-url <url>] [--allow-db-mismatch]";
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--help") {
    console.error(usageText);
    process.exit(0);
  }
  if (process.argv[index] === "--db") {
    dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (process.argv[index] === "--workspace-root") {
    workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (process.argv[index] === "--dashboard-url") {
    dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (process.argv[index] === "--allow-db-mismatch") {
    allowDbMismatch = true;
  } else {
    console.error(usageText);
    process.exit(1);
  }
}

const authority = await resolveCliAuthoritativeBinding({
  workspaceRoot,
  dbPath,
  dashboardUrl,
  startDir: workspaceRoot
});
if (authority.authority_mismatch && !allowDbMismatch) {
  console.error(formatAuthorityMismatchMessage(authority));
  process.exit(1);
}
const store = openStoreWithOptions(authority.binding.db_path, {
  readOnly: true,
  workspaceRoot: authority.binding.workspace_root ?? workspaceRoot,
  startDir: authority.binding.workspace_root ?? workspaceRoot
});
try {
  process.stdout.write(`${JSON.stringify(store.getSnapshot(), null, 2)}\n`);
} finally {
  store.close();
}
