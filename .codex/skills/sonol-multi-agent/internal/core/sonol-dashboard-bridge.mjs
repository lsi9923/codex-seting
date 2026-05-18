import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getWorkspaceContext } from "./sonol-runtime-paths.mjs";
import { resolveSonolBinding } from "./sonol-binding-resolver.mjs";
import { deriveRemoteDashboardBaseUrlFromPlannerUrl } from "./sonol-public-remote-config.mjs";

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeBaseUrl(rawUrl) {
  const text = normalizeText(rawUrl);
  if (!text) {
    return "";
  }
  const parsed = new URL(text);
  return parsed.toString();
}

function deriveDashboardBaseUrlFromPlannerEnv(env) {
  const plannerUrl = normalizeText(
    env.SONOL_REMOTE_PLAN_NORMALIZER_URL
    ?? env.SONOL_REMOTE_PLANNER_URL
    ?? env.SONOL_REMOTE_CONTROL_PLANE_URL
    ?? ""
  );
  return deriveRemoteDashboardBaseUrlFromPlannerUrl(plannerUrl);
}

function persistedRemoteDashboardBaseUrl(options = {}) {
  const record = readDashboardBridgeTokenRecord(options);
  return normalizeBaseUrl(record?.remote_dashboard_base_url ?? "");
}

function resolveBridgeIdentity(options = {}) {
  const binding = resolveSonolBinding({
    workspaceRoot: options.workspaceRoot ?? process.env.SONOL_WORKSPACE_ROOT ?? process.cwd(),
    dbPath: options.dbPath ?? process.env.SONOL_DB_PATH ?? null,
    runtimeRoot: options.runtimeRoot ?? process.env.SONOL_RUNTIME_ROOT ?? null,
    startDir: options.workspaceRoot ?? process.cwd()
  });
  return {
    workspace_id: binding.workspace_id,
    binding_id: binding.binding_id
  };
}

function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function remoteDashboardBaseUrl(options = {}) {
  const env = options.env ?? process.env;
  const explicitBaseUrl = normalizeBaseUrl(
    options.remoteDashboardBaseUrl
    ?? env.SONOL_REMOTE_DASHBOARD_BASE_URL
    ?? ""
  );
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }
  const plannerBaseUrl = deriveDashboardBaseUrlFromPlannerEnv(env);
  if (plannerBaseUrl) {
    return plannerBaseUrl;
  }
  return persistedRemoteDashboardBaseUrl(options);
}

export function remoteDashboardOrigin(options = {}) {
  const baseUrl = remoteDashboardBaseUrl(options);
  return baseUrl ? new URL(baseUrl).origin : "";
}

export function dashboardBridgeTokenPath(options = {}) {
  const runtimeRoot = resolve(options.runtimeRoot ?? process.env.SONOL_RUNTIME_ROOT ?? process.cwd());
  mkdirSync(resolve(runtimeRoot, "dashboard"), { recursive: true });
  return resolve(runtimeRoot, "dashboard", "bridge-token.json");
}

export function dashboardBridgeTokenTtlMs(options = {}) {
  const env = options.env ?? process.env;
  return resolvePositiveInteger(
    options.bridgeTokenTtlMs
    ?? env.SONOL_DASHBOARD_BRIDGE_TOKEN_TTL_MS,
    30 * 60 * 1000
  );
}

function createBridgeTokenRecord(options = {}) {
  const workspace = getWorkspaceContext({
    workspaceRoot: options.workspaceRoot ?? process.env.SONOL_WORKSPACE_ROOT ?? process.cwd()
  });
  const identity = resolveBridgeIdentity(options);
  return {
    token: randomBytes(24).toString("base64url"),
    workspace_id: workspace.workspace_id,
    binding_id: identity.binding_id,
    dashboard_url: normalizeText(options.dashboardUrl ?? options.bridgeUrl ?? ""),
    remote_dashboard_base_url: remoteDashboardBaseUrl(options),
    created_at: new Date().toISOString()
  };
}

export function readDashboardBridgeTokenRecord(options = {}) {
  const tokenPath = dashboardBridgeTokenPath(options);
  try {
    return JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    return null;
  }
}

function recordWorkspaceId(options = {}) {
  return getWorkspaceContext({
    workspaceRoot: options.workspaceRoot ?? process.env.SONOL_WORKSPACE_ROOT ?? process.cwd()
  }).workspace_id;
}

function bridgeTokenRecordIsUsable(record, options = {}) {
  if (!record?.token) {
    return false;
  }
  if (record.workspace_id && record.workspace_id !== recordWorkspaceId(options)) {
    return false;
  }
  const createdAtMs = Date.parse(record.created_at ?? "");
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return (Date.now() - createdAtMs) <= dashboardBridgeTokenTtlMs(options);
}

export function issueDashboardBridgeToken(options = {}) {
  const tokenPath = dashboardBridgeTokenPath(options);
  const record = createBridgeTokenRecord(options);
  writeFileSync(tokenPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record.token;
}

export function ensureDashboardBridgeToken(options = {}) {
  const existing = readDashboardBridgeTokenRecord(options);
  if (!options.rotate && bridgeTokenRecordIsUsable(existing, options)) {
    return existing.token;
  }
  return issueDashboardBridgeToken(options);
}

export function operatorDashboardUrlForWorkspace(options = {}) {
  const baseUrl = remoteDashboardBaseUrl(options);
  if (!baseUrl) {
    return "";
  }
  const url = new URL(baseUrl);
  const bridgeUrl = normalizeText(options.bridgeUrl);
  const bridgeToken = normalizeText(options.bridgeToken);
  const identity = resolveBridgeIdentity(options);
  const workspaceId = normalizeText(options.workspaceId ?? options.workspace_id ?? identity.workspace_id);
  const bindingId = normalizeText(options.bindingId ?? options.binding_id ?? identity.binding_id);
  const fragment = new URLSearchParams();
  if (bridgeUrl) {
    fragment.set("bridge", bridgeUrl);
  }
  if (bridgeToken) {
    fragment.set("bridge_token", bridgeToken);
  }
  if (workspaceId) {
    fragment.set("workspace_id", workspaceId);
  }
  if (bindingId) {
    fragment.set("binding_id", bindingId);
  }
  if (fragment.size > 0) {
    url.hash = fragment.toString();
  }
  return url.toString();
}
