import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { localize, preferredLanguageName, runtimeDefaultPhrases } from "./sonol-language.mjs";
import { defaultRuntimeRoot, skillScriptPath, sonolInstallRoot } from "./sonol-runtime-paths.mjs";

const MAX_MESSAGE_LEN = 96;
const MAX_SUMMARY_LEN = 140;

function asciiSlug(value, limit = 16) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit) || "x";
}

function stableHash(value) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

export function safePlanRuntimeDir(plan) {
  const label = asciiSlug(plan?.plan_title ?? plan?.request_summary ?? plan?.plan_id ?? "plan", 12);
  const hash = stableHash(plan?.plan_id ?? plan?.request_summary ?? "plan").slice(0, 8);
  return `plan_${label}_${hash}`;
}

function resolveRuntimeBase(rootDir) {
  return defaultRuntimeRoot({
    workspaceRoot: rootDir ?? undefined,
    startDir: rootDir ?? process.cwd()
  });
}

function preferredCommandExt() {
  if (process.platform === "win32") {
    return "cmd";
  }
  return "sh";
}

function buildCommandFileSet(commandDir, agentId) {
  return {
    sh: resolve(commandDir, `${agentId}.sh`),
    cmd: resolve(commandDir, `${agentId}.cmd`),
    ps1: resolve(commandDir, `${agentId}.ps1`)
  };
}

function toWindowsPath(value) {
  return String(value ?? "").replace(/\//g, "\\");
}

function defaultWindowsInstallRoot() {
  const explicit = String(
    process.env.SONOL_WINDOWS_INSTALL_ROOT
    ?? process.env.SONOL_CMD_INSTALL_ROOT
    ?? ""
  ).trim();
  if (explicit) {
    return toWindowsPath(explicit);
  }
  const installRoot = String(sonolInstallRoot() ?? "").trim();
  if (process.platform === "win32") {
    return toWindowsPath(installRoot);
  }
  const mountMatch = installRoot.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!mountMatch) {
    return "";
  }
  const [, driveLetter, restPath] = mountMatch;
  return `${driveLetter.toUpperCase()}:\\${restPath.replace(/\//g, "\\")}`;
}

function buildMainReporterIdentityFlags({
  mainProviderSessionKind,
  mainProviderSessionId,
  mainProviderSessionFile,
  mainProviderThreadId,
  quote = JSON.stringify
}) {
  const flags = [];
  if (mainProviderSessionKind === "claude-code") {
    if (mainProviderSessionId) {
      flags.push(`--provider-session-id ${quote(mainProviderSessionId)}`);
    }
    if (mainProviderSessionFile) {
      flags.push(`--provider-session-file ${quote(mainProviderSessionFile)}`);
    }
  } else if (mainProviderSessionKind === "codex" && mainProviderThreadId) {
    flags.push(`--provider-session-thread-id ${quote(mainProviderThreadId)}`);
  }
  return flags;
}

function buildMainReportCommandLine({
  executable,
  dbValue,
  runIdValue,
  taskIdValue,
  type,
  mainProviderSessionKind,
  mainProviderSessionId,
  mainProviderSessionFile,
  mainProviderThreadId,
  extraArgs = [],
  includeTaskId = true,
  quote = JSON.stringify
}) {
  return [
    `node ${executable}`,
    `--db ${dbValue}`,
    `--run-id ${runIdValue}`,
    ...buildMainReporterIdentityFlags({
      mainProviderSessionKind,
      mainProviderSessionId,
      mainProviderSessionFile,
      mainProviderThreadId,
      quote
    }),
    `--type ${type}`,
    includeTaskId && taskIdValue ? `--task-id ${taskIdValue}` : "",
    ...extraArgs
  ].filter(Boolean).join(" ");
}

