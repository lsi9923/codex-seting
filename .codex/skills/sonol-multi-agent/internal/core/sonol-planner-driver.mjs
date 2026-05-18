import {
  DEFAULT_PUBLIC_REMOTE_PLANNER_URL,
  DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL_SOURCE,
  DEFAULT_PUBLIC_REMOTE_PLANNER_URL_SOURCE,
  deriveRemotePlannerTicketUrlFromPlannerUrl
} from "./sonol-public-remote-config.mjs";

export const REMOTE_PLANNER_BACKEND = "remote_control_plane";
export const REMOTE_PLANNER_DRIVER = "remote_http";
export const SONOL_PLANNER_BACKEND = REMOTE_PLANNER_BACKEND;
export const SONOL_PLANNER_DRIVER = REMOTE_PLANNER_DRIVER;
export const DEFAULT_PLANNER_DRIVER = REMOTE_PLANNER_DRIVER;

const SUPPORTED_PLANNER_DRIVERS = new Set([REMOTE_PLANNER_DRIVER]);

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function isSupportedPlannerDriver(value) {
  return SUPPORTED_PLANNER_DRIVERS.has(String(value ?? "").trim());
}

export function defaultPlannerDriverForWorkspace() {
  return REMOTE_PLANNER_DRIVER;
}

export function defaultPlannerModelForDriver() {
  return "remote-managed";
}

export function plannerBackendForDriver() {
  return REMOTE_PLANNER_BACKEND;
}

export function resolvePlannerModel(options = {}) {
  const env = options.env ?? process.env;
  const requestedModel =
    options.plannerModel
    ?? options.model
    ?? env.SONOL_PLANNER_MODEL
    ?? null;
  const normalizedModel = String(requestedModel ?? "").trim();
  return normalizedModel || defaultPlannerModelForDriver();
}

