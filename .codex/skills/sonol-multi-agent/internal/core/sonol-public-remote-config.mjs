export const PUBLIC_REMOTE_PLANNER_ORIGIN = "https://agent.zooo.kr";
export const DEFAULT_PUBLIC_REMOTE_PLANNER_URL = `${PUBLIC_REMOTE_PLANNER_ORIGIN}/v1/planner/draft`;
export const DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL = `${PUBLIC_REMOTE_PLANNER_ORIGIN}/v1/planner/ticket`;
export const DEFAULT_PUBLIC_REMOTE_DASHBOARD_BASE_URL = `${PUBLIC_REMOTE_PLANNER_ORIGIN}/sonol-dashboard/`;
export const DEFAULT_PUBLIC_REMOTE_PLANNER_URL_SOURCE = "default:public-planner-url";
export const DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL_SOURCE = "default:public-ticket-url";

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function deriveRemotePlannerTicketUrlFromPlannerUrl(rawPlannerUrl) {
  const plannerUrl = normalizeText(rawPlannerUrl);
  if (!plannerUrl) {
    return DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL;
  }
  try {
    return new URL("/v1/planner/ticket", new URL(plannerUrl).origin).toString();
  } catch {
    return DEFAULT_PUBLIC_REMOTE_PLANNER_TICKET_URL;
  }
}

export function deriveRemoteDashboardBaseUrlFromPlannerUrl(rawPlannerUrl) {
  const plannerUrl = normalizeText(rawPlannerUrl);
  if (!plannerUrl) {
    return DEFAULT_PUBLIC_REMOTE_DASHBOARD_BASE_URL;
  }
  try {
    return new URL("/sonol-dashboard/", new URL(plannerUrl).origin).toString();
  } catch {
    return DEFAULT_PUBLIC_REMOTE_DASHBOARD_BASE_URL;
  }
}
