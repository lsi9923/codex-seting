#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { appendStructuredLog } from "../internal/core/sonol-log.mjs";
import { defaultDbPath, openStore } from "../internal/core/sonol-store.mjs";
import { compactList, compactText, createEventId, nowIso, runWithRetry } from "../../sonol-agent-runtime/scripts/_report-common.mjs";

const args = {
  dbPath: null,
  type: "progress",
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT ? resolve(process.env.SONOL_WORKSPACE_ROOT) : process.cwd(),
  workspaceRootExplicit: Boolean(process.env.SONOL_WORKSPACE_ROOT)
};
const usageText = "Usage: node report-main.mjs [--run-id <run_id>] --type <progress|artifact|completion|session> [--workspace-root <workspace_root>] [--db path] [--reconcile-completed-agent-ids <agent_a,agent_b>] [--auto-reconcile-completed-agents true|false] [--provider-session-thread-id <thread_id>] [--provider-session-id <session_id>] [--provider-session-file <path>] [type-specific flags]";

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--help") {
    console.error(usageText);
    process.exit(0);
  }
  if (token === "--db") {
    args.dbPath = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--workspace-root") {
    args.workspaceRoot = resolve(process.argv[index + 1]);
    args.workspaceRootExplicit = true;
    index += 1;
  } else if (token === "--run-id") {
    args.runId = process.argv[index + 1];
    index += 1;
  } else if (token === "--type") {
    args.type = process.argv[index + 1];
    index += 1;
  } else if (token.startsWith("--")) {
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    args[key] = process.argv[index + 1];
    index += 1;
  }
}

args.dbPath ??= defaultDbPath({ workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });

function findLatestActiveSonolRun(store) {
  return store
    .listRuns()
    .find((run) => ["queued", "prepared", "running", "blocked"].includes(run.status));
}

function resolveMainTaskId(plan) {
  return plan.tasks.find((task) => task.task_id === "task_main_integrate" || task.task_id === "task_single_execute")?.task_id ?? "task_main_integrate";
}