export function resolvePlannerConfig(options = {}) {
  const env = options.env ?? process.env;
  const explicitRequestedDriver = normalizeText(
    options.plannerDriver
    ?? options.driver
    ?? env.SONOL_PLANNER_DRIVER,
    ""
  );
  const rawRemotePlannerUrl = normalizeText(
    options.remotePlannerUrl
    ?? options.remoteNormalizerUrl
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_URL
    ?? env.SONOL_REMOTE_PLANNER_URL
    ?? env.SONOL_REMOTE_CONTROL_PLANE_URL,
    ""
  );
  const remotePlannerUrl = rawRemotePlannerUrl || DEFAULT_PUBLIC_REMOTE_PLANNER_URL;
  const rawRemotePlannerTicketUrl = normalizeText(
    options.remotePlannerTicketUrl
    ?? options.remoteNormalizerTicketUrl
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL
    ?? env.SONOL_REMOTE_PLANNER_TICKET_URL,
    ""
  );
  const remotePlannerTicketUrl = rawRemotePlannerTicketUrl || deriveRemotePlannerTicketUrlFromPlannerUrl(remotePlannerUrl);
  const remotePlannerBearerToken = normalizeText(
    options.remotePlannerBearerToken
    ?? options.remoteNormalizerBearerToken
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN
    ?? env.SONOL_REMOTE_PLANNER_BEARER_TOKEN,
    ""
  );
  const remotePlannerAllowUnsigned = isTruthy(
    options.remotePlannerAllowUnsigned
    ?? options.remoteNormalizerAllowUnsigned
    ?? env.SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED
    ?? env.SONOL_REMOTE_PLANNER_ALLOW_UNSIGNED
  );

  const remoteConfigPresentKeys = [];
  if (remotePlannerUrl) {
    remoteConfigPresentKeys.push(
      rawRemotePlannerUrl
        ? (env.SONOL_REMOTE_PLAN_NORMALIZER_URL ? "SONOL_REMOTE_PLAN_NORMALIZER_URL" : "SONOL_REMOTE_PLANNER_URL")
        : DEFAULT_PUBLIC_REMOTE_PLANNER_URL_SOURCE
    );
  }
  if (remotePlannerTicketUrl) {
    remoteConfigPresentKeys.push(
      rawRemotePlannerTicketUrl
        ? (env.SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL ? "SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL" : "SONOL_REMOTE_PLANNER_TICKET_URL")
        : DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL_SOURCE
    );
  }
  if (remotePlannerBearerToken) {
    remoteConfigPresentKeys.push(
      env.SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN ? "SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN" : "SONOL_REMOTE_PLANNER_BEARER_TOKEN"
    );
  }
  if (remotePlannerAllowUnsigned) {
    remoteConfigPresentKeys.push(
      env.SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED ? "SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED" : "SONOL_REMOTE_PLANNER_ALLOW_UNSIGNED"
    );
  }

  const remoteConfigMissingKeys = [];
  if (!remotePlannerUrl) {
    remoteConfigMissingKeys.push("SONOL_REMOTE_PLAN_NORMALIZER_URL");
  }
  if (!remotePlannerAllowUnsigned && !remotePlannerTicketUrl) {
    remoteConfigMissingKeys.push("SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL");
  }

  const remoteConfigDetected = remoteConfigPresentKeys.length > 0;
  const remoteConfigComplete = remoteConfigMissingKeys.length === 0;
  const invalidRequestedDriver = explicitRequestedDriver && !isSupportedPlannerDriver(explicitRequestedDriver)
    ? explicitRequestedDriver
    : null;

  let remoteConfigErrorReason = null;
  if (!remoteConfigDetected) {
    remoteConfigErrorReason = "Public/community edition requires a hosted plan normalizer. The built-in public endpoint could not be resolved, so set SONOL_REMOTE_PLAN_NORMALIZER_URL and SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL explicitly.";
  } else if (!remoteConfigComplete) {
    remoteConfigErrorReason = `Hosted plan normalizer configuration is incomplete. Missing: ${remoteConfigMissingKeys.join(", ")}.`;
  }

  return {
    planner_backend: REMOTE_PLANNER_BACKEND,
    planner_driver: REMOTE_PLANNER_DRIVER,
    planner_selection_source: explicitRequestedDriver
      ? ((options.plannerDriver ?? options.driver) != null ? "explicit-option" : "env:SONOL_PLANNER_DRIVER")
      : "public-edition-default",
    remote_config_detected: remoteConfigDetected,
    remote_config_complete: remoteConfigComplete,
    remote_config_error_reason: remoteConfigErrorReason,
    remote_config_present_keys: remoteConfigPresentKeys,
    remote_config_missing_keys: remoteConfigMissingKeys,
    invalid_requested_driver: invalidRequestedDriver
  };
}

export function summarizePlannerConfig(config = {}) {
  return {
    planner_backend: config.planner_backend ?? null,
    planner_driver: config.planner_driver ?? null,
    planner_selection_source: config.planner_selection_source ?? null,
    remote_config_detected: Boolean(config.remote_config_detected),
    remote_config_complete: Boolean(config.remote_config_complete),
    remote_config_error_reason: config.remote_config_error_reason ?? null,
    remote_config_present_keys: Array.isArray(config.remote_config_present_keys) ? [...config.remote_config_present_keys] : [],
    remote_config_missing_keys: Array.isArray(config.remote_config_missing_keys) ? [...config.remote_config_missing_keys] : [],
    invalid_requested_driver: config.invalid_requested_driver ?? null
  };
}

export function validatePlannerConfig(config = {}) {
  if (config.invalid_requested_driver) {
    return {
      error_code: "INVALID_PLANNER_DRIVER",
      message: `Public/community edition only supports ${REMOTE_PLANNER_DRIVER}. Received: ${config.invalid_requested_driver}.`,
      details: summarizePlannerConfig(config)
    };
  }
  if (config.remote_config_error_reason) {
    return {
      error_code: config.remote_config_detected ? "REMOTE_PLANNER_CONFIG_INCOMPLETE" : "REMOTE_PLANNER_REQUIRED",
      message: config.remote_config_error_reason,
      details: summarizePlannerConfig(config)
    };
  }
  return null;
}
