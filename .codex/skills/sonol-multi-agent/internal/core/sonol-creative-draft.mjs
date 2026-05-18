import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const CREATIVE_DRAFT_SCHEMA_PATH = fileURLToPath(
  new URL("../schemas/creative-draft.schema.json", import.meta.url)
);
const CREATIVE_DRAFT_EXAMPLE_KO_PATH = fileURLToPath(
  new URL("../../references/creative-draft.example.ko.json", import.meta.url)
);
const CREATIVE_DRAFT_EXAMPLE_EN_PATH = fileURLToPath(
  new URL("../../references/creative-draft.example.en.json", import.meta.url)
);
const creativeDraftSchema = JSON.parse(readFileSync(CREATIVE_DRAFT_SCHEMA_PATH, "utf8"));
const creativeDraftAjv = new Ajv2020({ allErrors: true, strict: false });
const validateCreativeDraftShape = creativeDraftAjv.compile(creativeDraftSchema);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseJson(label, raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

function validationErrorText(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "unknown creative draft validation error";
  }
  return errors
    .map((issue) => {
      const path = issue.instancePath || issue.schemaPath || "/";
      return `${path} ${issue.message ?? "is invalid"}`;
    })
    .join("; ");
}

export function resolveCreativeDraftSource(options = {}) {
  const env = options.env ?? process.env;
  const draftFile = normalizeText(options.creativeDraftFile ?? env.SONOL_CREATIVE_DRAFT_FILE);
  const draftBase64 = normalizeText(options.creativeDraftBase64 ?? env.SONOL_CREATIVE_DRAFT_BASE64);
  const draftJson = normalizeText(options.creativeDraftJson ?? env.SONOL_CREATIVE_DRAFT_JSON);

  const configured = [
    draftFile ? "creativeDraftFile" : null,
    draftBase64 ? "creativeDraftBase64" : null,
    draftJson ? "creativeDraftJson" : null
  ].filter(Boolean);

  if (configured.length > 1) {
    throw new Error(`Provide only one creative draft source. Received: ${configured.join(", ")}`);
  }

  return {
    creativeDraftFile: draftFile || null,
    creativeDraftBase64: draftBase64 || null,
    creativeDraftJson: draftJson || null
  };
}

export function creativeDraftGuidance() {
  return {
    required: true,
    allowed_sources: [
      "--creative-draft-file <path>",
      "--creative-draft-base64 <base64-json>",
      "--creative-draft-json '<json>'",
      "SONOL_CREATIVE_DRAFT_FILE=/abs/path/to/draft.json"
    ],
    rules: [
      "The local Codex/Claude side must create the creative draft before present-proposal or recommend-plan.",
      "The creative draft is the local AI-authored proposal for orchestration shape, not the persisted normalized plan record.",
      "Use the canonical root fields plan_title, preferred_language, single_or_multi, multi_agent_beneficial, recommendation_summary, recommendation_reasons, and subagents.",
      "Each creative draft subagent uses slot_id and role_label. Do not author the draft with normalized plan fields such as agent_id, role, workstream_id, assigned_task_ids, or reporting_contract.",
      "Main agent is implicit and mandatory in runtime orchestration, but it is not listed inside the creative draft subagents array.",
      "The hosted remote service is only allowed to normalize, validate, and bind execution. It must not author the initial draft for the public/community edition."
    ],
    schema_path: CREATIVE_DRAFT_SCHEMA_PATH,
    example_files: {
      ko: CREATIVE_DRAFT_EXAMPLE_KO_PATH,
      en: CREATIVE_DRAFT_EXAMPLE_EN_PATH
    },
    canonical_root_fields: [
      "plan_title",
      "preferred_language",
      "single_or_multi",
      "multi_agent_beneficial",
      "recommendation_summary",
      "recommendation_reasons",
      "subagents"
    ],
    canonical_subagent_fields: [
      "slot_id",
      "role_label",
      "execution_class",
      "purpose",
      "task_title",
      "selection_rationale",
      "provider_agent_type",
      "developer_instructions",
      "model",
      "model_reasoning_effort",
      "sandbox_mode",
      "mcp_servers",
      "skills_config",
      "nickname_candidates",
      "read_paths",
      "write_paths",
      "deny_paths",
      "operational_constraints",
      "depends_on"
    ]
  };
}

export function loadCreativeDraft(options = {}) {
  const source = resolveCreativeDraftSource(options);
  let draft = null;
  let sourceLabel = null;

  if (source.creativeDraftFile) {
    const filePath = resolve(source.creativeDraftFile);
    draft = parseJson(`creative draft file ${filePath}`, readFileSync(filePath, "utf8"));
    sourceLabel = filePath;
  } else if (source.creativeDraftBase64) {
    const raw = Buffer.from(source.creativeDraftBase64, "base64").toString("utf8");
    draft = parseJson("creative draft base64 payload", raw);
    sourceLabel = "base64";
  } else if (source.creativeDraftJson) {
    draft = parseJson("creative draft json", source.creativeDraftJson);
    sourceLabel = "inline-json";
  } else {
    const error = new Error("Creative draft input is required in the public/community edition.");
    error.code = "CREATIVE_DRAFT_REQUIRED";
    error.guidance = creativeDraftGuidance();
    throw error;
  }

  if (!validateCreativeDraftShape(draft)) {
    const error = new Error(`Creative draft validation failed: ${validationErrorText(validateCreativeDraftShape.errors)}`);
    error.code = "CREATIVE_DRAFT_INVALID";
    error.guidance = creativeDraftGuidance();
    error.validation_errors = validateCreativeDraftShape.errors ?? [];
    throw error;
  }

  return {
    draft,
    source: sourceLabel
  };
}
