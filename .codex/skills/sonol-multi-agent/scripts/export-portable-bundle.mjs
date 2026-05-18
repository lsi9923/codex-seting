#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sonolInstallRoot, detectWorkspaceRoot, normalizeWorkspacePath } from "../internal/core/sonol-runtime-paths.mjs";
import { spawnSync } from "node:child_process";

const allowedFlags = new Set([
  "--output-dir",
  "--bundle-name",
  "--workspace-root",
  "--skip-validate",
  "--force"
]);

function timestampLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function buildGuidance(errorCode, message, extra = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    expected_usage: [
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs --output-dir /abs/output",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs --output-dir /abs/output --bundle-name sonol-portable",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs --output-dir /abs/output --workspace-root /abs/workspace",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs --output-dir /abs/output --force --skip-validate"
    ],
    rules: [
      "--output-dir points to a parent directory; the script creates <output-dir>/<bundle-name>",
      "--bundle-name is optional; a timestamped name is used by default",
      "--workspace-root is used only for post-export smoke validation",
      "--skip-validate disables the post-export smoke test",
      "--force removes an existing bundle directory before exporting"
    ],
    ...extra
  };
}

function failWithGuidance(errorCode, message, extra = {}) {
  const guidance = buildGuidance(errorCode, message, extra);
  console.error(message);
  console.error("");
  console.error("Expected format:");
  for (const line of guidance.expected_usage) {
    console.error(`- ${line}`);
  }
  console.error("");
  console.error(JSON.stringify(guidance, null, 2));
  process.exit(1);
}

function requirePath(pathname, label) {
  if (!existsSync(pathname)) {
    failWithGuidance("MISSING_REQUIRED_PATH", `Missing required ${label}: ${pathname}`, {
      missing_path: pathname,
      missing_label: label
    });
  }
}

const args = {
  outputDir: resolve(process.cwd(), "dist"),
  bundleName: `sonol-portable-bundle-${timestampLabel()}`,
  workspaceRoot: process.env.SONOL_WORKSPACE_ROOT
    ? normalizeWorkspacePath(process.env.SONOL_WORKSPACE_ROOT)
    : detectWorkspaceRoot(process.cwd()),
  validate: true,
  force: false
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--help") {
    const guidance = buildGuidance("HELP", "Show export-portable-bundle usage.");
    for (const line of guidance.expected_usage) {
      console.error(line);
    }
    process.exit(0);
  }
  if (token.startsWith("--") && !allowedFlags.has(token)) {
    failWithGuidance("UNKNOWN_FLAG", `Unsupported flag: ${token}`, { unsupported_flag: token });
  }
  if (token === "--output-dir") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --output-dir", { flag: "--output-dir" });
    }
    args.outputDir = resolve(process.argv[index + 1]);
    index += 1;
  } else if (token === "--bundle-name") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --bundle-name", { flag: "--bundle-name" });
    }
    args.bundleName = process.argv[index + 1];
    index += 1;
  } else if (token === "--workspace-root") {
    if (!process.argv[index + 1]) {
      failWithGuidance("MISSING_FLAG_VALUE", "Missing value for --workspace-root", { flag: "--workspace-root" });
    }
    args.workspaceRoot = normalizeWorkspacePath(process.argv[index + 1]);
    index += 1;
  } else if (token === "--skip-validate") {
    args.validate = false;
  } else if (token === "--force") {
    args.force = true;
  }
}

if (!args.bundleName || !String(args.bundleName).trim()) {
  failWithGuidance("INVALID_BUNDLE_NAME", "Bundle name must be a non-empty string.");
}
if (/[\\/]/.test(args.bundleName)) {
  failWithGuidance("INVALID_BUNDLE_NAME", "Bundle name must not contain path separators.", {
    bundle_name: args.bundleName
  });
}

const installRoot = process.env.SONOL_INSTALL_ROOT
  ? resolve(process.env.SONOL_INSTALL_ROOT)
  : sonolInstallRoot();
