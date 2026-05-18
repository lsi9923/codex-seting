#!/usr/bin/env node
import { resolve } from "node:path";
import { formatAuthorityMismatchMessage, resolveCliAuthoritativeBinding } from "../internal/core/sonol-cli-authority.mjs";

const args = {
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  dbPath: null,
  dashboardUrl: null,
  allowDbMismatch: false
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--dashboard-url") {
    args.dashboardUrl = process.argv[index + 1];
    index += 1;
  } else if (token === "--allow-db-mismatch") {
    args.allowDbMismatch = true;
  } else if (token === "--help") {
    console.error("Usage: node show-authority.mjs [--workspace-root <workspace_root>] [--db path] [--dashboard-url <url>] [--allow-db-mismatch]");
    process.exit(0);
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

process.stdout.write(`${JSON.stringify({
  workspace_root: args.workspaceRoot,
  dashboard_url: authority.dashboard_url,
  binding: authority.binding,
  health: authority.health,
  rebound_to_authoritative_db: authority.rebound_to_authoritative_db,
  authority_mismatch: authority.authority_mismatch,
  warnings: authority.warnings
}, null, 2)}\n`);
