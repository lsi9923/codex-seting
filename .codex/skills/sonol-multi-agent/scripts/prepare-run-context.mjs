#!/usr/bin/env node
import { resolve } from "node:path";
import { prepareRunContextForRun } from "../internal/core/sonol-adapters.mjs";
import { defaultDbPath, openStore } from "../internal/core/sonol-store.mjs";

const args = {
  dbPath: null,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd()
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
  }
}

if (!args.runId) {
  console.error("Usage: node prepare-run-context.mjs --run-id <run_id> [--workspace-root <workspace_root>] [--db path]");
  process.exit(1);
}

args.dbPath ??= defaultDbPath({ workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
try {
  const run = store.getRun?.(args.runId) ?? null;
  if (!run) {
    console.error(`Run not found: ${args.runId}`);
    process.exit(1);
  }
  const result = prepareRunContextForRun(store, run);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close();
}
