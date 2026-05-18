import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { CLAUDE_ADAPTER_BACKEND, CLAUDE_ADAPTER_TYPE } from "./sonol-claude-code-adapter.mjs";
import { CODEX_ADAPTER_BACKEND, CODEX_ADAPTER_TYPE } from "./sonol-codex-adapter.mjs";

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

function normalizeComparablePath(value) {
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

function isClaudeSessionIndexPath(candidate) {
  return normalizeFileMatchPath(candidate).endsWith("/sessions-index.json");
}

function isClaudeSessionTranscriptPath(candidate) {
  const normalized = normalizeFileMatchPath(candidate);
  return normalized.endsWith(".jsonl") && !normalized.includes("/subagents/");
}

function isSamePathOrDescendant(candidatePath, expectedRoot) {
  if (!candidatePath || !expectedRoot) {
    return false;
  }
  return candidatePath === expectedRoot || candidatePath.startsWith(`${expectedRoot}/`);
}

function matchWorkspaceAffinity({ workspaceRoot, candidateRoot }) {
  if (!workspaceRoot || !candidateRoot) {
    return 1;
  }
  if (candidateRoot === workspaceRoot) {
    return 3;
  }
  if (isSamePathOrDescendant(workspaceRoot, candidateRoot)) {
    return 2;
  }
  return 0;
}

function getFileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

function readClaudeTranscriptHeader(sessionPath) {
  if (!sessionPath || !existsSync(sessionPath)) {
    return null;
  }

  try {
    const raw = readFileSync(sessionPath, "utf8");
    const lines = raw.split("\n");
    let sessionId = null;
    let cwd = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry = null;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!sessionId && typeof entry?.sessionId === "string" && entry.sessionId.trim()) {
        sessionId = entry.sessionId.trim();
      }
      if (!cwd && typeof entry?.cwd === "string" && entry.cwd.trim()) {
        cwd = entry.cwd.trim();
      }
      if (sessionId && cwd) {
        break;
      }
    }
    if (!sessionId && !cwd) {
      return null;
    }
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

function selectBestCandidatePath(candidates) {
  return candidates
    .slice()
    .sort((left, right) => (
      (right.affinity ?? 0) - (left.affinity ?? 0)
      || (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0)
      || String(right.path ?? "").localeCompare(String(left.path ?? ""))
    ))
    .at(0)?.path ?? null;
}

function extractClaudeSessionIdFromTranscriptPath(sessionPath) {
  if (!sessionPath) {
    return null;
  }
  const filename = basename(sessionPath);
  return filename.endsWith(".jsonl") ? filename.slice(0, -6) : null;
}

export function hasExplicitAdapterConfigEnv() {
  return Boolean(process.env.SONOL_DEFAULT_ADAPTER_TYPE || process.env.SONOL_DEFAULT_ADAPTER_BACKEND);
}

export function findCodexSessionTranscriptPath(threadId) {
  if (!threadId) {
    return null;
  }
  const codexSessionsRoot = resolve(process.env.SONOL_CODEX_SESSIONS_ROOT ?? resolve(homedir(), ".codex", "sessions"));
  const candidates = walkFiles(codexSessionsRoot, (candidate) => candidate.endsWith(`-${threadId}.jsonl`));
  return candidates.length ? candidates.sort().at(-1) ?? null : null;
}

export function findLatestClaudeSessionTranscriptPath({ workspaceRoot, sessionId = null, explicitPath = null }) {
  if (explicitPath && existsSync(explicitPath)) {
    return resolve(explicitPath);
  }

  const claudeProjectsRoot = resolve(process.env.SONOL_CLAUDE_PROJECTS_ROOT ?? resolve(homedir(), ".claude", "projects"));
  const normalizedWorkspaceRoot = workspaceRoot ? normalizeComparablePath(workspaceRoot) : null;
  const transcriptFiles = walkFiles(claudeProjectsRoot, isClaudeSessionTranscriptPath);
  const transcriptCandidates = [];

  for (const transcriptPath of transcriptFiles) {
    const resolvedTranscriptPath = resolve(transcriptPath);
    const inferredSessionId = extractClaudeSessionIdFromTranscriptPath(resolvedTranscriptPath);
    if (sessionId && inferredSessionId && inferredSessionId !== sessionId) {
      continue;
    }

    const header = readClaudeTranscriptHeader(resolvedTranscriptPath);
    const transcriptSessionId = header?.sessionId ?? inferredSessionId ?? null;
    if (sessionId && transcriptSessionId && transcriptSessionId !== sessionId) {
      continue;
    }

    const transcriptWorkspace = header?.cwd ? normalizeComparablePath(header.cwd) : null;
    const affinity = matchWorkspaceAffinity({
      workspaceRoot: normalizedWorkspaceRoot,
      candidateRoot: transcriptWorkspace
    });
    if (normalizedWorkspaceRoot && affinity === 0) {
      continue;
    }

    transcriptCandidates.push({
      path: resolvedTranscriptPath,
      affinity: transcriptWorkspace ? affinity + 1 : affinity,
      mtimeMs: getFileMtimeMs(resolvedTranscriptPath)
    });
  }

  const bestTranscriptPath = selectBestCandidatePath(transcriptCandidates);
  if (bestTranscriptPath) {
    return bestTranscriptPath;
  }

  const sessionIndexFiles = walkFiles(claudeProjectsRoot, isClaudeSessionIndexPath);
  const indexCandidates = [];

  for (const indexPath of sessionIndexFiles) {
    const indexData = readJsonFile(indexPath);
    const entries = Array.isArray(indexData?.entries) ? indexData.entries : [];
    for (const entry of entries) {
      if (sessionId && entry?.sessionId !== sessionId) {
        continue;
      }
      const entryProjectPath = entry?.projectPath ? normalizeComparablePath(entry.projectPath) : null;
      const affinity = matchWorkspaceAffinity({
        workspaceRoot: normalizedWorkspaceRoot,
        candidateRoot: entryProjectPath
      });
      if (normalizedWorkspaceRoot && entryProjectPath && affinity === 0) {
        continue;
      }
      const fullPath = entry?.fullPath ?? resolve(dirname(indexPath), `${entry?.sessionId ?? ""}.jsonl`);
      if (existsSync(fullPath)) {
        const resolvedFullPath = resolve(fullPath);
        indexCandidates.push({
          path: resolvedFullPath,
          affinity,
          mtimeMs: Number(entry?.fileMtime ?? 0) || getFileMtimeMs(resolvedFullPath)
        });
      }
    }
  }

  return selectBestCandidatePath(indexCandidates);
}

export function inferAdapterConfigForWorkspace({ workspaceRoot = null } = {}) {
  const codexThreadId = process.env.SONOL_MAIN_PROVIDER_SESSION_THREAD_ID ?? process.env.CODEX_THREAD_ID ?? null;
  if (codexThreadId) {
    return {
      adapter_type: CODEX_ADAPTER_TYPE,
      adapter_backend: CODEX_ADAPTER_BACKEND,
      inference_source: "codex-thread-env"
    };
  }

  const explicitSessionId = process.env.SONOL_MAIN_PROVIDER_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
  const explicitSessionFile = process.env.SONOL_MAIN_PROVIDER_SESSION_FILE ?? null;
  const transcriptPath = findLatestClaudeSessionTranscriptPath({
    workspaceRoot,
    sessionId: explicitSessionId,
    explicitPath: explicitSessionFile
  });
  if (explicitSessionId || explicitSessionFile || transcriptPath) {
    return {
      adapter_type: CLAUDE_ADAPTER_TYPE,
      adapter_backend: CLAUDE_ADAPTER_BACKEND,
      inference_source: transcriptPath ? "claude-transcript" : "claude-session-env"
    };
  }

  return null;
}

export function resolveAutoAdapterConfig({
  workspaceRoot = null,
  adapterType = CODEX_ADAPTER_TYPE,
  adapterBackend = CODEX_ADAPTER_BACKEND,
  adapterExplicit = false
} = {}) {
  const requested = {
    adapter_type: adapterType ?? CODEX_ADAPTER_TYPE,
    adapter_backend: adapterBackend ?? CODEX_ADAPTER_BACKEND
  };

  if (adapterExplicit) {
    return {
      ...requested,
      auto_switched: false,
      inferred_from: null
    };
  }

  const inferred = inferAdapterConfigForWorkspace({ workspaceRoot });
  if (!inferred) {
    return {
      ...requested,
      auto_switched: false,
      inferred_from: null
    };
  }

  const requestedKey = `${requested.adapter_type}:${requested.adapter_backend}`;
  const inferredKey = `${inferred.adapter_type}:${inferred.adapter_backend}`;
  if (requestedKey === inferredKey) {
    return {
      ...requested,
      auto_switched: false,
      inferred_from: inferred.inference_source
    };
  }

  const implicitCodexKey = `${CODEX_ADAPTER_TYPE}:${CODEX_ADAPTER_BACKEND}`;
  const implicitClaudeKey = `${CLAUDE_ADAPTER_TYPE}:${CLAUDE_ADAPTER_BACKEND}`;
  if (requestedKey === implicitCodexKey && inferredKey === implicitClaudeKey) {
    return {
      adapter_type: inferred.adapter_type,
      adapter_backend: inferred.adapter_backend,
      auto_switched: true,
      inferred_from: inferred.inference_source
    };
  }

  return {
    ...requested,
    auto_switched: false,
    inferred_from: inferred.inference_source
  };
}

export function resolveCodexMainProviderSessionIdentity({ workspaceRoot = null } = {}) {
  const threadId = process.env.SONOL_MAIN_PROVIDER_SESSION_THREAD_ID ?? process.env.CODEX_THREAD_ID ?? null;
  if (!threadId) {
    const inferred = inferAdapterConfigForWorkspace({ workspaceRoot });
    if (inferred?.adapter_type === CLAUDE_ADAPTER_TYPE) {
      throw new Error(
        "Cannot determine Codex main session identity. CODEX_THREAD_ID is missing in the current terminal session. This workspace currently looks like Claude Code. Re-run with --adapter-type claude-code-subagent --adapter-backend claude-code-manual or set SONOL_DEFAULT_ADAPTER_TYPE/SONOL_DEFAULT_ADAPTER_BACKEND."
      );
    }
    throw new Error("Cannot determine Codex main session identity. CODEX_THREAD_ID is missing in the current terminal session.");
  }
  const transcriptPath = findCodexSessionTranscriptPath(threadId);
  return {
    main_provider_session_kind: "codex",
    main_provider_session_id: null,
    main_provider_session_thread_id: threadId,
    main_provider_session_file: transcriptPath && existsSync(transcriptPath) ? transcriptPath : null
  };
}

export function resolveClaudeMainProviderSessionIdentity(workspaceRoot) {
  const explicitSessionId = process.env.SONOL_MAIN_PROVIDER_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
  const explicitSessionFile = process.env.SONOL_MAIN_PROVIDER_SESSION_FILE ?? null;
  const transcriptPath = findLatestClaudeSessionTranscriptPath({
    workspaceRoot,
    sessionId: explicitSessionId,
    explicitPath: explicitSessionFile
  });
  const sessionId = explicitSessionId ?? extractClaudeSessionIdFromTranscriptPath(transcriptPath);
  if (!sessionId && !transcriptPath) {
    throw new Error(
      "Cannot determine Claude main session identity. Set SONOL_MAIN_PROVIDER_SESSION_ID or SONOL_MAIN_PROVIDER_SESSION_FILE before launching the run."
    );
  }
  return {
    main_provider_session_kind: "claude-code",
    main_provider_session_id: sessionId ?? null,
    main_provider_session_thread_id: null,
    main_provider_session_file: transcriptPath && existsSync(transcriptPath) ? transcriptPath : null
  };
}

export function resolveMainProviderSessionIdentity({ workspaceRoot, adapterType, adapterBackend }) {
  const adapterHint = [adapterType, adapterBackend].filter(Boolean).join(" ").toLowerCase();
  return adapterHint.includes("claude")
    ? resolveClaudeMainProviderSessionIdentity(workspaceRoot)
    : resolveCodexMainProviderSessionIdentity({ workspaceRoot });
}
