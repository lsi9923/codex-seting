#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ingestRuntimeReport } from "../../sonol-multi-agent/internal/core/sonol-runtime-ingest.mjs";
import { defaultDbPath } from "../../sonol-multi-agent/internal/core/sonol-store.mjs";
import { runWithRetryingStore } from "./_report-common.mjs";

const args = {
  dbPath: defaultDbPath(),
  planId: null,
  runId: null,
  agentId: null,
  inputFile: null
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--plan-id") {
    args.planId = process.argv[index + 1];
    index += 1;
  } else if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--agent-id") {
    args.agentId = process.argv[index + 1];
    index += 1;
  } else if (token === "--input-file") {
    args.inputFile = resolve(process.argv[index + 1]);
    index += 1;
  }
}

const inputText = args.inputFile
  ? readFileSync(args.inputFile, "utf8")
  : await new Promise((resolvePromise, rejectPromise) => {
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        raw += chunk;
      });
      process.stdin.on("end", () => resolvePromise(raw));
      process.stdin.on("error", rejectPromise);
    });

if (!String(inputText ?? "").trim()) {
  console.error("Usage: node ingest-json-report.mjs [--db path] [--plan-id <plan_id>] [--run-id <run_id>] [--agent-id <agent_id>] [--input-file path]");
  console.error("Either provide --input-file or pipe JSON report content to stdin.");
  process.exit(1);
}

if (!args.runId) {
  console.error("Missing required flag: --run-id");
  process.exit(1);
}

if (!args.planId) {
  console.error("Missing required flag: --plan-id");
  process.exit(1);
}

const output = runWithRetryingStore(args, "ingest-json-report", (store) => {
  const result = ingestRuntimeReport(store, inputText, {
    planId: args.planId,
    runId: args.runId,
    agentId: args.agentId
  });
  const run = result.run_id ? store.getRun(result.run_id) : null;
  return {
    ...result,
    run_status: run?.status ?? null
  };
});

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
