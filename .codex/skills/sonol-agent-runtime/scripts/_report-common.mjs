import { resolve } from "node:path";
import { appendStructuredLog } from "../../sonol-multi-agent/internal/core/sonol-log.mjs";
import { resolveRunPromptPath } from "../../sonol-multi-agent/internal/core/sonol-runtime-context.mjs";
import { defaultDbPath, openStore } from "../../sonol-multi-agent/internal/core/sonol-store.mjs";

const SQLITE_LOCK_RETRY_ATTEMPTS = 6;
const SQLITE_LOCK_RETRY_MS = 250;

export function parseFlagArgs(argv) {
  const args = { dbPath: defaultDbPath() };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      args[key] = argv[index + 1];
      index += 1;
    }
  }

  if (args.db) {
    args.dbPath = args.db;
  }

  if (args.dbPath) {
    args.dbPath = resolve(args.dbPath);
  }
  if (args.workspaceRoot) {
    args.workspaceRoot = resolve(args.workspaceRoot);
  }

  return args;
}

export function storeForArgs(args) {
  return openStore(args.dbPath ?? defaultDbPath(), {
    workspaceRoot: args.workspaceRoot ?? process.env.SONOL_WORKSPACE_ROOT ?? null,
    startDir: args.workspaceRoot ?? process.env.SONOL_WORKSPACE_ROOT ?? process.cwd()
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isSqliteLockedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database is locked");
}

export function runWithRetry(action, work, options = {}) {
  const attempts = options.attempts ?? SQLITE_LOCK_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? SQLITE_LOCK_RETRY_MS;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return work(attempt);
    } catch (error) {
      lastError = error;
      if (!isSqliteLockedError(error) || attempt === attempts) {
        throw error;
      }

      appendStructuredLog("sonol-runtime", {
        action,
        stage: "retry",
        attempt,
        max_attempts: attempts,
        delay_ms: delayMs,
        error: error instanceof Error ? error.message : String(error)
      });
      sleep(delayMs * attempt);
    }
  }

  throw lastError ?? new Error(`${action} failed without a captured error`);
}

export function runWithRetryingStore(args, action, callback) {
  return runWithRetry(action, () => {
    const store = storeForArgs(args);
    try {
      validateCurrentRunBinding(store, args);
      return callback(store);
    } finally {
      store.close();
    }
  });
}

function currentPromptHint(run, plan, agentId) {
  return resolveRunPromptPath(run, agentId, {
    workspaceRoot: run?.workspace_root ?? plan?.workspace_root ?? undefined,
    startDir: run?.workspace_root ?? plan?.workspace_root ?? process.cwd()
  });
}

export function validateCurrentRunBinding(store, args) {
  if (!args.runId) {
    return;
  }

  const run = store.getRun(args.runId);
  if (!run) {
    throw new Error(`Run not found: ${args.runId}. This usually means the wrong --db was used or the generated run-scoped prompt/command file was not followed exactly.`);
  }

  const plan = store.getPlanForRun(run);
  if (!plan) {
    throw new Error(`Plan not found for run: ${run.plan_id}. Use the generated run-scoped prompt/command file for the active run.`);
  }

  if (!args.planId) {
    throw new Error(`Missing required flag: --plan-id for run ${args.runId}. Do not shorten the generated report command.`);
  }

  if (args.planId !== plan.plan_id) {
    throw new Error(`Plan mismatch for run ${args.runId}: expected ${plan.plan_id}, received ${args.planId}. Use the generated run-scoped prompt/command file for the active run.`);
  }

  if (args.agentId) {
    if (args.agentId === "agent_main") {
      throw new Error("agent_main must report through report-main.mjs. Do not use the generic sonol-agent-runtime report-* scripts for the Main agent.");
    }
    const plannedAgent = plan.agents.find((agent) => agent.agent_id === args.agentId);
    if (!plannedAgent) {
      throw new Error(`Agent not found in plan ${plan.plan_id}: ${args.agentId}. Use the exact generated agent prompt/command for this run.`);
    }

    if (args.taskId) {
      const allowedTaskIds = Array.isArray(plannedAgent.assigned_task_ids)
        ? plannedAgent.assigned_task_ids.filter(Boolean)
        : [];
      const currentTaskId = plannedAgent.current_task_id ? [plannedAgent.current_task_id] : [];
      const acceptedTaskIds = new Set([...allowedTaskIds, ...currentTaskId]);
      if (acceptedTaskIds.size > 0 && !acceptedTaskIds.has(args.taskId)) {
        throw new Error(`Task ${args.taskId} is not assigned to agent ${args.agentId}. Use the exact generated task id from the run-scoped prompt/command file.`);
      }
    }
  }

  if (["completed", "failed", "cancelled", "stale"].includes(run.status)) {
    const promptHint = currentPromptHint(run, plan, args.agentId);
    throw new Error(
      `Run ${args.runId} is already ${run.status}. Do not write more events to a finished run. Use ${promptHint}`
    );
  }

  const activeRun = store.getActiveRunForPlan(plan.plan_id);
  if (activeRun && activeRun.run_id !== args.runId) {
    const promptHint = currentPromptHint(run, plan, args.agentId);
    appendStructuredLog("sonol-runtime", {
      action: "report_script_stale_run_rejected",
      stale_run_id: args.runId,
      active_run_id: activeRun.run_id,
      agent_id: args.agentId,
      plan_id: plan.plan_id,
      prompt_hint: promptHint
    });
    throw new Error(
      `Stale run_id for ${args.agentId}. Current active run is ${activeRun.run_id}. Use ${promptHint}`
    );
  }
}

export function logReportLifecycle(stage, scriptName, details = {}) {
  return appendStructuredLog("sonol-runtime", {
    action: "report_script",
    stage,
    script: scriptName,
    ...details
  });
}

export function createEventId(prefix, runId, agentId = "system") {
  const parts = Array.prototype.slice.call(arguments, 3)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("|");
  const source = `${prefix}|${runId}|${agentId}|${parts}`;
  let hash = 2166136261;
  const bytes = Buffer.from(source, "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${prefix}_${runId}_${agentId}_${hash.toString(36)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function compactText(value, maxLength = 96) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function compactList(value, maxLength = 80) {
  if (!value) {
    return [];
  }

  return String(value)
    .split("|")
    .map((item) => compactText(item, maxLength))
    .filter(Boolean);
}
