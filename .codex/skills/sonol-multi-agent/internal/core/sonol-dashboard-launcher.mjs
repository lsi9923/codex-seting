import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { userInfo } from "node:os";
import { resolve } from "node:path";

function stableHash(value) {
  let hash = 2166136261;
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

export function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

export function isLocalDashboard(url) {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function dashboardPort(url) {
  const parsed = new URL(url);
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

export function dashboardStartArgs({ scriptPath, workspaceRoot, dbPath, dashboardUrl }) {
  return [
    process.execPath,
    scriptPath,
    "--workspace-root",
    workspaceRoot,
    ...(dbPath ? ["--db", dbPath] : []),
    "--dashboard-url",
    dashboardUrl
  ];
}

export function dashboardStartCommand({ scriptPath, workspaceRoot, dbPath, dashboardUrl }) {
  return dashboardStartArgs({ scriptPath, workspaceRoot, dbPath, dashboardUrl }).map(shellQuote).join(" ");
}

function dashboardLaunchEnv({ workspaceRoot, dbPath, runtimeRoot, dashboardUrl }) {
  return {
    ...process.env,
    SONOL_WORKSPACE_ROOT: workspaceRoot,
    ...(dbPath ? { SONOL_DB_PATH: dbPath } : {}),
    ...(runtimeRoot ? { SONOL_RUNTIME_ROOT: runtimeRoot } : {}),
    SONOL_DASHBOARD_URL: dashboardUrl
  };
}

function probeJson(url, path = "/", timeoutMs = 1200) {
  return new Promise((resolveProbe) => {
    let parsed;
    try {
      parsed = new URL(path, url);
    } catch {
      resolveProbe({
        reachable: false,
        reason: "invalid_url",
        response_status: null,
        json: null,
        raw: ""
      });
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
        if (!response.statusCode || response.statusCode >= 500) {
          resolveProbe({
            reachable: true,
            reason: "http_error",
            response_status: response.statusCode ?? null,
            json: null,
            raw: raw.trim()
          });
          return;
        }
        try {
          resolveProbe({
            reachable: true,
            reason: "ok",
            response_status: response.statusCode ?? null,
            json: JSON.parse(raw),
            raw: raw.trim()
          });
        } catch {
          resolveProbe({
            reachable: true,
            reason: "invalid_json",
            response_status: response.statusCode ?? null,
            json: null,
            raw: raw.trim()
          });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolveProbe({
        reachable: false,
        reason: "timeout",
        response_status: null,
        json: null,
        raw: ""
      });
    });
    request.on("error", () => resolveProbe({
      reachable: false,
      reason: "transport_error",
      response_status: null,
      json: null,
      raw: ""
    }));
    request.end();
  });
}

function readJson(url, path = "/", timeoutMs = 1200) {
  return probeJson(url, path, timeoutMs).then((result) => result.json);
}

function normalizeOrigin(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text).origin;
  } catch {
    return "";
  }
}

function readCommandOutput(command, args) {
  return new Promise((resolveOutput) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolveOutput(""));
    child.on("close", () => resolveOutput(stdout));
  });
}

async function findDashboardPid(port) {
  if (process.platform === "win32") {
    const cmdPath = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const output = await readCommandOutput(
      hasCommand(cmdPath) ? cmdPath : "cmd.exe",
      ["/d", "/s", "/c", `netstat -ano -p tcp | findstr :${port}`]
    );
    const match = output.match(new RegExp(`:${port}\\s+[^\\n]*LISTENING\\s+(\\d+)`, "i"))
      ?? output.match(/LISTENING\s+(\d+)/i);
    return match ? Number(match[1]) : null;
  }
  const output = await readCommandOutput("bash", ["-lc", `ss -lptn 'sport = :${port}'`]);
  const match = output.match(/pid=(\d+)/);
  return match ? Number(match[1]) : null;
}

