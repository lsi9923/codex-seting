import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { getWorkspaceContext } from "./sonol-runtime-paths.mjs";
import { inferAdapterConfigForWorkspace } from "./sonol-provider-session.mjs";
import {
  DEFAULT_PUBLIC_REMOTE_PLANNER_URL,
  deriveRemotePlannerTicketUrlFromPlannerUrl
} from "./sonol-public-remote-config.mjs";

const DEFAULT_REMOTE_TIMEOUT_MS = 30000;
const DEFAULT_REMOTE_CLIENT_NAME = "sonol-community-edition";
const DEFAULT_REMOTE_PROTOCOL_VERSION = "1.0.0";

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.");
}

function validateRemoteUrl(label, rawUrl, { bearerToken = "", sendWorkspaceRoot = false } = {}) {
  const normalized = normalizeText(rawUrl);
  if (!normalized) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }

  const isLoopback = isLoopbackHostname(parsed.hostname);
  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !(isHttp && isLoopback)) {
    throw new Error(`${label} must use https unless it targets loopback http`);
  }
  if (bearerToken && !isHttps && !isLoopback) {
    throw new Error(`${label} must use https when a bearer token is configured`);
  }
  if (sendWorkspaceRoot && !isHttps && !isLoopback) {
    throw new Error(`${label} must use https when workspace_root forwarding is enabled`);
  }
  return parsed.toString();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function buildWorkspaceDescriptor(workspaceRoot, sendWorkspaceRoot) {
  const workspace = getWorkspaceContext({
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : process.cwd()
  });
  return {
    workspace_id: workspace.workspace_id,
    workspace_label: basename(workspace.workspace_root ?? workspace.workspace_id),
    ...(sendWorkspaceRoot && workspace.workspace_root
      ? { workspace_root: workspace.workspace_root }
      : {})
  };
}

function defaultHeaders(config, requestId) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-sonol-client-name": config.client_name,
    "x-sonol-protocol-version": config.protocol_version,
    "x-sonol-request-id": requestId
  };
}

function buildRequestInit(body, config, requestId, extraHeaders = {}) {
  const headers = {
    ...defaultHeaders(config, requestId),
    ...extraHeaders
  };
  if (config.bearer_token) {
    headers.authorization = `Bearer ${config.bearer_token}`;
  }
  return {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  };
}

