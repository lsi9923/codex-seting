#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { openStore } from "../internal/core/sonol-store.mjs";
import { nowIso } from "../../sonol-agent-runtime/scripts/_report-common.mjs";

const args = {
  workspaceRoot: process.cwd(),
  intervalMs: 1500,
  dbPath: null,
  runId: null,
  planId: null
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--plan-id") {
    args.planId = process.argv[index + 1];
    index += 1;
  } else if (token === "--interval-ms") {
    args.intervalMs = Number(process.argv[index + 1]);
    index += 1;
  }
}

if (!args.runId || !args.dbPath) {
  process.exit(1);
}

const trackerDir = "/tmp/sonol-main-watchers";
const pidFile = resolve(trackerDir, `${args.runId}.pid`);
mkdirSync(trackerDir, { recursive: true });
writeFileSync(pidFile, `${process.pid}\n`, "utf8");

const IGNORE_DIRS = new Set([
  ".git",
  ".sonol",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);

function shouldIgnore(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORE_DIRS.has(part))) {
    return true;
  }
  return normalized.startsWith(".sonol_fix/");
}

function walk(rootDir, currentDir = rootDir, files = new Map()) {
  let entries = [];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = resolve(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);
    if (!relPath || shouldIgnore(relPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(rootDir, fullPath, files);
      continue;
    }
    try {
      const stats = statSync(fullPath);
      files.set(relPath, { mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
    }
  }

  return files;
}

function appendArtifact(store, { run, plan, relPath }) {
  const mainAgent = plan.agents.find((agent) => agent.agent_id === "agent_main");
  const taskId = mainAgent?.current_task_id ?? "task_main_integrate";
  const normalizedRef = relPath.replace(/\\/g, "/");
  const eventId = [
    "artifact",
    run.run_id,
    "agent_main",
    taskId,
    normalizedRef.replace(/[^a-zA-Z0-9._/-]+/g, "_"),
    Date.now()
  ].join("_");

  store.appendEvent("artifact_event", {
    event_id: eventId,
    plan_id: plan.plan_id,
    run_id: run.run_id,
    agent_id: "agent_main",
    task_id: taskId,
    artifact_type: "file",
    artifact_ref: normalizedRef,
    summary: `파일 변경 감지: ${normalizedRef}`,
    detail: "Main workspace watcher detected a file update and recorded it for dashboard visibility.",
    validation_status: "unchecked",
    timestamp: nowIso(),
    schema_version: "1.0.0"
  }, {
    internal_control: true
  });
}

function getLiveContext() {
  const store = openStore(args.dbPath, {
    workspaceRoot: args.workspaceRoot,
    startDir: args.workspaceRoot
  });
  try {
    const run = store.getRun(args.runId);
    if (!run) {
      return { run: null, plan: null };
    }
    const plan = store.getPlanForRun(run);
    return { run, plan };
  } finally {
    store.close();
  }
}

let previousSnapshot = walk(args.workspaceRoot);

const timer = setInterval(() => {
  const { run, plan } = getLiveContext();
  if (!run || !plan || ["completed", "failed", "cancelled", "stale"].includes(run.status)) {
    clearInterval(timer);
    try {
      unlinkSync(pidFile);
    } catch {
    }
    return;
  }

  const nextSnapshot = walk(args.workspaceRoot);
  const changed = [];

  for (const [relPath, nextMeta] of nextSnapshot.entries()) {
    const previousMeta = previousSnapshot.get(relPath);
    if (!previousMeta || previousMeta.mtimeMs !== nextMeta.mtimeMs || previousMeta.size !== nextMeta.size) {
      changed.push(relPath);
    }
  }

  if (changed.length > 0) {
    const store = openStore(args.dbPath, {
      workspaceRoot: args.workspaceRoot,
      startDir: args.workspaceRoot
    });
    try {
      const currentRun = store.getRun(args.runId);
      const currentPlan = currentRun ? store.getPlanForRun(currentRun) : null;
      if (currentRun && currentPlan) {
        for (const relPath of changed) {
          appendArtifact(store, { run: currentRun, plan: currentPlan, relPath });
        }
      }
    } finally {
      store.close();
    }
  }

  previousSnapshot = nextSnapshot;
}, Math.max(1000, args.intervalMs));

process.on("SIGTERM", () => {
  clearInterval(timer);
  try {
    unlinkSync(pidFile);
  } catch {
  }
  process.exit(0);
});