async function stopDashboardForPort(port) {
  const pid = await findDashboardPid(port);
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function launchArtifactPaths(runtimeRoot, workspaceRoot) {
  const launchRoot = resolve(runtimeRoot, "dashboard-launch");
  mkdirSync(launchRoot, { recursive: true });
  const suffix = stableHash(`${workspaceRoot}|${runtimeRoot}`).slice(0, 12);
  return {
    launchRoot,
    wrapperPath: resolve(launchRoot, `dashboard-${suffix}.sh`),
    logPath: resolve(launchRoot, `dashboard-${suffix}.log`)
  };
}

function ensureWrapperScript({ scriptPath, workspaceRoot, dbPath, runtimeRoot, dashboardUrl }) {
  const { wrapperPath, logPath } = launchArtifactPaths(runtimeRoot, workspaceRoot);
  const env = {
    SONOL_WORKSPACE_ROOT: workspaceRoot,
    ...(dbPath ? { SONOL_DB_PATH: dbPath } : {}),
    ...(runtimeRoot ? { SONOL_RUNTIME_ROOT: runtimeRoot } : {}),
    SONOL_DASHBOARD_URL: dashboardUrl
  };
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const command = dashboardStartCommand({ scriptPath, workspaceRoot, dbPath, dashboardUrl });
  const content = [
    "#!/bin/sh",
    "set -eu",
    exports,
    `exec ${command} >> ${shellQuote(logPath)} 2>&1`
  ].join("\n");
  writeFileSync(wrapperPath, `${content}\n`, "utf8");
  chmodSync(wrapperPath, 0o755);
  return { wrapperPath, logPath };
}

function hasCommand(pathname) {
  try {
    return existsSync(pathname);
  } catch {
    return false;
  }
}

function defaultStrategies() {
  if (process.platform === "win32") {
    return ["detached"];
  }
  const strategies = [];
  const powershellPath = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const schtasksPath = "/mnt/c/Windows/System32/schtasks.exe";
  if (hasCommand(powershellPath) && hasCommand(schtasksPath)) {
    strategies.push("windows-schtasks-wsl");
  }
  if (hasCommand("/usr/bin/systemd-run")) {
    strategies.push("systemd-run");
  }
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (interactive && hasCommand("/usr/bin/tmux")) {
    strategies.push("tmux");
  }
  if (interactive || process.env.SONOL_ALLOW_VOLATILE_DASHBOARD_BACKENDS === "1") {
    strategies.push("detached");
  }
  return strategies;
}

function resolveStrategyOrder() {
  const explicit = String(process.env.SONOL_DASHBOARD_DAEMON_STRATEGY ?? "").trim();
  if (!explicit || explicit === "auto") {
    return defaultStrategies();
  }
  return explicit.split(",").map((token) => token.trim()).filter(Boolean);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached === true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolveResult({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", (code) => {
      resolveResult({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: null
      });
    });
    if (options.detached === true) {
      child.unref();
    }
  });
}

async function inspectDashboardHealth({
  dashboardUrl,
  workspaceRoot,
  dbPath,
  expectedRemoteDashboardOrigin = "",
  timeoutMs = 1200
}) {
  const probe = await probeJson(dashboardUrl, "/api/health", timeoutMs);
  if (!probe.reachable) {
    return {
      ...probe,
      healthy: false,
      same_workspace: false,
      same_db: false,
      same_remote_dashboard_origin: false,
      workspace_root_exists: false,
      binding_valid: false,
      health: null
    };
  }

  const health = probe.json;
  if (!health?.ok) {
    return {
      ...probe,
      healthy: false,
      same_workspace: false,
      same_db: false,
      same_remote_dashboard_origin: false,
      workspace_root_exists: false,
      binding_valid: false,
      health,
      reason: probe.reason === "ok" ? "health_not_ok" : probe.reason
    };
  }

  const sameWorkspace = String(health.workspace_root ?? "") === String(workspaceRoot ?? "");
  const sameDb = String(health.authoritative_db_path ?? "") === String(dbPath ?? "");
  const workspaceRootExists = health.workspace_root_exists !== false;
  const bindingValid = health.binding_valid !== false;
  const expectedRemoteOrigin = normalizeOrigin(expectedRemoteDashboardOrigin);
  const actualRemoteOrigin = normalizeOrigin(health.remote_dashboard_origin);
  const sameRemoteDashboardOrigin = expectedRemoteOrigin
    ? actualRemoteOrigin === expectedRemoteOrigin
    : true;
  return {
    ...probe,
    healthy: sameWorkspace && sameDb && workspaceRootExists && bindingValid && sameRemoteDashboardOrigin,
    same_workspace: sameWorkspace,
    same_db: sameDb,
    same_remote_dashboard_origin: sameRemoteDashboardOrigin,
    workspace_root_exists: workspaceRootExists,
    binding_valid: bindingValid,
    health,
    reason: !sameWorkspace
      ? "binding_workspace_mismatch"
      : !sameDb
        ? "binding_db_mismatch"
        : !workspaceRootExists
          ? "workspace_root_missing"
          : !bindingValid
            ? "binding_invalid"
            : !sameRemoteDashboardOrigin
              ? "remote_origin_mismatch"
              : "healthy"
  };
}