function buildPosixCommandScript(context) {
  const {
    dbPath,
    planId,
    runId,
    agentId,
    taskId,
    progressScript,
    artifactScript,
    sessionScript,
    completionScript,
    phrases,
    language
  } = context;
  if (context.isMainAgent) {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `SONOL_INSTALL_ROOT_DEFAULT=${JSON.stringify(sonolInstallRoot())}`,
      "SONOL_INSTALL_ROOT=\"${SONOL_INSTALL_ROOT:-$SONOL_INSTALL_ROOT_DEFAULT}\"",
      `DB_PATH=${JSON.stringify(dbPath)}`,
      `PLAN_ID=${JSON.stringify(planId)}`,
      `RUN_ID=${JSON.stringify(runId)}`,
      `AGENT_ID=${JSON.stringify(agentId)}`,
      `TASK_ID=${JSON.stringify(taskId)}`,
      "REPORT_MAIN=\"$SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/report-main.mjs\"",
      "",
      "# This launcher is generated for the current install root.",
      `# Preferred user language: ${language}`,
      "",
      "# progress: immediately when work starts",
      buildMainReportCommandLine({
        executable: "\"$REPORT_MAIN\"",
        dbValue: "\"$DB_PATH\"",
        runIdValue: "\"$RUN_ID\"",
        taskIdValue: taskId ? "\"$TASK_ID\"" : "",
        type: "progress",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          "--step-index 1",
          "--total-steps 3",
          `--state ${JSON.stringify("running")}`,
          `--message ${JSON.stringify(phrases.startMessage)}`,
          `--detail ${JSON.stringify(phrases.startDetail)}`
        ]
      }),
      "",
      "# idle/session",
      buildMainReportCommandLine({
        executable: "\"$REPORT_MAIN\"",
        dbValue: "\"$DB_PATH\"",
        runIdValue: "\"$RUN_ID\"",
        taskIdValue: taskId ? "\"$TASK_ID\"" : "",
        type: "session",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--status ${JSON.stringify("idle")}`,
          `--message ${JSON.stringify(phrases.idleMessage)}`,
          `--detail ${JSON.stringify(phrases.idleDetail)}`
        ]
      }),
      "",
      "# completion",
      buildMainReportCommandLine({
        executable: "\"$REPORT_MAIN\"",
        dbValue: "\"$DB_PATH\"",
        runIdValue: "\"$RUN_ID\"",
        taskIdValue: taskId ? "\"$TASK_ID\"" : "",
        type: "completion",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--result ${JSON.stringify("success")}`,
          `--summary ${JSON.stringify(phrases.completionSummary)}`,
          `--detail ${JSON.stringify(phrases.completionDetail)}`,
          `--next-actions ${JSON.stringify(localize(language, "handoff", "handoff"))}`,
          "--auto-reconcile-completed-agents true"
        ]
      })
    ].join("\n");
  }

  const startCommandLines = taskId
    ? [
        "# progress: immediately when work starts",
        "node \"$REPORT_PROGRESS\" --db \"$DB_PATH\" \\",
        "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
        `  --step-index 1 --total-steps 3 --state running --message ${JSON.stringify(phrases.startMessage)} \\`,
        `  --detail ${JSON.stringify(phrases.startDetail)}`
      ]
    : [
        "# session: use when no concrete task_id was assigned",
        "node \"$REPORT_SESSION\" --db \"$DB_PATH\" \\",
        "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" \\",
        `  --status running --message ${JSON.stringify(phrases.startMessage)} \\`,
        `  --detail ${JSON.stringify(phrases.startDetail)}`
      ];

  const idleCommandLines = taskId
    ? [
        "# idle/session",
        "node \"$REPORT_SESSION\" --db \"$DB_PATH\" \\",
        "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
        `  --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`
      ]
    : [
        "# idle/session",
        "node \"$REPORT_SESSION\" --db \"$DB_PATH\" \\",
        "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" \\",
        `  --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`
      ];

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `SONOL_INSTALL_ROOT_DEFAULT=${JSON.stringify(sonolInstallRoot())}`,
    "SONOL_INSTALL_ROOT=\"${SONOL_INSTALL_ROOT:-$SONOL_INSTALL_ROOT_DEFAULT}\"",
    `DB_PATH=${JSON.stringify(dbPath)}`,
    `PLAN_ID=${JSON.stringify(planId)}`,
    `RUN_ID=${JSON.stringify(runId)}`,
    `AGENT_ID=${JSON.stringify(agentId)}`,
    `TASK_ID=${JSON.stringify(taskId)}`,
    "REPORT_PROGRESS=\"$SONOL_INSTALL_ROOT/skills/sonol-agent-runtime/scripts/report-progress.mjs\"",
    "REPORT_ARTIFACT=\"$SONOL_INSTALL_ROOT/skills/sonol-agent-runtime/scripts/report-artifact.mjs\"",
    "REPORT_SESSION=\"$SONOL_INSTALL_ROOT/skills/sonol-agent-runtime/scripts/report-session.mjs\"",
    "REPORT_COMPLETION=\"$SONOL_INSTALL_ROOT/skills/sonol-agent-runtime/scripts/report-completion.mjs\"",
    "",
    "# This launcher is generated for the current install root.",
    `# Preferred user language: ${language}`,
    "",
    ...startCommandLines,
    "",
    "# progress: after each meaningful small work unit",
    "node \"$REPORT_PROGRESS\" --db \"$DB_PATH\" \\",
    "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
    `  --step-index 2 --total-steps 5 --state running --message ${JSON.stringify(phrases.progressMessage)} \\`,
    `  --detail ${JSON.stringify(phrases.progressDetail)}`,
    "",
    "# artifact",
    ...(taskId
      ? [
          "node \"$REPORT_ARTIFACT\" --db \"$DB_PATH\" \\",
          "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
          "  --artifact-type file --artifact-ref path/to/file --summary \"Created output\" \\",
          "  --detail \"Why this file matters and what happens next.\""
        ]
      : ["# task_id is required for artifact reporting; use the assigned task before reporting artifacts."]),
    "",
    "# blocked/session",
    ...(taskId
      ? [
          "node \"$REPORT_SESSION\" --db \"$DB_PATH\" \\",
          "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
          `  --status blocked --message ${JSON.stringify(localize(language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(language, "선행 조건 누락", "Missing prerequisite"))}`
        ]
      : [
          "node \"$REPORT_SESSION\" --db \"$DB_PATH\" \\",
          "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" \\",
          `  --status blocked --message ${JSON.stringify(localize(language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(language, "선행 조건 누락", "Missing prerequisite"))}`
        ]),
    "",
    ...idleCommandLines,
    "",
    "# completion",
    ...(taskId
      ? [
          "node \"$REPORT_COMPLETION\" --db \"$DB_PATH\" \\",
          "  --plan-id \"$PLAN_ID\" --run-id \"$RUN_ID\" --agent-id \"$AGENT_ID\" --task-id \"$TASK_ID\" \\",
          `  --result success --summary ${JSON.stringify(phrases.completionSummary)} --detail ${JSON.stringify(phrases.completionDetail)} --next-actions ${JSON.stringify(localize(language, "handoff", "handoff"))}`
        ]
      : ["# task_id is required for completion reporting; finish the assigned task before reporting completion."])
  ].join("\n");
}