function parseJsonOrNull(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function postJson(url, body, config, requestId, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    const response = await fetch(url, {
      ...buildRequestInit(body, config, requestId, extraHeaders),
      signal: controller.signal
    });
    const raw = await response.text();
    const parsed = parseJsonOrNull(raw);
    if (!response.ok) {
      const remoteMessage = normalizeText(
        parsed?.error?.message
        ?? parsed?.message
        ?? raw,
        `remote plan normalizer request failed with status ${response.status}`
      );
      throw new Error(`remote plan normalizer request failed (${response.status}): ${remoteMessage}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("remote plan normalizer returned a non-JSON response");
    }
    return parsed;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`remote plan normalizer timed out after ${config.timeout_ms}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTicketResponse(rawTicket) {
  const ticket = rawTicket?.ticket ?? rawTicket;
  const token = normalizeText(ticket?.token);
  if (!token) {
    throw new Error("remote plan normalizer ticket response did not include a token");
  }
  return {
    token,
    ticket_id: normalizeText(ticket?.ticket_id),
    expires_at: normalizeText(ticket?.expires_at)
  };
}

export function resolveRemotePlannerConfig(options = {}) {
  const env = options.env ?? process.env;
  const bearerToken = normalizeText(
    options.remotePlannerBearerToken
    ?? options.remoteNormalizerBearerToken
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN
    ?? env.SONOL_REMOTE_PLANNER_BEARER_TOKEN
  );
  const sendWorkspaceRoot = isTruthy(
    options.remotePlannerSendWorkspaceRoot
    ?? options.remoteNormalizerSendWorkspaceRoot
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_SEND_WORKSPACE_ROOT
    ?? env.SONOL_REMOTE_PLANNER_SEND_WORKSPACE_ROOT
  );
  const rawPlannerUrl = normalizeText(
    options.remotePlannerUrl
    ?? options.remoteNormalizerUrl
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_URL
    ?? env.SONOL_REMOTE_PLANNER_URL
    ?? env.SONOL_REMOTE_CONTROL_PLANE_URL
  );
  const plannerUrl = validateRemoteUrl(
    "SONOL_REMOTE_PLAN_NORMALIZER_URL",
    rawPlannerUrl || DEFAULT_PUBLIC_REMOTE_PLANNER_URL,
    {
      bearerToken,
      sendWorkspaceRoot
    }
  );
  const rawTicketUrl = normalizeText(
    options.remotePlannerTicketUrl
    ?? options.remoteNormalizerTicketUrl
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL
    ?? env.SONOL_REMOTE_PLANNER_TICKET_URL
  );
  const ticketUrl = validateRemoteUrl(
    "SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL",
    rawTicketUrl || deriveRemotePlannerTicketUrlFromPlannerUrl(plannerUrl),
    {
      bearerToken,
      sendWorkspaceRoot
    }
  );
  const allowUnsigned = isTruthy(
    options.remotePlannerAllowUnsigned
    ?? options.remoteNormalizerAllowUnsigned
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED
    ?? env.SONOL_REMOTE_PLANNER_ALLOW_UNSIGNED
  );
  if (plannerUrl && ticketUrl) {
    const plannerOrigin = new URL(plannerUrl).origin;
    const ticketOrigin = new URL(ticketUrl).origin;
    if (plannerOrigin !== ticketOrigin) {
      throw new Error("SONOL_REMOTE_PLAN_NORMALIZER_URL and SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL must share the same origin");
    }
  }
  return {
    planner_url: plannerUrl,
    ticket_url: ticketUrl,
    bearer_token: bearerToken,
    allow_unsigned: allowUnsigned,
    timeout_ms: resolvePositiveInteger(
      options.remotePlannerTimeoutMs
      ?? options.remoteNormalizerTimeoutMs
      ?? options.timeoutMs
      ?? env.SONOL_REMOTE_PLAN_NORMALIZER_TIMEOUT_MS
      ?? env.SONOL_REMOTE_PLANNER_TIMEOUT_MS,
      DEFAULT_REMOTE_TIMEOUT_MS
    ),
    client_name: normalizeText(
      options.remotePlannerClientName
      ?? options.remoteNormalizerClientName
      ?? env.SONOL_REMOTE_PLAN_NORMALIZER_CLIENT_NAME
      ?? env.SONOL_REMOTE_PLANNER_CLIENT_NAME,
      DEFAULT_REMOTE_CLIENT_NAME
    ),
    protocol_version: normalizeText(
      options.remotePlannerProtocolVersion
      ?? options.remoteNormalizerProtocolVersion
      ?? env.SONOL_REMOTE_PLAN_NORMALIZER_PROTOCOL_VERSION
      ?? env.SONOL_REMOTE_PLANNER_PROTOCOL_VERSION,
      DEFAULT_REMOTE_PROTOCOL_VERSION
    ),
    send_workspace_root: sendWorkspaceRoot
  };
}

async function requestRemotePlannerTicket(requestSummary, options = {}, config) {
  if (!config.ticket_url) {
    return null;
  }

  const requestId = randomUUID();
  const workspace = buildWorkspaceDescriptor(options.workspaceRoot ?? options.cwd ?? process.cwd(), config.send_workspace_root);
  const body = {
    protocol_version: config.protocol_version,
    request_id: requestId,
    requested_capabilities: ["plan-normalization"],
    workspace,
    request_summary_sha256: sha256(requestSummary),
    request_summary_bytes: Buffer.byteLength(String(requestSummary ?? ""), "utf8")
  };
  const response = await postJson(config.ticket_url, body, config, requestId);
  return normalizeTicketResponse(response);
}

function buildDraftRequestPayload(requestSummary, options = {}, config, requestId) {
  const workspaceRoot = options.workspaceRoot ?? options.cwd ?? process.cwd();
  const workspace = buildWorkspaceDescriptor(workspaceRoot, config.send_workspace_root);
  const adapter = inferAdapterConfigForWorkspace({ workspaceRoot });
  const creativeDraft = options.creativeDraft;

  if (!creativeDraft || typeof creativeDraft !== "object" || Array.isArray(creativeDraft)) {
    throw new Error("remote plan normalizer requires a local creativeDraft payload");
  }

  return {
    schema_version: "1.0.0",
    request_id: requestId,
    request_summary: String(requestSummary ?? ""),
    preferred_language: normalizeText(options.preferredLanguage, "ko"),
    operator_dashboard_url: normalizeText(options.operatorDashboardUrl ?? options.dashboardUrl),
    dashboard_bridge_url: normalizeText(options.dashboardBridgeUrl),
    workspace,
    local_runtime: {
      authority: "local_sqlite",
      runtime_events: "local_sqlite",
      dashboard: "local_loopback_bridge",
      provider_execution: "local_host_runtime"
    },
    creative_draft: creativeDraft,
    adapter_context: adapter ? {
      provider: adapter.provider,
      adapter_type: adapter.adapter_type,
      adapter_backend: adapter.adapter_backend
    } : null
  };
}

function unwrapNormalizedPlan(response) {
  const candidate = response?.normalized_plan ?? response?.plan ?? response?.plan_template ?? response;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("remote plan normalizer response did not include a normalized plan object");
  }
  return candidate;
}

export async function requestRemotePlannerDraft(requestSummary, options = {}) {
  const config = resolveRemotePlannerConfig(options);
  if (!config.planner_url) {
    throw new Error("remote plan normalizer client requires SONOL_REMOTE_PLAN_NORMALIZER_URL");
  }
  if (!config.ticket_url && !config.allow_unsigned) {
    throw new Error("remote plan normalizer client requires SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL unless SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED=true");
  }

  const ticket = await requestRemotePlannerTicket(requestSummary, options, config);
  const requestId = randomUUID();
  const payload = buildDraftRequestPayload(requestSummary, options, config, requestId);
  const extraHeaders = ticket?.token
    ? { "x-sonol-job-ticket": ticket.token }
    : {};
  const response = await postJson(config.planner_url, payload, config, requestId, extraHeaders);
  return unwrapNormalizedPlan(response);
}