async function waitForHealthyDashboard({
  dashboardUrl,
  workspaceRoot,
  dbPath,
  expectedRemoteDashboardOrigin = "",
  attempts = 28,
  intervalMs = 500
}) {
  let lastState = {
    reachable: false,
    healthy: false,
    same_workspace: false,
    same_db: false,
    same_remote_dashboard_origin: false,
    workspace_root_exists: false,
    binding_valid: false,
    health: null,
    reason: "unprobed",
    response_status: null,
    raw: ""
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastState = await inspectDashboardHealth({
      dashboardUrl,
      workspaceRoot,
      dbPath,
      expectedRemoteDashboardOrigin,
      timeoutMs: 800
    });
    if (lastState.healthy) {
      let stable = true;
      let stableChecks = 0;
      for (let verify = 0; verify < 4; verify += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        lastState = await inspectDashboardHealth({
          dashboardUrl,
          workspaceRoot,
          dbPath,
          expectedRemoteDashboardOrigin,
          timeoutMs: 800
        });
        stableChecks += 1;
        if (!lastState.healthy) {
          stable = false;
          lastState = {
            ...lastState,
            reason: "unstable_after_start"
          };
          break;
        }
      }
      if (!stable) {
        continue;
      }
      return {
        ...lastState,
        attempts_used: attempt + 1,
        stability_checks: stableChecks
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  return {
    ...lastState,
    attempts_used: attempts
  };
}

function schedulerTaskName(workspaceRoot, dashboardUrl) {
  return `SonolDashboard_${stableHash(`${workspaceRoot}|${dashboardUrl}`).slice(0, 12)}`;
}

async function launchViaWindowsSchtasks(options) {
  const schtasksPath = "/mnt/c/Windows/System32/schtasks.exe";
  if (!hasCommand(schtasksPath)) {
    return { attempted: false, strategy: "windows-schtasks-wsl", detail: "schtasks.exe not available" };
  }
  const { wrapperPath } = ensureWrapperScript(options);
  const taskName = schedulerTaskName(options.workspaceRoot, options.dashboardUrl);
  const wslUser = process.env.SONOL_WSL_RELAY_USER || process.env.USER || userInfo().username || "root";
  const taskCommand = `C:\\Windows\\System32\\wsl.exe -u ${wslUser} -e sh ${wrapperPath}`;
  const createResult = await runCommand(schtasksPath, [
    "/Create",
    "/TN",
    taskName,
    "/SC",
    "ONCE",
    "/ST",
    "23:59",
    "/TR",
    taskCommand,
    "/F"
  ], { cwd: options.workspaceRoot });
  if (!createResult.ok) {
    return {
      attempted: true,
      started: false,
      strategy: "windows-schtasks-wsl",
      detail: (createResult.stderr || createResult.stdout || createResult.error || "task creation failed").trim(),
      code: createResult.code
    };
  }
  const runResult = await runCommand(schtasksPath, [
    "/Run",
    "/TN",
    taskName
  ], { cwd: options.workspaceRoot });
  return {
    attempted: true,
    started: runResult.ok,
    strategy: "windows-schtasks-wsl",
    detail: runResult.ok
      ? `scheduled task ${taskName} launched`
      : (runResult.stderr || runResult.stdout || runResult.error || "task launch failed").trim(),
    code: runResult.code,
    task_name: taskName
  };
}

async function launchViaSystemdRun(options) {
  if (!hasCommand("/usr/bin/systemd-run")) {
    return { attempted: false, strategy: "systemd-run", detail: "systemd-run not available" };
  }
  const { wrapperPath } = ensureWrapperScript(options);
  const unitName = `sonol-dashboard-${stableHash(`${options.workspaceRoot}|${options.dashboardUrl}`).slice(0, 12)}`;
  const result = await runCommand("/usr/bin/systemd-run", [
    "--user",
    "--unit",
    unitName,
    "--collect",
    "--quiet",
    "/bin/sh",
    wrapperPath
  ], {
    cwd: options.workspaceRoot,
    env: dashboardLaunchEnv(options)
  });
  return {
    attempted: true,
    started: result.ok,
    strategy: "systemd-run",
    detail: result.ok
      ? `systemd user unit ${unitName} launched`
      : (result.stderr || result.stdout || result.error || "systemd-run failed").trim(),
    code: result.code,
    unit_name: unitName
  };
}

async function launchViaTmux(options) {
  if (!hasCommand("/usr/bin/tmux")) {
    return { attempted: false, strategy: "tmux", detail: "tmux not available" };
  }
  const { wrapperPath } = ensureWrapperScript(options);
  const sessionName = `sonol_dash_${stableHash(`${options.workspaceRoot}|${options.dashboardUrl}`).slice(0, 10)}`;
  await runCommand("/usr/bin/tmux", ["kill-session", "-t", sessionName], { cwd: options.workspaceRoot });
  const result = await runCommand("/usr/bin/tmux", [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "/bin/sh",
    wrapperPath
  ], {
    cwd: options.workspaceRoot,
    env: dashboardLaunchEnv(options)
  });
  return {
    attempted: true,
    started: result.ok,
    strategy: "tmux",
    detail: result.ok
      ? `tmux session ${sessionName} launched`
      : (result.stderr || result.stdout || result.error || "tmux launch failed").trim(),
    code: result.code,
    session_name: sessionName
  };
}

async function launchViaDetached(options) {
  return new Promise((resolveLaunch) => {
    const child = spawn(
      process.execPath,
      dashboardStartArgs(options).slice(1),
      {
        cwd: options.workspaceRoot,
        detached: true,
        stdio: "ignore",
        env: dashboardLaunchEnv(options),
        windowsHide: true
      }
    );
    let settled = false;
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveLaunch({
        attempted: true,
        started: false,
        strategy: "detached",
        detail: error instanceof Error ? error.message : String(error),
        pid: child.pid ?? null
      });
    });
    child.unref();
    setImmediate(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolveLaunch({
        attempted: true,
        started: true,
        strategy: "detached",
        detail: `spawned detached child pid ${child.pid ?? "unknown"}`,
        pid: child.pid ?? null
      });
    });
  });
}

