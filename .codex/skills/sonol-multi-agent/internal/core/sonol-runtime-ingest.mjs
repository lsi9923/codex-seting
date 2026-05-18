const SUPPORTED_EVENT_TYPES = new Set([
  "progress_event",
  "artifact_event",
  "completion_event",
  "session_updated"
]);

function nowIso() {
  return new Date().toISOString();
}

function stripMarkdownFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findBalancedJson(text) {
  const source = stripMarkdownFence(text);
  const direct = tryParseJson(source);
  if (direct !== null) {
    return direct;
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParseJson(fenceMatch[1].trim());
    if (fenced !== null) {
      return fenced;
    }
  }

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") {
      continue;
    }

    const stack = [opener];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) {
          break;
        }

        stack.pop();
        if (stack.length === 0) {
          const candidate = text.slice(start, index + 1).trim();
          const parsed = tryParseJson(candidate);
          if (parsed !== null) {
            return parsed;
          }
          break;
        }
      }
    }
  }

  throw new Error("No valid JSON payload found in runtime report.");
}

function omitEventType(entry) {
  const payload = { ...entry };
  delete payload.event_type;
  delete payload.type;
  return payload;
}

function stableEventId(eventType, payload, context = {}) {
  const planId = payload.plan_id ?? context.planId ?? "plan";
  const runId = payload.run_id ?? context.runId ?? "run";
  const agentId = payload.agent_id ?? context.agentId ?? "system";
  const sourceParts = [
    eventType,
    planId,
    runId,
    agentId,
    payload.task_id ?? "",
    payload.status ?? payload.state ?? "",
    payload.result ?? "",
    payload.message ?? "",
    payload.summary ?? "",
    payload.artifact_type ?? "",
    payload.artifact_ref ?? "",
    payload.step_index ?? "",
    payload.total_steps ?? ""
  ].map((value) => String(value ?? "").trim());
  const source = sourceParts.join("|");
  let hash = 2166136261;
  const bytes = Buffer.from(source, "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${eventType}_${runId}_${agentId}_${hash.toString(36)}`;
}

function normalizeEventEntry(entry, context = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Each runtime event entry must be a JSON object.");
  }

  const eventType = entry.event_type ?? entry.type;
  if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
    throw new Error(`Unsupported runtime event type: ${String(eventType)}`);
  }

  const payload =
    entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
      ? { ...entry.payload }
      : omitEventType(entry);

  if (context.runId) {
    if (payload.run_id && payload.run_id !== context.runId) {
      throw new Error(`Runtime report run_id mismatch: expected ${context.runId}, received ${payload.run_id}`);
    }
    payload.run_id = context.runId;
  }
  if (context.planId) {
    if (payload.plan_id && payload.plan_id !== context.planId) {
      throw new Error(`Runtime report plan_id mismatch: expected ${context.planId}, received ${payload.plan_id}`);
    }
    payload.plan_id = context.planId;
  }
  if (context.agentId) {
    if (payload.agent_id && payload.agent_id !== context.agentId) {
      throw new Error(`Runtime report agent_id mismatch: expected ${context.agentId}, received ${payload.agent_id}`);
    }
    payload.agent_id = context.agentId;
  }
  if (!payload.schema_version) {
    payload.schema_version = "1.0.0";
  }
  if (!payload.timestamp) {
    payload.timestamp = nowIso();
  }
  if (!payload.event_id) {
    payload.event_id = stableEventId(eventType, payload, context);
  }

  if (eventType === "session_updated" && payload.state && !payload.status) {
    payload.status = payload.state;
    delete payload.state;
  }
  if (eventType === "session_updated" && !payload.agent_id) {
    throw new Error("Runtime session_updated reports must include agent_id. Run-level status changes are reserved for Sonol internal control paths.");
  }
  if (payload.agent_id === "agent_main") {
    throw new Error("agent_main must report through report-main.mjs. Runtime JSON ingest is reserved for subagents.");
  }

  return { eventType, payload };
}

export function normalizeRuntimeReport(input, context = {}) {
  const parsed = typeof input === "string" ? findBalancedJson(input) : input;
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.events)
      ? parsed.events
      : [parsed];

  if (!entries.length) {
    throw new Error("Runtime report contained no events.");
  }

  return entries.map((entry) => normalizeEventEntry(entry, context));
}

export function ingestRuntimeReport(store, input, context = {}) {
  const normalized = normalizeRuntimeReport(input, context);
  const ingested = normalized.map(({ eventType, payload }) => {
    store.appendEvent(eventType, payload);
    return {
      event_type: eventType,
      payload
    };
  });

  const runId = ingested[0]?.payload?.run_id ?? context.runId ?? null;
  return {
    run_id: runId,
    ingested_count: ingested.length,
    event_ids: ingested.map((event) => event.payload.event_id),
    events: ingested
  };
}