function parseAgentIdList(value) {
  return String(value ?? "")
    .split(/[,\n|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBooleanFlag(value, fallback = true) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isTerminalAgentState(state) {
  return ["completed", "failed", "cancelled"].includes(state);
}

function isAlreadyCompletedAgentError(error, agentId) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Agent ${agentId} is already completed; refusing late completion_event.`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function walkFiles(rootDir, matcher, results = []) {
  let entries = [];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matcher, results);
    } else if (matcher(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function findCodexSessionTranscriptPath(threadId, explicitPath = null) {
  const rootDir = resolve(process.env.SONOL_CODEX_SESSIONS_ROOT ?? resolve(homedir(), ".codex", "sessions"));
  const normalizedRootDir = normalizePath(rootDir);
  if (
    explicitPath
    && existsSync(explicitPath)
    && isSamePathOrDescendant(normalizePath(explicitPath), normalizedRootDir)
    && normalizeFileMatchPath(explicitPath).endsWith(".jsonl")
    && (!threadId || normalizeFileMatchPath(explicitPath).endsWith(`-${threadId}.jsonl`))
  ) {
    return explicitPath;
  }
  if (!threadId) {
    return null;
  }

  const candidates = walkFiles(rootDir, (candidate) => candidate.endsWith(`-${threadId}.jsonl`));
  if (!candidates.length) {
    return null;
  }

  return candidates.sort().at(-1) ?? null;
}

function normalizePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  const resolvedPath = /^[a-z]:[\\/]/i.test(raw) ? raw : resolve(raw);
  return resolvedPath
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizeFileMatchPath(value) {
  return String(value ?? "").replace(/[\\/]+/g, "/");
}

function isSamePathOrDescendant(candidatePath, expectedRoot) {
  if (!candidatePath || !expectedRoot) {
    return false;
  }
  return candidatePath === expectedRoot || candidatePath.startsWith(`${expectedRoot}/`);
}

function isWorkspaceCompatible(workspaceRoot, candidateRoot) {
  if (!workspaceRoot || !candidateRoot) {
    return true;
  }
  return candidateRoot === workspaceRoot || isSamePathOrDescendant(workspaceRoot, candidateRoot);
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function findLatestClaudeSessionTranscriptForWorkspace(workspaceRoot) {
  const normalizedWorkspaceRoot = workspaceRoot ? normalizePath(workspaceRoot) : null;
  if (!normalizedWorkspaceRoot) {
    return null;
  }

  const claudeProjectsRoot = resolve(process.env.SONOL_CLAUDE_PROJECTS_ROOT ?? resolve(homedir(), ".claude", "projects"));
  const candidates = walkFiles(claudeProjectsRoot, (candidate) => (
    normalizeFileMatchPath(candidate).endsWith(".jsonl")
      && !normalizeFileMatchPath(candidate).includes("/subagents/")
  ));

  const compatible = [];
  for (const candidate of candidates) {
    const entries = loadSessionEntries(candidate);
    const header = entries.find((entry) => entry?.sessionId && entry?.cwd);
    if (!header?.cwd || !isWorkspaceCompatible(normalizedWorkspaceRoot, normalizePath(header.cwd))) {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(candidate).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    compatible.push({ path: candidate, mtimeMs });
  }

  compatible.sort((left, right) => (
    right.mtimeMs - left.mtimeMs
      || right.path.localeCompare(left.path)
  ));
  return compatible[0]?.path ?? null;
}

function findClaudeSessionTranscriptPath({ workspaceRoot, sessionId = null, explicitPath = null }) {
  const claudeProjectsRoot = resolve(process.env.SONOL_CLAUDE_PROJECTS_ROOT ?? resolve(homedir(), ".claude", "projects"));
  const normalizedClaudeProjectsRoot = normalizePath(claudeProjectsRoot);
  if (
    explicitPath
    && existsSync(explicitPath)
    && isSamePathOrDescendant(normalizePath(explicitPath), normalizedClaudeProjectsRoot)
    && normalizeFileMatchPath(explicitPath).endsWith(".jsonl")
    && !normalizeFileMatchPath(explicitPath).includes("/subagents/")
    && (!sessionId || normalizeFileMatchPath(explicitPath).endsWith(`/${sessionId}.jsonl`))
  ) {
    return explicitPath;
  }
  if (!sessionId) {
    return findLatestClaudeSessionTranscriptForWorkspace(workspaceRoot);
  }

  const normalizedWorkspaceRoot = workspaceRoot ? normalizePath(workspaceRoot) : null;
  const projectDirs = walkFiles(
    claudeProjectsRoot,
    (candidate) => normalizeFileMatchPath(candidate).endsWith("/sessions-index.json")
  );

  for (const indexPath of projectDirs) {
    const indexData = readJsonFile(indexPath);
    const entries = Array.isArray(indexData?.entries) ? indexData.entries : [];
    for (const entry of entries) {
      if (entry?.sessionId !== sessionId) {
        continue;
      }
      const entryProjectPath = entry?.projectPath ? normalizePath(entry.projectPath) : null;
      if (normalizedWorkspaceRoot && entryProjectPath && !isWorkspaceCompatible(normalizedWorkspaceRoot, entryProjectPath)) {
        continue;
      }
      const fullPath = entry?.fullPath ?? resolve(dirname(indexPath), `${sessionId}.jsonl`);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  const candidates = walkFiles(claudeProjectsRoot, (candidate) => (
    normalizeFileMatchPath(candidate).endsWith(`/${sessionId}.jsonl`)
      && !normalizeFileMatchPath(candidate).includes("/subagents/")
  ));
  if (!normalizedWorkspaceRoot) {
    return candidates.sort().at(-1) ?? null;
  }

  for (const candidate of candidates.sort()) {
    const entries = loadSessionEntries(candidate);
    const header = entries.find((entry) => entry?.sessionId === sessionId && entry?.cwd);
    if (header?.cwd && isWorkspaceCompatible(normalizedWorkspaceRoot, normalizePath(header.cwd))) {
      return candidate;
    }
  }

  return null;
}

function loadSessionEntries(sessionPath) {
  if (!sessionPath || !existsSync(sessionPath)) {
    return [];
  }
  const raw = readFileSync(sessionPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(Boolean);
}

function extractTextSegments(content) {
  if (typeof content === "string") {
    return content.trim() ? [content.trim()] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const segments = [];
  for (const item of content) {
    if (typeof item === "string" && item.trim()) {
      segments.push(item.trim());
      continue;
    }
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
      segments.push(item.text.trim());
      continue;
    }
    if (item?.type === "tool_result" && typeof item.content === "string" && item.content.trim()) {
      segments.push(item.content.trim());
    }
  }
  return segments;
}

function extractMessageText(entry) {
  return extractTextSegments(entry?.message?.content).join("\n");
}

function extractToolResultTexts(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((item) => item?.type === "tool_result" && typeof item.content === "string" && item.content.trim())
    .map((item) => item.content.trim());
}

function extractAgentIdFromPrompt(prompt) {
  const text = String(prompt ?? "");
  const explicitMatch = text.match(/agent_id=([A-Za-z0-9_:-]+)/);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }
  const introMatch = text.match(/You are (agent_[A-Za-z0-9_:-]+)/);
  return introMatch?.[1] ?? null;
}

function extractRunIdFromPrompt(prompt) {
  const text = String(prompt ?? "");
  const explicitMatch = text.match(/run_id=([A-Za-z0-9_:-]+)/);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }
  const introMatch = text.match(/for Sonol multi-agent run ([A-Za-z0-9_:-]+)/);
  return introMatch?.[1] ?? null;
}

function parseSubagentNotificationText(text) {
  const raw = String(text ?? "");
  const match = raw.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/);
  if (!match?.[1]) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function completedStatusText(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  return typeof status.completed === "string" && status.completed.trim().length > 0
    ? status.completed.trim()
    : null;
}

function collectCompletedAgentsFromCodexSession(entries, mainThreadId, expectedRunId = null) {
  const threadToAgentId = new Map();
  const completedAgentIds = new Set();

  for (const entry of entries) {
    const payload = entry?.payload ?? {};
    if (entry?.type !== "event_msg" || payload?.type !== "collab_agent_spawn_end") {
      continue;
    }
    if (mainThreadId && payload.sender_thread_id !== mainThreadId) {
      continue;
    }
    const threadId = payload.new_thread_id ?? null;
    const agentId = extractAgentIdFromPrompt(payload.prompt);
    const runId = extractRunIdFromPrompt(payload.prompt);
    if (expectedRunId && runId !== expectedRunId) {
      continue;
    }
    if (threadId && agentId) {
      threadToAgentId.set(threadId, agentId);
    }
  }

  for (const entry of entries) {
    const payload = entry?.payload ?? {};
    if (entry?.type === "event_msg" && payload?.type === "collab_waiting_end") {
      const statuses = payload.statuses && typeof payload.statuses === "object" ? payload.statuses : {};
      for (const [threadId, status] of Object.entries(statuses)) {
        if (completedStatusText(status) && threadToAgentId.has(threadId)) {
          completedAgentIds.add(threadToAgentId.get(threadId));
        }
      }
      const agentStatuses = Array.isArray(payload.agent_statuses) ? payload.agent_statuses : [];
      for (const statusEntry of agentStatuses) {
        const threadId = statusEntry?.thread_id ?? null;
        if (threadId && completedStatusText(statusEntry?.status) && threadToAgentId.has(threadId)) {
          completedAgentIds.add(threadToAgentId.get(threadId));
        }
      }
      continue;
    }

    if (entry?.type === "response_item" && payload?.type === "message" && payload?.role === "user") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const item of content) {
        const notification = parseSubagentNotificationText(item?.text);
        const threadId = notification?.agent_path ?? null;
        if (threadId && completedStatusText(notification?.status) && threadToAgentId.has(threadId)) {
          completedAgentIds.add(threadToAgentId.get(threadId));
        }
      }
    }
  }

  return Array.from(completedAgentIds);
}

function extractClaudeLaunchMetadata(entries) {
  for (const entry of entries) {
    if (entry?.isSidechain !== true || entry?.type !== "user") {
      continue;
    }
    const promptText = extractMessageText(entry);
    const agentId = extractAgentIdFromPrompt(promptText);
    if (agentId) {
      return {
        agentId,
        runId: extractRunIdFromPrompt(promptText)
      };
    }
  }
  return null;
}

function hasClaudeCompletionSignal(entries, sessionPath) {
  if (!sessionPath || !existsSync(sessionPath)) {
    return false;
  }
  try {
    if (Date.now() - statSync(sessionPath).mtimeMs < 3000) {
      return false;
    }
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (entry?.isSidechain !== true || entry?.type !== "user" || entry?.message?.role !== "user") {
      return false;
    }
    return extractToolResultTexts(entry).some((toolText) => (
      toolText.includes("\"event_id\": \"completion_event_")
      || toolText.includes("\"event_type\": \"completion_event\"")
    ));
  });
}

function collectCompletedAgentsFromClaudeSession(sessionPath, expectedRunId = null) {
  if (!sessionPath || !existsSync(sessionPath)) {
    return [];
  }

  const completedAgentIds = new Set();
  const sessionId = basename(sessionPath, ".jsonl");
  const subagentsDir = resolve(dirname(sessionPath), sessionId, "subagents");
  let subagentEntries = [];
  try {
    subagentEntries = readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of subagentEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const subagentPath = resolve(subagentsDir, entry.name);
    const entries = loadSessionEntries(subagentPath);
    const metadata = extractClaudeLaunchMetadata(entries);
    if (!metadata?.agentId) {
      continue;
    }
    if (expectedRunId && metadata.runId !== expectedRunId) {
      continue;
    }
    if (hasClaudeCompletionSignal(entries, subagentPath)) {
      completedAgentIds.add(metadata.agentId);
    }
  }

  return Array.from(completedAgentIds);
}

function inferProviderSessionKind(run, args) {
  if (args.providerSessionId) {
    return "claude-code";
  }
  if (args.providerSessionFile) {
    const claudeProjectsRoot = normalizePath(resolve(process.env.SONOL_CLAUDE_PROJECTS_ROOT ?? resolve(homedir(), ".claude", "projects")));
    return normalizePath(args.providerSessionFile).startsWith(claudeProjectsRoot)
      ? "claude-code"
      : "codex";
  }

  const hintText = [
    run?.adapter_type,
    run?.adapter_backend,
    run?.provider_refs?.launch_surface,
    run?.provider_refs?.dispatch_mode
  ].filter(Boolean).join(" ").toLowerCase();

  if (hintText.includes("claude")) {
    return "claude-code";
  }
  if (hintText.includes("codex")) {
    return "codex";
  }
  if (args.providerSessionThreadId || process.env.SONOL_MAIN_PROVIDER_SESSION_THREAD_ID || process.env.CODEX_THREAD_ID) {
    return "codex";
  }
  return "unknown";
}

function expectedMainReporterIdentity(run) {
  const refs = run?.provider_refs ?? {};
  return {
    kind: refs.main_provider_session_kind ?? null,
    sessionId: refs.main_provider_session_id ?? null,
    threadId: refs.main_provider_session_thread_id ?? null,
    sessionFile: refs.main_provider_session_file ? normalizePath(refs.main_provider_session_file) : null,
    rawSessionFile: refs.main_provider_session_file ?? null
  };
}

function validateMainReporterIdentity(run, { providerSessionKind, providerSessionId, providerThreadId, providerSessionPath }) {
  const expected = expectedMainReporterIdentity(run);
  const actualPath = providerSessionPath ? normalizePath(providerSessionPath) : null;
  const missingCodexIdentity = expected.kind === "codex" && !expected.threadId;
  const missingClaudeIdentity = expected.kind === "claude-code" && !expected.sessionId && !expected.sessionFile;
  const matchedClaudeTranscript = expected.kind === "claude-code"
    && Boolean(expected.sessionFile)
    && Boolean(actualPath)
    && expected.sessionFile === actualPath;
  const effectiveProviderSessionId = expected.kind === "claude-code"
    ? (providerSessionId ?? (matchedClaudeTranscript ? expected.sessionId : null))
    : providerSessionId;

  if (!expected.kind || missingCodexIdentity || missingClaudeIdentity) {
    throw new Error(`Run ${run.run_id} is missing main session identity. Re-confirm or retry the run before using report-main.`);
  }

  if (providerSessionKind !== expected.kind) {
    throw new Error(`report-main caller kind mismatch for run ${run.run_id}: expected ${expected.kind}, received ${providerSessionKind}.`);
  }

  if (expected.kind === "codex" && providerThreadId !== expected.threadId) {
    throw new Error(`report-main caller thread mismatch for run ${run.run_id}: expected ${expected.threadId}, received ${providerThreadId ?? "missing"}.`);
  }

  if (expected.sessionFile && actualPath && expected.sessionFile !== actualPath) {
    throw new Error(`report-main caller transcript mismatch for run ${run.run_id}: expected ${expected.rawSessionFile}, received ${providerSessionPath}.`);
  }

  if (expected.kind === "claude-code" && expected.sessionId && effectiveProviderSessionId !== expected.sessionId) {
    throw new Error(`report-main caller session mismatch for run ${run.run_id}: expected ${expected.sessionId}, received ${providerSessionId ?? "missing"}.`);
  }
}

function getCurrentAgentState(store, runId, agentId, fallbackUpdatedAt = null) {
  const rows = store.listEvents(runId)
    .filter((event) => (event?.payload?.agent_id ?? event?.agent_id ?? null) === agentId);
  let current = {
    agent_id: agentId,
    state: "queued",
    message: "",
    task_id: null,
    updated_at: fallbackUpdatedAt,
    last_event_type: "run_snapshot"
  };

  for (const event of rows) {
    const payload = event.payload ?? {};
    current = {
      ...current,
      updated_at: payload.timestamp ?? current.updated_at,
      last_event_type: event.event_type
    };

    if (event.event_type === "progress_event") {
      current.state = payload.state ?? current.state;
      current.message = payload.message ?? current.message;
      current.task_id = payload.task_id ?? current.task_id;
    } else if (event.event_type === "session_updated") {
      current.state = payload.status ?? current.state;
      current.message = payload.message ?? current.message;
      current.task_id = payload.task_id ?? current.task_id;
    } else if (event.event_type === "completion_event") {
      current.state = payload.result === "failure" ? "failed" : "completed";
      current.message = payload.summary ?? current.message;
      current.task_id = payload.task_id ?? current.task_id;
    } else if (event.event_type === "artifact_event") {
      current.message = payload.summary ?? current.message;
    }
  }

  return current;
}

function buildReconciledCompletionPayload({ plan, run, agentId, taskId, summary, detail, nextActions }) {
  return {
    event_id: createEventId("completion", run.run_id, agentId, "success", summary ?? "", detail ?? "", "reconciled-by-main"),
    plan_id: plan.plan_id,
    run_id: run.run_id,
    agent_id: agentId,
    task_id: taskId,
    result: "success",
    summary: compactText(summary, 140),
    detail: compactText(detail, 220),
    blockers: [],
    next_actions: nextActions.map((item) => compactText(item, 80)).filter(Boolean),
    timestamp: nowIso(),
    schema_version: "1.0.0"
  };
}

function requiredFlagsFor(type) {
  switch (type) {
    case "progress":
      return ["message"];
    case "artifact":
      return ["artifactType", "artifactRef", "summary"];
    case "completion":
      return ["result", "summary"];
    case "session":
      return ["status", "message"];
    default:
      throw new Error(`Unsupported type: ${type}`);
  }
}

try {
  const run = runWithRetry("report-main-resolve-run", () => {
    const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
    try {
      return args.runId ? store.getRun(args.runId) : findLatestActiveSonolRun(store);
    } finally {
      store.close();
    }
  });
  if (!run) {
    throw new Error("No active sonol run found. If terminal confirmation just prepared a manifest-only run, pass --run-id explicitly or use the generated run-scoped prompt/command files.");
  }

  const plan = runWithRetry("report-main-resolve-plan", () => {
    const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
    try {
      return store.getPlanForRun(run);
    } finally {
      store.close();
    }
  });
  if (!plan) {
    throw new Error(`Plan not found for run: ${run.plan_id}`);
  }

  if (!plan.agents.some((agent) => agent.agent_id === "agent_main")) {
    throw new Error("This run does not define agent_main.");
  }

  for (const key of requiredFlagsFor(args.type)) {
    if (!args[key]) {
      throw new Error(`Missing required flag for ${args.type}: --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    }
  }

  const taskId = resolveMainTaskId(plan);
  const agentId = "agent_main";
  const explicitReconciledAgentIds = parseAgentIdList(args.reconcileCompletedAgentIds);
  const shouldAutoReconcile = args.type === "completion" && parseBooleanFlag(args.autoReconcileCompletedAgents, true);
  const providerSessionKind = inferProviderSessionKind(run, args);
  const expectedIdentity = expectedMainReporterIdentity(run);
  const effectiveWorkspaceRoot = args.workspaceRootExplicit
    ? args.workspaceRoot
    : (run.workspace_root ?? plan.workspace_root ?? args.workspaceRoot ?? process.cwd());
  const providerThreadId = providerSessionKind === "codex"
    ? (args.providerSessionThreadId ?? process.env.SONOL_MAIN_PROVIDER_SESSION_THREAD_ID ?? process.env.CODEX_THREAD_ID ?? null)
    : null;
  const providerSessionPath = providerSessionKind === "codex"
    ? findCodexSessionTranscriptPath(providerThreadId, args.providerSessionFile ?? null)
    : providerSessionKind === "claude-code"
      ? findClaudeSessionTranscriptPath({
          workspaceRoot: effectiveWorkspaceRoot,
          sessionId: args.providerSessionId ?? expectedIdentity.sessionId ?? null,
          explicitPath: args.providerSessionFile ?? expectedIdentity.rawSessionFile ?? null
        })
      : null;
  const providerSessionId = providerSessionKind === "claude-code"
    ? (args.providerSessionId ?? (providerSessionPath ? basename(providerSessionPath, ".jsonl") : expectedIdentity.sessionId ?? null))
    : null;
  validateMainReporterIdentity(run, {
    providerSessionKind,
    providerSessionId,
    providerThreadId,
    providerSessionPath
  });
  const baseAutoReconcileWarning = shouldAutoReconcile && providerSessionKind === "claude-code" && !providerSessionPath
    ? "Claude auto reconcile requires --provider-session-file or --provider-session-id. Only Claude Code subagents are supported; agent teams are excluded."
    : null;
  const autoReconciledAgentIds = !shouldAutoReconcile || !providerSessionPath
    ? []
    : providerSessionKind === "codex"
      ? collectCompletedAgentsFromCodexSession(loadSessionEntries(providerSessionPath), providerThreadId, run.run_id)
      : providerSessionKind === "claude-code"
        ? collectCompletedAgentsFromClaudeSession(providerSessionPath, run.run_id)
        : [];
  const requestedReconciledAgentIds = Array.from(new Set([
    ...explicitReconciledAgentIds,
    ...autoReconciledAgentIds
  ]));
  const plannedAgentIds = new Set(plan.agents.map((agent) => agent.agent_id));
  const ignoredReconciledAgentIds = requestedReconciledAgentIds.filter((candidateAgentId) => (
    candidateAgentId !== agentId && !plannedAgentIds.has(candidateAgentId)
  ));
  const reconciledAgentIds = requestedReconciledAgentIds.filter((candidateAgentId) => (
    candidateAgentId === agentId || plannedAgentIds.has(candidateAgentId)
  ));
  const autoReconcileWarning = [
    baseAutoReconcileWarning,
    ignoredReconciledAgentIds.length > 0
      ? `Ignored reconcile ids not present in the current plan: ${ignoredReconciledAgentIds.join(", ")}.`
      : null
  ].filter(Boolean).join(" ") || null;
  let eventType = "progress_event";
  let payload;

  if (args.type === "progress") {
    payload = {
      event_id: createEventId("progress", run.run_id, agentId, args.message ?? "", args.detail ?? "", String(args.stepIndex ?? 1), String(args.totalSteps ?? 3), args.state ?? "running"),
      plan_id: plan.plan_id,
      run_id: run.run_id,
      agent_id: agentId,
      task_id: taskId,
      step_index: Number(args.stepIndex ?? 1),
      total_steps: Number(args.totalSteps ?? 3),
      state: args.state ?? "running",
      message: compactText(args.message, 96),
      detail: compactText(args.detail, 220),
      timestamp: nowIso(),
      schema_version: "1.0.0"
    };
  } else if (args.type === "artifact") {
    eventType = "artifact_event";
    payload = {
      event_id: createEventId("artifact", run.run_id, agentId, args.artifactType ?? "", args.artifactRef ?? "", args.summary ?? "", args.detail ?? "", args.validationStatus ?? "unchecked"),
      plan_id: plan.plan_id,
      run_id: run.run_id,
      agent_id: agentId,
      task_id: args.taskId ?? taskId,
      artifact_type: args.artifactType,
      artifact_ref: args.artifactRef,
      summary: compactText(args.summary, 140),
      detail: compactText(args.detail, 220),
      validation_status: args.validationStatus ?? "unchecked",
      timestamp: nowIso(),
      schema_version: "1.0.0"
    };
  } else if (args.type === "completion") {
    eventType = "completion_event";
    payload = {
      event_id: createEventId("completion", run.run_id, agentId, args.result ?? "", args.summary ?? "", args.detail ?? "", args.blockers ?? "", args.nextActions ?? ""),
      plan_id: plan.plan_id,
      run_id: run.run_id,
      agent_id: agentId,
      task_id: args.taskId ?? taskId,
      result: args.result,
      summary: compactText(args.summary, 140),
      detail: compactText(args.detail, 220),
      blockers: compactList(args.blockers, 80),
      next_actions: compactList(args.nextActions, 80),
      timestamp: nowIso(),
      schema_version: "1.0.0"
    };
  } else {
    eventType = "session_updated";
    payload = {
      event_id: createEventId("session", run.run_id, agentId, args.status ?? "", args.message ?? "", args.detail ?? "", args.blockedReason ?? ""),
      plan_id: plan.plan_id,
      run_id: run.run_id,
      agent_id: agentId,
      task_id: taskId,
      status: args.status,
      message: compactText(args.message, 96),
      detail: compactText(args.detail, 220),
      blocked_reason: compactText(args.blockedReason, 96),
      timestamp: nowIso(),
      schema_version: "1.0.0"
    };
  }

  appendStructuredLog("sonol-runtime", {
    action: "report_script",
    stage: "attempt",
    script: "report-main",
    run_id: run.run_id,
    agent_id: agentId,
    event_type: eventType,
    event_id: payload.event_id,
    provider_session_kind: providerSessionKind,
    provider_session_thread_id: providerThreadId,
    provider_session_id: providerSessionId,
    provider_session_file: providerSessionPath,
    auto_reconcile_warning: autoReconcileWarning,
    auto_reconciled_agent_ids: autoReconciledAgentIds
  });
  runWithRetry("report-main-write", () => {
    const store = openStore(args.dbPath, { workspaceRoot: args.workspaceRoot, startDir: args.workspaceRoot });
    try {
      const storeAppendOptions = {
        source_script: "report-main",
        reporter_session_kind: providerSessionKind,
        reporter_session_id: providerSessionId,
        reporter_session_thread_id: providerThreadId,
        reporter_session_file: providerSessionPath
      };
      if (args.type === "completion" && reconciledAgentIds.length > 0) {
        const reconciledSummary = compactText(
          args.reconcileSummary ?? "자동 종료 보정 완료",
          140
        );
        const reconciledDetail = compactText(
          args.reconcileDetail ?? "Main agent recorded completion after provider completion was confirmed.",
          220
        );
        const reconciledNextActions = parseAgentIdList(
          args.reconcileNextActions ?? "handoff|reconciled-by-main"
        );

        for (const reconciledAgentId of reconciledAgentIds) {
          if (reconciledAgentId === agentId) {
            continue;
          }
          const plannedAgent = plan.agents.find((agent) => agent.agent_id === reconciledAgentId);
          if (!plannedAgent) {
            throw new Error(`Cannot reconcile unknown agent: ${reconciledAgentId}`);
          }
          const plannedTaskId = plannedAgent.current_task_id ?? plannedAgent.assigned_task_ids?.[0] ?? null;
          if (!plannedTaskId) {
            throw new Error(`Cannot reconcile ${reconciledAgentId} because no task_id is assigned.`);
          }

          const currentAgentState = getCurrentAgentState(store, run.run_id, reconciledAgentId, run.updated_at ?? null);
          if (isTerminalAgentState(currentAgentState.state)) {
            continue;
          }

          const reconciledPayload = buildReconciledCompletionPayload({
            plan,
            run,
            agentId: reconciledAgentId,
            taskId: plannedTaskId,
            summary: reconciledSummary,
            detail: reconciledDetail,
            nextActions: reconciledNextActions
          });
          try {
            store.appendEvent("completion_event", reconciledPayload, storeAppendOptions);
          } catch (error) {
            if (isAlreadyCompletedAgentError(error, reconciledAgentId)) {
              continue;
            }
            throw error;
          }
        }
      }
      store.appendEvent(eventType, payload, storeAppendOptions);
    } finally {
      store.close();
    }
  });
  appendStructuredLog("sonol-runtime", {
    action: "report_script",
    stage: "success",
    script: "report-main",
    run_id: run.run_id,
    agent_id: agentId,
    event_type: eventType,
    event_id: payload.event_id
  });
  process.stdout.write(`${JSON.stringify({
    run_id: run.run_id,
    plan_id: plan.plan_id,
    event_type: eventType,
    provider_session_kind: providerSessionKind,
    provider_session_thread_id: providerThreadId,
    provider_session_id: providerSessionId,
    provider_session_file: providerSessionPath,
    auto_reconcile_warning: autoReconcileWarning,
    auto_reconciled_agent_ids: autoReconciledAgentIds,
    reconciled_agent_ids: reconciledAgentIds,
    payload
  }, null, 2)}\n`);
} catch (error) {
  console.error(usageText);
  appendStructuredLog("sonol-runtime", {
    action: "report_script",
    stage: "failure",
    script: "report-main",
    run_id: args.runId ?? null,
    agent_id: "agent_main",
    error: error instanceof Error ? error.message : String(error)
  });
  throw error;
}
