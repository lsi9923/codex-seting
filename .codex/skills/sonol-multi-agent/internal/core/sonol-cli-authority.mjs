import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { readWorkspaceAuthorityRecord } from "./sonol-authority-artifacts.mjs";
import { resolveSonolBinding } from "./sonol-binding-resolver.mjs";
import { dashboardUrlForWorkspace } from "./sonol-runtime-paths.mjs";

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function workspaceMatchesHealth(binding, workspaceRoot, health) {
  const healthWorkspaceId = normalizeText(health?.workspace_id);
  const bindingWorkspaceId = normalizeText(binding?.workspace_id);
  if (healthWorkspaceId && bindingWorkspaceId) {
    return healthWorkspaceId === bindingWorkspaceId;
  }
  return String(health?.workspace_root ?? "") === String(binding?.workspace_root ?? workspaceRoot ?? "");
}

function readJson(url, timeoutMs = 1500) {
  return new Promise((resolveJson) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolveJson(null);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, { method: "GET", timeout: timeoutMs }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        try {
          resolveJson(JSON.parse(raw));
        } catch {
          resolveJson(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolveJson(null);
    });
    request.on("error", () => resolveJson(null));
    request.end();
  });
}

export function formatAuthorityMismatchMessage(result) {
  if (!result?.authority_mismatch) {
    return "";
  }
  return [
    "The requested DB path does not match the dashboard authoritative DB.",
    `Requested DB: ${result.authority_mismatch.requested_db_path}`,
    `Authoritative DB: ${result.authority_mismatch.authoritative_db_path}`,
    "Omit --db to follow dashboard health automatically, or pass --allow-db-mismatch to force the explicit path."
  ].join("\n");
}

export async function resolveCliAuthoritativeBinding(options = {}) {
  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : null;
  const dbPath = options.dbPath ? resolve(options.dbPath) : null;
  const authorityRecord = !dbPath ? readWorkspaceAuthorityRecord({ workspaceRoot }) : null;
  const authorityDbPath = normalizeText(authorityRecord?.authoritative_db_path) || null;
  const runtimeRoot = options.runtimeRoot
    ? resolve(options.runtimeRoot)
    : normalizeText(authorityRecord?.runtime_root) || null;
  const startDir = resolve(options.startDir ?? process.cwd());

  let binding = resolveSonolBinding({
    workspaceRoot,
    dbPath: dbPath ?? authorityDbPath,
    runtimeRoot,
    startDir
  });

  const dashboardUrl = normalizeText(options.dashboardUrl)
    || normalizeText(authorityRecord?.dashboard_url)
    || dashboardUrlForWorkspace({
      workspaceRoot: binding.workspace_root ?? workspaceRoot ?? startDir,
      startDir: binding.workspace_root ?? workspaceRoot ?? startDir,
      dashboardUrl: options.dashboardUrl,
      preferEnv: false
    });

  const result = {
    binding,
    dashboard_url: dashboardUrl,
    health: null,
    rebound_to_authoritative_db: false,
    authority_mismatch: null,
    warnings: authorityRecord ? [`Using workspace authority record: ${workspaceRoot}`] : []
  };

  const health = await readJson(new URL("/api/health", dashboardUrl).toString(), options.timeoutMs ?? 1500);
  if (!health?.ok) {
    return result;
  }

  result.health = health;
  if (!workspaceMatchesHealth(binding, workspaceRoot, health)) {
    result.warnings.push("Dashboard health resolved a different workspace identity than the local binding.");
    return result;
  }

  const authoritativeDbPath = normalizeText(health.authoritative_db_path);
  if (!authoritativeDbPath) {
    return result;
  }

  if (dbPath) {
    if (resolve(authoritativeDbPath) !== binding.db_path) {
      result.authority_mismatch = {
        requested_db_path: binding.db_path,
        authoritative_db_path: resolve(authoritativeDbPath)
      };
    }
    return result;
  }

  if (resolve(authoritativeDbPath) !== binding.db_path) {
    binding = resolveSonolBinding({
      workspaceRoot,
      dbPath: authoritativeDbPath,
      runtimeRoot,
      startDir
    });
    result.binding = binding;
    result.rebound_to_authoritative_db = true;
    result.warnings.push(`Rebound to dashboard authoritative DB: ${binding.db_path}`);
  }

  return result;
}