const sourceSkillsRoot = resolve(installRoot, "skills");
const sourceMultiAgentRoot = resolve(sourceSkillsRoot, "sonol-multi-agent");
const sourceRuntimeRoot = resolve(sourceSkillsRoot, "sonol-agent-runtime");
const sourceDashboardDist = resolve(sourceMultiAgentRoot, "internal", "dashboard", "dist", "index.html");
const sourceAjv = resolve(sourceMultiAgentRoot, "node_modules", "ajv", "package.json");
const sourceWs = resolve(sourceMultiAgentRoot, "node_modules", "ws", "package.json");
const bundleRoot = resolve(args.outputDir, args.bundleName);
const bundleSkillsRoot = resolve(bundleRoot, "skills");
const exportedMultiAgentRoot = resolve(bundleSkillsRoot, "sonol-multi-agent");
const exportedRuntimeRoot = resolve(bundleSkillsRoot, "sonol-agent-runtime");
const exportedSmokeTest = resolve(exportedMultiAgentRoot, "scripts", "portable-smoke-test.mjs");
const exportedSetupDoc = resolve(exportedMultiAgentRoot, "references", "portable-setup.md");

requirePath(sourceMultiAgentRoot, "skill directory");
requirePath(sourceRuntimeRoot, "skill directory");
requirePath(sourceDashboardDist, "dashboard dist asset");
requirePath(sourceAjv, "bundled Ajv package");
requirePath(sourceWs, "bundled ws package");

mkdirSync(args.outputDir, { recursive: true });
if (existsSync(bundleRoot)) {
  if (!args.force) {
    failWithGuidance("OUTPUT_ALREADY_EXISTS", `Bundle output already exists: ${bundleRoot}`, {
      output_path: bundleRoot
    });
  }
  rmSync(bundleRoot, { recursive: true, force: true });
}

mkdirSync(bundleSkillsRoot, { recursive: true });
cpSync(sourceMultiAgentRoot, exportedMultiAgentRoot, { recursive: true });
cpSync(sourceRuntimeRoot, exportedRuntimeRoot, { recursive: true });

const setupDocText = readFileSync(exportedSetupDoc, "utf8");
const readme = `# Sonol Portable Bundle

This bundle contains a self-contained Sonol runtime package with only:

- skills/sonol-multi-agent
- skills/sonol-agent-runtime

## Install

1. Copy this bundle directory to the target machine.
2. Export \`SONOL_INSTALL_ROOT\` to this bundle root.
3. Read \`skills/sonol-multi-agent/references/portable-setup.md\`.
4. Run:
   - \`node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/portable-smoke-test.mjs\`
   - \`node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs\`

## Included Requirements

- Bundled runtime deps under \`skills/sonol-multi-agent/node_modules\`
- Bundled dashboard assets under \`skills/sonol-multi-agent/internal/dashboard/dist\`
- Node.js >= 22 on the target machine

## Source

- Exported from: \`${installRoot}\`
- Exported at: \`${new Date().toISOString()}\`
`;

const manifest = {
  ok: true,
  schema_version: 1,
  exported_at: new Date().toISOString(),
  source_install_root: installRoot,
  bundle_root: bundleRoot,
  skills_root: bundleSkillsRoot,
  included_skills: [
    "sonol-multi-agent",
    "sonol-agent-runtime"
  ],
  bundled_runtime_dependencies: [
    "ajv",
    "ws",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string"
  ],
  dashboard_dist: "skills/sonol-multi-agent/internal/dashboard/dist",
  portable_setup_excerpt: setupDocText.split("\n").slice(0, 24).join("\n")
};

writeFileSync(resolve(bundleRoot, "README.md"), readme, "utf8");
writeFileSync(resolve(bundleRoot, "SONOL_PORTABLE_BUNDLE.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

let validation = null;
if (args.validate) {
  const run = spawnSync(process.execPath, [exportedSmokeTest], {
    cwd: args.workspaceRoot,
    env: {
      ...process.env,
      SONOL_INSTALL_ROOT: bundleRoot,
      SONOL_WORKSPACE_ROOT: args.workspaceRoot
    },
    encoding: "utf8"
  });
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout || "{}");
  } catch {
    parsed = null;
  }
  validation = {
    ok: run.status === 0 && Boolean(parsed?.ok),
    exit_code: run.status,
    signal: run.signal,
    workspace_root: args.workspaceRoot,
    stdout: parsed ?? (run.stdout || "").trim(),
    stderr: (run.stderr || "").trim()
  };
}

const result = {
  ok: args.validate ? Boolean(validation?.ok) : true,
  source_install_root: installRoot,
  bundle_root: bundleRoot,
  skills_root: bundleSkillsRoot,
  files_written: [
    resolve(bundleRoot, "README.md"),
    resolve(bundleRoot, "SONOL_PORTABLE_BUNDLE.json")
  ],
  copied_skills: [
    exportedMultiAgentRoot,
    exportedRuntimeRoot
  ],
  validation
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
