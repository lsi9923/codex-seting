#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sonolInstallRoot } from "../internal/core/sonol-runtime-paths.mjs";

const allowedFlags = new Set([
  "--output-dir",
  "--bundle-name",
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
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-public-release.mjs",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-public-release.mjs --output-dir /abs/output",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-public-release.mjs --output-dir /abs/output --bundle-name sonol-public",
      "node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-public-release.mjs --output-dir /abs/output --force --skip-validate"
    ],
    rules: [
      "--output-dir points to a parent directory; the script creates <output-dir>/<bundle-name>",
      "--bundle-name is optional; a timestamped name is used by default",
      "--force removes an existing release directory before exporting",
      "--skip-validate disables the post-export public-surface validation"
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

function removeIfPresent(pathname) {
  rmSync(pathname, { recursive: true, force: true });
}

function walkFiles(rootDir, relativeDir = "") {
  const absoluteDir = resolve(rootDir, relativeDir);
  if (!existsSync(absoluteDir)) {
    return [];
  }
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkFiles(rootDir, entryRelativePath));
    } else if (entry.isFile()) {
      files.push(entryRelativePath);
    }
  }
  return files;
}

const args = {
  outputDir: resolve(process.cwd(), "dist"),
  bundleName: `sonol-public-release-${timestampLabel()}`,
  validate: true,
  force: false
};

for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token === "--help") {
    const guidance = buildGuidance("HELP", "Show export-public-release usage.");
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
const releaseRoot = resolve(args.outputDir, args.bundleName);
const exportedMultiAgentRoot = resolve(releaseRoot, "sonol-multi-agent");
const exportedRuntimeRoot = resolve(releaseRoot, "sonol-agent-runtime");
const exportedCheckScript = resolve(exportedMultiAgentRoot, "scripts", "check-public-release.mjs");

requirePath(sourceMultiAgentRoot, "skill directory");
requirePath(sourceRuntimeRoot, "skill directory");
requirePath(resolve(sourceMultiAgentRoot, "SKILL.md"), "multi-agent skill entry");
requirePath(resolve(sourceRuntimeRoot, "SKILL.md"), "runtime skill entry");
requirePath(resolve(sourceMultiAgentRoot, "internal", "dashboard", "dist", "index.html"), "dashboard dist asset");
requirePath(resolve(sourceMultiAgentRoot, "node_modules", "ajv", "package.json"), "bundled Ajv package");
requirePath(resolve(sourceMultiAgentRoot, "node_modules", "ws", "package.json"), "bundled ws package");
requirePath(resolve(sourceMultiAgentRoot, "scripts", "check-public-release.mjs"), "public release validator");
requirePath(resolve(sourceMultiAgentRoot, "references", "public-release.md"), "public release reference");

mkdirSync(args.outputDir, { recursive: true });
if (existsSync(releaseRoot)) {
  if (!args.force) {
    failWithGuidance("OUTPUT_ALREADY_EXISTS", `Release output already exists: ${releaseRoot}`, {
      output_path: releaseRoot
    });
  }
  removeIfPresent(releaseRoot);
}

mkdirSync(releaseRoot, { recursive: true });
cpSync(sourceMultiAgentRoot, exportedMultiAgentRoot, { recursive: true });
cpSync(sourceRuntimeRoot, exportedRuntimeRoot, { recursive: true });

const prunedPaths = [
  "sonol-multi-agent/sonol-agent-runtime",
  "sonol-multi-agent/references/remote-control-plane.env.example",
  "sonol-multi-agent/references/sonol-remote-control-plane.service",
  "sonol-multi-agent/references/remote-thin-dashboard.html"
];

for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
  if (!entry.name.startsWith(".")) {
    continue;
  }
  removeIfPresent(resolve(releaseRoot, entry.name));
  prunedPaths.push(entry.name);
}

for (const relativePath of prunedPaths) {
  removeIfPresent(resolve(releaseRoot, relativePath));
}

const suffixesToPrune = [".map"];
for (const relativePath of walkFiles(releaseRoot)) {
  if (suffixesToPrune.some((suffix) => relativePath.endsWith(suffix))) {
    removeIfPresent(resolve(releaseRoot, relativePath));
    prunedPaths.push(relativePath);
  }
}

let validation = null;
if (args.validate) {
  const run = spawnSync(process.execPath, [exportedCheckScript, "--release-root", releaseRoot], {
    cwd: releaseRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout || "{}");
  } catch {
    parsed = null;
  }
  validation = {
    ok: run.status === 0 && !run.error,
    exit_code: run.status,
    signal: run.signal,
    parsed_ok: parsed?.ok ?? null,
    stdout: run.stdout?.trim() || "",
    stderr: run.stderr?.trim() || ""
  };
  if (!validation.ok) {
    failWithGuidance("PUBLIC_RELEASE_VALIDATION_FAILED", `Public release validation failed for ${releaseRoot}`, {
      release_root: releaseRoot,
      validation
    });
  }
}

const payload = {
  ok: true,
  release_root: releaseRoot,
  included_skills: [
    "sonol-multi-agent",
    "sonol-agent-runtime"
  ],
  pruned_paths: prunedPaths,
  validation
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