async function launchWithStrategy(strategy, options) {
  switch (strategy) {
    case "windows-schtasks-wsl":
      return launchViaWindowsSchtasks(options);
    case "systemd-run":
      return launchViaSystemdRun(options);
    case "tmux":
      return launchViaTmux(options);
    case "detached":
      return launchViaDetached(options);
    default:
      return {
        attempted: false,
        strategy,
        detail: `unsupported launch strategy: ${strategy}`
      };
  }
}

export async function ensureDashboardReady({
  dashboardUrl,
  workspaceRoot,
  dbPath,
  runtimeRoot,
  scriptPath,
  expectedRemoteDashboardOrigin = ""
}) {
  const startCommand = dashboardStartCommand({ scriptPath, workspaceRoot, dbPath, dashboardUrl });
  if (!isLocalDashboard(dashboardUrl)) {
    return {
      ok: false,
      reachable: false,
      status: "non_local_dashboard",
      start_command: startCommand,
      launch_attempts: [],
      health_state: null,
      message: "Dashboard auto-start is only supported for local dashboard URLs."
    };
  }

  const initialHealth = await inspectDashboardHealth({
    dashboardUrl,
    workspaceRoot,
    dbPath,
    expectedRemoteDashboardOrigin
  });
  if (initialHealth.healthy) {
      return {
        ok: true,
        reachable: true,
        status: "already_running",
        start_command: startCommand,
        launch_attempts: [],
        health_state: initialHealth,
        message: "Dashboard already running with the expected workspace binding."
      };
  }

  if (initialHealth.reachable && initialHealth.health?.ok) {
    await stopDashboardForPort(dashboardPort(dashboardUrl));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  const strategyOrder = resolveStrategyOrder();
  if (!strategyOrder.length) {
    return {
      ok: false,
      reachable: initialHealth.reachable,
      status: "no_launch_strategy",
      start_command: startCommand,
      launch_attempts: [],
      health_state: initialHealth,
      message: "No compatible dashboard auto-start strategy is available in this host session."
    };
  }

  const launchAttempts = [];
  for (const strategy of strategyOrder) {
    const attempt = await launchWithStrategy(strategy, {
      dashboardUrl,
      workspaceRoot,
      dbPath,
      runtimeRoot,
      scriptPath
    });
    launchAttempts.push(attempt);
    if (!attempt.started) {
      continue;
    }
    const healthState = await waitForHealthyDashboard({
      dashboardUrl,
      workspaceRoot,
      dbPath,
      expectedRemoteDashboardOrigin
    });
    if (healthState.healthy) {
      return {
        ok: true,
        reachable: true,
        status: "started",
        start_command: startCommand,
        launch_strategy: strategy,
        launch_attempts: launchAttempts,
        health_state: healthState,
        message: `Dashboard started via ${strategy}.`
      };
    }
    attempt.health_reason = healthState.reason;
    attempt.health_reachable = healthState.reachable;
  }

  const finalHealth = await inspectDashboardHealth({
    dashboardUrl,
    workspaceRoot,
    dbPath,
    expectedRemoteDashboardOrigin
  });
  const anyStarted = launchAttempts.some((attempt) => attempt.started);
  const status = anyStarted
    ? (
        finalHealth.reachable
          ? (finalHealth.health?.ok ? "started_wrong_binding" : "started_unverified")
          : "started_unverified"
      )
    : "launch_failed";

  return {
    ok: false,
    reachable: finalHealth.reachable,
    status,
    start_command: startCommand,
    launch_attempts: launchAttempts,
    health_state: finalHealth,
    message: anyStarted
      ? "Dashboard launch started but could not be verified with the expected binding."
      : "Dashboard launch could not be started automatically."
  };
}