function buildCmdCommandScript(context) {
  const {
    dbPath,
    planId,
    runId,
    agentId,
    taskId,
    progressScript,
    sessionScript,
    completionScript,
    phrases
  } = context;
  if (context.isMainAgent) {
    const lines = [
      "@echo off",
      "setlocal",
      `set "SONOL_INSTALL_ROOT_DEFAULT=${defaultWindowsInstallRoot()}"`,
      "if not defined SONOL_INSTALL_ROOT if defined SONOL_INSTALL_ROOT_DEFAULT set \"SONOL_INSTALL_ROOT=%SONOL_INSTALL_ROOT_DEFAULT%\"",
      `set "DB_PATH=${dbPath}"`,
      `set "PLAN_ID=${planId}"`,
      `set "RUN_ID=${runId}"`,
      `set "AGENT_ID=${agentId}"`,
      `set "TASK_ID=${taskId}"`,
      "set \"REPORT_MAIN=%SONOL_INSTALL_ROOT%\\skills\\sonol-multi-agent\\scripts\\report-main.mjs\"",
      "",
      "REM Start report",
      buildMainReportCommandLine({
        executable: "\"%REPORT_MAIN%\"",
        dbValue: "\"%DB_PATH%\"",
        runIdValue: "\"%RUN_ID%\"",
        taskIdValue: taskId ? "\"%TASK_ID%\"" : "",
        type: "progress",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          "--step-index 1",
          "--total-steps 3",
          `--state ${JSON.stringify("running")}`,
          `--message ${JSON.stringify(phrases.startMessage)}`,
          `--detail ${JSON.stringify(phrases.startDetail)}`
        ]
      }),
      "",
      "REM Idle report",
      buildMainReportCommandLine({
        executable: "\"%REPORT_MAIN%\"",
        dbValue: "\"%DB_PATH%\"",
        runIdValue: "\"%RUN_ID%\"",
        taskIdValue: taskId ? "\"%TASK_ID%\"" : "",
        type: "session",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--status ${JSON.stringify("idle")}`,
          `--message ${JSON.stringify(phrases.idleMessage)}`,
          `--detail ${JSON.stringify(phrases.idleDetail)}`
        ]
      }),
      "",
      "REM Completion report",
      buildMainReportCommandLine({
        executable: "\"%REPORT_MAIN%\"",
        dbValue: "\"%DB_PATH%\"",
        runIdValue: "\"%RUN_ID%\"",
        taskIdValue: taskId ? "\"%TASK_ID%\"" : "",
        type: "completion",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--result ${JSON.stringify("success")}`,
          `--summary ${JSON.stringify(phrases.completionSummary)}`,
          `--detail ${JSON.stringify(phrases.completionDetail)}`,
          `--next-actions ${JSON.stringify("handoff")}`,
          "--auto-reconcile-completed-agents true"
        ]
      })
    ];
    return `${lines.join("\r\n")}\r\n`;
  }

  const lines = [
    "@echo off",
    "setlocal",
    `set "SONOL_INSTALL_ROOT_DEFAULT=${defaultWindowsInstallRoot()}"`,
    "if not defined SONOL_INSTALL_ROOT if defined SONOL_INSTALL_ROOT_DEFAULT set \"SONOL_INSTALL_ROOT=%SONOL_INSTALL_ROOT_DEFAULT%\"",
    `set "DB_PATH=${dbPath}"`,
    `set "PLAN_ID=${planId}"`,
    `set "RUN_ID=${runId}"`,
    `set "AGENT_ID=${agentId}"`,
    `set "TASK_ID=${taskId}"`,
    "set \"REPORT_PROGRESS=%SONOL_INSTALL_ROOT%\\skills\\sonol-agent-runtime\\scripts\\report-progress.mjs\"",
    "set \"REPORT_ARTIFACT=%SONOL_INSTALL_ROOT%\\skills\\sonol-agent-runtime\\scripts\\report-artifact.mjs\"",
    "set \"REPORT_SESSION=%SONOL_INSTALL_ROOT%\\skills\\sonol-agent-runtime\\scripts\\report-session.mjs\"",
    "set \"REPORT_COMPLETION=%SONOL_INSTALL_ROOT%\\skills\\sonol-agent-runtime\\scripts\\report-completion.mjs\"",
    "",
    "REM Start report",
    taskId
      ? `node "%REPORT_PROGRESS%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --task-id "%TASK_ID%" --step-index 1 --total-steps 3 --state running --message ${JSON.stringify(phrases.startMessage)} --detail ${JSON.stringify(phrases.startDetail)}`
      : `node "%REPORT_SESSION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --status running --message ${JSON.stringify(phrases.startMessage)} --detail ${JSON.stringify(phrases.startDetail)}`,
    "",
    "REM Progress after each meaningful small work unit",
    taskId
      ? `node "%REPORT_PROGRESS%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --task-id "%TASK_ID%" --step-index 2 --total-steps 5 --state running --message ${JSON.stringify(phrases.progressMessage)} --detail ${JSON.stringify(phrases.progressDetail)}`
      : "REM task_id is required for milestone progress reporting",
    "",
    "REM Artifact report",
    taskId
      ? "node \"%REPORT_ARTIFACT%\" --db \"%DB_PATH%\" --plan-id \"%PLAN_ID%\" --run-id \"%RUN_ID%\" --agent-id \"%AGENT_ID%\" --task-id \"%TASK_ID%\" --artifact-type file --artifact-ref path/to/file --summary \"Created output\" --detail \"Why this file matters and what happens next.\""
      : "REM task_id is required for artifact reporting",
    "",
    "REM Blocked report",
    taskId
      ? `node "%REPORT_SESSION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --task-id "%TASK_ID%" --status blocked --message ${JSON.stringify(localize(context.language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(context.language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(context.language, "선행 조건 누락", "Missing prerequisite"))}`
      : `node "%REPORT_SESSION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --status blocked --message ${JSON.stringify(localize(context.language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(context.language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(context.language, "선행 조건 누락", "Missing prerequisite"))}`,
    "",
    "REM Idle report",
    taskId
      ? `node "%REPORT_SESSION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --task-id "%TASK_ID%" --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`
      : `node "%REPORT_SESSION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`,
    "",
    "REM Completion report",
    taskId
      ? `node "%REPORT_COMPLETION%" --db "%DB_PATH%" --plan-id "%PLAN_ID%" --run-id "%RUN_ID%" --agent-id "%AGENT_ID%" --task-id "%TASK_ID%" --result success --summary ${JSON.stringify(phrases.completionSummary)} --detail ${JSON.stringify(phrases.completionDetail)} --next-actions "handoff"`
      : "REM task_id is required for completion reporting"
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function buildPowerShellCommandScript(context) {
  const {
    dbPath,
    planId,
    runId,
    agentId,
    taskId,
    progressScript,
    sessionScript,
    completionScript,
    phrases
  } = context;
  if (context.isMainAgent) {
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      `$SONOL_INSTALL_ROOT_DEFAULT = ${JSON.stringify(defaultWindowsInstallRoot())}`,
      "if (-not $env:SONOL_INSTALL_ROOT -and $SONOL_INSTALL_ROOT_DEFAULT) { $env:SONOL_INSTALL_ROOT = $SONOL_INSTALL_ROOT_DEFAULT }",
      `$DB_PATH = ${JSON.stringify(dbPath)}`,
      `$PLAN_ID = ${JSON.stringify(planId)}`,
      `$RUN_ID = ${JSON.stringify(runId)}`,
      `$AGENT_ID = ${JSON.stringify(agentId)}`,
      `$TASK_ID = ${JSON.stringify(taskId)}`,
      "$REPORT_MAIN = Join-Path $env:SONOL_INSTALL_ROOT \"skills\\sonol-multi-agent\\scripts\\report-main.mjs\"",
      "",
      "# Start report",
      buildMainReportCommandLine({
        executable: "$REPORT_MAIN",
        dbValue: "$DB_PATH",
        runIdValue: "$RUN_ID",
        taskIdValue: taskId ? "$TASK_ID" : "",
        type: "progress",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          "--step-index 1",
          "--total-steps 3",
          `--state ${JSON.stringify("running")}`,
          `--message ${JSON.stringify(phrases.startMessage)}`,
          `--detail ${JSON.stringify(phrases.startDetail)}`
        ]
      }),
      "",
      "# Idle report",
      buildMainReportCommandLine({
        executable: "$REPORT_MAIN",
        dbValue: "$DB_PATH",
        runIdValue: "$RUN_ID",
        taskIdValue: taskId ? "$TASK_ID" : "",
        type: "session",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--status ${JSON.stringify("idle")}`,
          `--message ${JSON.stringify(phrases.idleMessage)}`,
          `--detail ${JSON.stringify(phrases.idleDetail)}`
        ]
      }),
      "",
      "# Completion report",
      buildMainReportCommandLine({
        executable: "$REPORT_MAIN",
        dbValue: "$DB_PATH",
        runIdValue: "$RUN_ID",
        taskIdValue: taskId ? "$TASK_ID" : "",
        type: "completion",
        mainProviderSessionKind: context.mainProviderSessionKind,
        mainProviderSessionId: context.mainProviderSessionId,
        mainProviderSessionFile: context.mainProviderSessionFile,
        mainProviderThreadId: context.mainProviderThreadId,
        extraArgs: [
          `--result ${JSON.stringify("success")}`,
          `--summary ${JSON.stringify(phrases.completionSummary)}`,
          `--detail ${JSON.stringify(phrases.completionDetail)}`,
          `--next-actions ${JSON.stringify("handoff")}`,
          "--auto-reconcile-completed-agents true"
        ]
      })
    ];
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$SONOL_INSTALL_ROOT_DEFAULT = ${JSON.stringify(defaultWindowsInstallRoot())}`,
    "if (-not $env:SONOL_INSTALL_ROOT -and $SONOL_INSTALL_ROOT_DEFAULT) { $env:SONOL_INSTALL_ROOT = $SONOL_INSTALL_ROOT_DEFAULT }",
    `$DB_PATH = ${JSON.stringify(dbPath)}`,
    `$PLAN_ID = ${JSON.stringify(planId)}`,
    `$RUN_ID = ${JSON.stringify(runId)}`,
    `$AGENT_ID = ${JSON.stringify(agentId)}`,
    `$TASK_ID = ${JSON.stringify(taskId)}`,
    "$REPORT_PROGRESS = Join-Path $env:SONOL_INSTALL_ROOT \"skills\\sonol-agent-runtime\\scripts\\report-progress.mjs\"",
    "$REPORT_ARTIFACT = Join-Path $env:SONOL_INSTALL_ROOT \"skills\\sonol-agent-runtime\\scripts\\report-artifact.mjs\"",
    "$REPORT_SESSION = Join-Path $env:SONOL_INSTALL_ROOT \"skills\\sonol-agent-runtime\\scripts\\report-session.mjs\"",
    "$REPORT_COMPLETION = Join-Path $env:SONOL_INSTALL_ROOT \"skills\\sonol-agent-runtime\\scripts\\report-completion.mjs\"",
    "",
    "# Start report",
    taskId
      ? `node $REPORT_PROGRESS --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --step-index 1 --total-steps 3 --state running --message ${JSON.stringify(phrases.startMessage)} --detail ${JSON.stringify(phrases.startDetail)}`
      : `node $REPORT_SESSION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --status running --message ${JSON.stringify(phrases.startMessage)} --detail ${JSON.stringify(phrases.startDetail)}`,
    "",
    "# Progress after each meaningful small work unit",
    taskId
      ? `node $REPORT_PROGRESS --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --step-index 2 --total-steps 5 --state running --message ${JSON.stringify(phrases.progressMessage)} --detail ${JSON.stringify(phrases.progressDetail)}`
      : "# task_id is required for milestone progress reporting",
    "",
    "# Artifact report",
    taskId
      ? "node $REPORT_ARTIFACT --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --artifact-type file --artifact-ref path/to/file --summary \"Created output\" --detail \"Why this file matters and what happens next.\""
      : "# task_id is required for artifact reporting",
    "",
    "# Blocked report",
    taskId
      ? `node $REPORT_SESSION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --status blocked --message ${JSON.stringify(localize(context.language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(context.language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(context.language, "선행 조건 누락", "Missing prerequisite"))}`
      : `node $REPORT_SESSION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --status blocked --message ${JSON.stringify(localize(context.language, "입력 필요", "Need input"))} --detail ${JSON.stringify(localize(context.language, "무엇이 왜 막혔는지 적으세요.", "Describe what is blocked and why."))} --blocked-reason ${JSON.stringify(localize(context.language, "선행 조건 누락", "Missing prerequisite"))}`,
    "",
    "# Idle report",
    taskId
      ? `node $REPORT_SESSION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`
      : `node $REPORT_SESSION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --status idle --message ${JSON.stringify(phrases.idleMessage)} --detail ${JSON.stringify(phrases.idleDetail)}`,
    "",
    "# Completion report",
    taskId
      ? `node $REPORT_COMPLETION --db $DB_PATH --plan-id $PLAN_ID --run-id $RUN_ID --agent-id $AGENT_ID --task-id $TASK_ID --result success --summary ${JSON.stringify(phrases.completionSummary)} --detail ${JSON.stringify(phrases.completionDetail)} --next-actions "handoff"`
      : "# task_id is required for completion reporting"
  ];

  return `${lines.join("\n")}\n`;
}

export function resolveActivePlanPromptPath(plan, agentId, options = {}) {
  const runtimeBase = options.runtimeRoot
    ? resolve(options.runtimeRoot)
    : defaultRuntimeRoot({
        workspaceRoot: options.workspaceRoot ?? plan?.workspace_root ?? undefined,
        startDir: options.startDir ?? plan?.workspace_root ?? process.cwd()
      });
  return resolve(runtimeBase, plan?.plan_id ?? safePlanRuntimeDir(plan), "prompts", `${agentId}.txt`);
}

export function resolveRunPromptPath(run, agentId, options = {}) {
  const runtimeBase = options.runtimeRoot
    ? resolve(options.runtimeRoot)
    : defaultRuntimeRoot({
        workspaceRoot: options.workspaceRoot ?? run?.workspace_root ?? run?.plan_snapshot?.workspace_root ?? undefined,
        startDir: options.startDir ?? run?.workspace_root ?? run?.plan_snapshot?.workspace_root ?? process.cwd()
      });

  return resolve(runtimeBase, run?.run_id ?? "run", "prompts", `${agentId}.txt`);
}

function compactText(value, maxLength) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeExecutionClass(agent) {
  const explicit = String(agent?.execution_class ?? "").trim();
  if (explicit) {
    return explicit;
  }

  const legacyMap = {
    Main: "lead",
    Planner: "planner",
    Research: "research",
    Code: "implementer",
    Test: "verifier",
    Reviewer: "reviewer",
    Docs: "docs",
    Refactor: "refactor",
    Ops: "ops"
  };

  return legacyMap[String(agent?.role ?? "").trim()] ?? "general";
}

function isMainAgent(agent) {
  return normalizeExecutionClass(agent) === "lead" || agent?.role === "Main";
}

function taskIdsForAgent(plan, agent) {
  if (agent.current_task_id) {
    return [agent.current_task_id];
  }
  if (Array.isArray(agent.assigned_task_ids) && agent.assigned_task_ids.length > 0) {
    return [...agent.assigned_task_ids];
  }

  if (isMainAgent(agent)) {
    return plan.tasks
      .filter((task) => task.task_id === "task_main_integrate" || task.task_id === "task_single_execute")
      .map((task) => task.task_id);
  }

  const suffix = agent.role.toLowerCase();
  const inferred = plan.tasks
    .filter((task) => task.task_id === `task_${suffix}`)
    .map((task) => task.task_id);

  return inferred.length > 0 ? inferred : [];
}

export function prepareRunContextFiles(store, runId, options = {}) {
  const run = store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const plan = store.getPlanForRun(run);
  if (!plan) {
    throw new Error(`Plan not found for run: ${run.plan_id}`);
  }

  const runtimeBase = resolveRuntimeBase(options.rootDir ?? plan.workspace_root ?? null);
  const rootDir = resolve(runtimeBase, runId);
  const agentDir = resolve(rootDir, "agents");
  const commandDir = resolve(rootDir, "commands");
  const promptDir = resolve(rootDir, "prompts");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(promptDir, { recursive: true });

  const dbPath = store.dbPath;
  const progressScript = skillScriptPath("sonol-agent-runtime", "report-progress.mjs");
  const artifactScript = skillScriptPath("sonol-agent-runtime", "report-artifact.mjs");
  const sessionScript = skillScriptPath("sonol-agent-runtime", "report-session.mjs");
  const completionScript = skillScriptPath("sonol-agent-runtime", "report-completion.mjs");
  const ingestJsonScript = skillScriptPath("sonol-agent-runtime", "ingest-json-report.mjs");
  const packetBuilder = typeof options.packetBuilder === "function" ? options.packetBuilder : null;
  if (!packetBuilder) {
    throw new Error("prepareRunContextFiles requires a packetBuilder function");
  }
  const planSummaryLines = [
    `plan_title: ${plan.plan_title ?? plan.request_summary}`,
    `request_summary: ${compactText(plan.request_summary, MAX_SUMMARY_LEN)}`,
    `preferred_language: ${plan.preferred_language ?? "ko"}`,
    `mode: ${run.mode}`,
    `run_id: ${run.run_id}`,
    `plan_id: ${plan.plan_id}`,
    `use_runtime_reporting: prefer generated transport, use script commands or JSON ingest as available`,
    `message_limit: ${MAX_MESSAGE_LEN}`,
    `summary_limit: ${MAX_SUMMARY_LEN}`
  ];

  writeFileSync(resolve(rootDir, "plan-summary.txt"), `${planSummaryLines.join("\n")}\n`, "utf8");
  const phrases = runtimeDefaultPhrases(plan.preferred_language);
  const sharedInstructionLines = [
    "Use the generated Sonol runtime reporting transport.",
    "Prefer local report-* commands when available in the active provider.",
    "If local helper commands are not practical, use the generated JSON ingest path instead.",
    "Do not return runtime JSON in the final answer.",
    `Use ${preferredLanguageName(plan.preferred_language)} for user-facing runtime messages unless a later instruction explicitly overrides it.`,
    `Keep event messages under ${MAX_MESSAGE_LEN} chars.`,
    `Keep summaries under ${MAX_SUMMARY_LEN} chars.`,
    "Use short factual phrases, not long prose.",
    "Use message as a short headline.",
    "Use detail as 1 to 3 short sentences when the dashboard should explain the work.",
    "Report start immediately when work begins.",
    "Then report each meaningful small work unit.",
    localize(plan.preferred_language, "의미 있는 단위에는 파일 생성/수정, 장면 변경, 테스트 실행, 인수인계가 포함됩니다.", "Meaningful units include file create/edit, scene change, test run, and handoff."),
    "If the current unit is done and no immediate next action exists, report status idle.",
    "Report artifacts as soon as they exist.",
    "Report completion at task end."
  ];
  writeFileSync(
    resolve(rootDir, "shared-instructions.txt"),
    sharedInstructionLines.join("\n") + "\n",
    "utf8"
  );

  const generated = [];
  for (const agent of plan.agents) {
    const assignedTaskIds = taskIdsForAgent(plan, agent);
    const currentTaskId = assignedTaskIds[0] ?? "";
    const agentPayload = {
      run_id: run.run_id,
      plan_id: plan.plan_id,
      agent_id: agent.agent_id,
      role: agent.role,
      role_label: agent.role_label ?? agent.role,
      execution_class: normalizeExecutionClass(agent),
      workstream_id: agent.workstream_id ?? null,
      selection_rationale: compactText(agent.selection_rationale, MAX_SUMMARY_LEN),
      preferred_language: agent.preferred_language ?? plan.preferred_language ?? "ko",
      purpose: compactText(agent.purpose, MAX_SUMMARY_LEN),
      provider_agent_type: agent.provider_agent_type ?? agent.codex_agent_type ?? "default",
      ...(agent.codex_agent_type ? { codex_agent_type: agent.codex_agent_type } : {}),
      execution_target: agent.execution_target ?? null,
      model: agent.model,
      model_reasoning_effort: agent.model_reasoning_effort,
      sandbox_mode: agent.sandbox_mode,
      read_paths: agent.read_paths,
      write_paths: agent.write_paths,
      deny_paths: agent.deny_paths,
      depends_on: agent.depends_on,
      assigned_task_ids: assignedTaskIds,
      current_task_id: currentTaskId,
      developer_instructions: compactText(agent.developer_instructions, MAX_SUMMARY_LEN),
      mcp_servers: agent.mcp_servers,
      skills_config: agent.skills_config,
      reporting_contract: agent.reporting_contract
    };

    const agentJsonPath = resolve(agentDir, `${agent.agent_id}.json`);
    writeFileSync(agentJsonPath, `${JSON.stringify(agentPayload, null, 2)}\n`, "utf8");

    const commandFiles = buildCommandFileSet(commandDir, agent.agent_id);
    const commandScriptPath = commandFiles[preferredCommandExt()];
    const promptFile = resolve(promptDir, `${agent.agent_id}.txt`);
    const commandContext = {
      dbPath,
      planId: plan.plan_id,
      runId: run.run_id,
      agentId: agent.agent_id,
      taskId: currentTaskId,
      isMainAgent: isMainAgent(agent),
      mainProviderSessionKind: run.provider_refs?.main_provider_session_kind ?? null,
      mainProviderSessionId: run.provider_refs?.main_provider_session_id ?? null,
      mainProviderSessionFile: run.provider_refs?.main_provider_session_file ?? null,
      mainProviderThreadId: run.provider_refs?.main_provider_session_thread_id ?? null,
      progressScript,
      artifactScript,
      sessionScript,
      completionScript,
      ingestJsonScript,
      phrases,
      language: plan.preferred_language
    };
    const posixCommands = buildPosixCommandScript(commandContext);
    const cmdCommands = buildCmdCommandScript(commandContext);
    const ps1Commands = buildPowerShellCommandScript(commandContext);
    for (const filePath of [commandFiles.sh]) {
      writeFileSync(filePath, `${posixCommands}\n`, "utf8");
    }
    for (const filePath of [commandFiles.cmd]) {
      writeFileSync(filePath, cmdCommands, "utf8");
    }
    for (const filePath of [commandFiles.ps1]) {
      writeFileSync(filePath, ps1Commands, "utf8");
    }

    generated.push({
      agent_id: agent.agent_id,
      agent_file: agentJsonPath,
      command_file: commandScriptPath,
      command_files: commandFiles,
      report_progress_script: progressScript,
      report_artifact_script: artifactScript,
      report_session_script: sessionScript,
      report_completion_script: completionScript,
      ingest_json_report_script: ingestJsonScript,
      prompt_file: promptFile
    });
  }

  const runtimeFiles = {
    db_path: dbPath,
    root_dir: rootDir,
    plan_summary_file: resolve(rootDir, "plan-summary.txt"),
    shared_instructions_file: resolve(rootDir, "shared-instructions.txt"),
    report_progress_script: progressScript,
    report_artifact_script: artifactScript,
    report_session_script: sessionScript,
    report_completion_script: completionScript,
    ingest_json_report_script: ingestJsonScript,
    agents: generated
  };

  for (const agent of plan.agents) {
    const packet = packetBuilder(plan, run, agent, { runtimeFiles });
    const generatedAgent = generated.find((item) => item.agent_id === agent.agent_id);
    const promptFile = generatedAgent?.prompt_file ?? resolve(promptDir, `${agent.agent_id}.txt`);
    writeFileSync(promptFile, `${packet.delegation_prompt}\n`, "utf8");
  }

  return runtimeFiles;
}
