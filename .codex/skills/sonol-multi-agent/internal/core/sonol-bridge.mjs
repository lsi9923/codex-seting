import { preferredLanguageName, runtimeDefaultPhrases } from "./sonol-language.mjs";
import { skillScriptPath } from "./sonol-runtime-paths.mjs";

function formatPaths(paths) {
  return paths.length ? paths.map((path) => `- ${path}`).join("\n") : "- none";
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

function inferAssignedTasks(plan, agent) {
  if (Array.isArray(agent.assigned_task_ids) && agent.assigned_task_ids.length > 0) {
    return [...agent.assigned_task_ids];
  }

  if (isMainAgent(agent)) {
    return plan.tasks
      .filter((task) => task.task_id === "task_main_integrate" || task.task_id === "task_single_execute")
      .map((task) => task.task_id);
  }
  return [];
}

function mergedSkillsConfig(agent) {
  const base = Array.isArray(agent.skills_config) ? agent.skills_config : [];
  return Array.from(new Set([
    ...base,
    ...(isMainAgent(agent) ? [] : ["sonol-agent-runtime"])
  ].filter(Boolean)));
}

function mainReporterIdentityArgs(run) {
  const refs = run?.provider_refs ?? {};
  const args = [];
  if (refs.main_provider_session_kind === "claude-code") {
    if (refs.main_provider_session_id) {
      args.push(`--provider-session-id ${JSON.stringify(refs.main_provider_session_id)}`);
    }
    if (refs.main_provider_session_file) {
      args.push(`--provider-session-file ${JSON.stringify(refs.main_provider_session_file)}`);
    }
  } else if (refs.main_provider_session_kind === "codex" && refs.main_provider_session_thread_id) {
    args.push(`--provider-session-thread-id ${JSON.stringify(refs.main_provider_session_thread_id)}`);
  }
  return args;
}

function buildMainReportCommand({
  run,
  runtimeFiles,
  type,
  taskId,
  stepIndex = 1,
  totalSteps = 3,
  state = "running",
  status = "idle",
  result = "success",
  message = "",
  detail = "",
  summary = "",
  nextActions = "handoff"
}) {
  const reportMainScript = skillScriptPath("sonol-multi-agent", "report-main.mjs");
  const args = [
    `node ${JSON.stringify(reportMainScript)}`,
    runtimeFiles?.db_path ? `--db ${JSON.stringify(runtimeFiles.db_path)}` : "",
    `--run-id ${JSON.stringify(run.run_id)}`,
    ...mainReporterIdentityArgs(run),
    `--type ${type}`
  ];
  if (type === "progress") {
    args.push(
      `--step-index ${Number(stepIndex)}`,
      `--total-steps ${Number(totalSteps)}`,
      `--state ${JSON.stringify(state)}`,
      `--message ${JSON.stringify(message)}`,
      `--detail ${JSON.stringify(detail)}`
    );
  } else if (type === "session") {
    args.push(
      `--status ${JSON.stringify(status)}`,
      `--message ${JSON.stringify(message)}`,
      `--detail ${JSON.stringify(detail)}`
    );
  } else if (type === "completion") {
    args.push(
      `--result ${JSON.stringify(result)}`,
      `--summary ${JSON.stringify(summary)}`,
      `--detail ${JSON.stringify(detail)}`,
      `--next-actions ${JSON.stringify(nextActions)}`,
      "--auto-reconcile-completed-agents true"
    );
  }
  if (taskId) {
    args.push(`--task-id ${JSON.stringify(taskId)}`);
  }
  return args.filter(Boolean).join(" ");
}

export function buildSubagentPacket(plan, run, agent, options = {}) {
  const dependentAgents = plan.agents.filter((candidate) =>
    agent.depends_on.includes(candidate.agent_id)
  );
  const assignedTaskIds = inferAssignedTasks(plan, agent);
  const currentTaskId = assignedTaskIds[0] ?? null;
  const runtimeFiles = options.runtimeFiles ?? null;
  const agentRuntimeFiles = runtimeFiles?.agents?.find((item) => item.agent_id === agent.agent_id) ?? null;

  const language = agent.preferred_language ?? plan.preferred_language ?? "ko";
  const phrases = runtimeDefaultPhrases(language);
  const adapterProvider = String(options.provider ?? run?.adapter_type ?? run?.adapter_backend ?? "manual").trim();
  const reportingPreferredMode = options.reportingPreferredMode ?? "script_commands";
  const reportingCommandsSupported = options.reportingCommandsSupported ?? true;
  const dbPathArg = runtimeFiles?.db_path ? `--db ${JSON.stringify(runtimeFiles.db_path)}` : "";
  const progressScript = skillScriptPath("sonol-agent-runtime", "report-progress.mjs");
  const completionScript = skillScriptPath("sonol-agent-runtime", "report-completion.mjs");
  const sessionScript = skillScriptPath("sonol-agent-runtime", "report-session.mjs");
  const ingestJsonScript = skillScriptPath("sonol-agent-runtime", "ingest-json-report.mjs");
  const providerAgentType = agent.provider_agent_type ?? agent.codex_agent_type ?? "default";
  const effectiveSkillsConfig = mergedSkillsConfig(agent);
  const mainAgent = isMainAgent(agent);
  if (!currentTaskId) {
    throw new Error(
      `Agent ${agent.agent_id} does not have a current task id. Generate the packet only after the plan assigns exactly one current task to this agent.`
    );
  }
  const reportingTransportLine = reportingPreferredMode === "json_ingest"
    ? `Preferred transport: JSON ingest via ${ingestJsonScript}. Use direct report-* commands only as an adapter-local fallback when explicitly available.`
    : `Preferred transport: direct report-* commands when available, otherwise JSON ingest via ${ingestJsonScript}.`;
  const prompt = [
    `You are participating in Sonol multi-agent run ${run.run_id}.`,
    `Use the generated Sonol runtime reporting transport.`,
    reportingTransportLine,
    `Read these files before work:`,
    `- ${runtimeFiles?.plan_summary_file ?? "plan summary file missing"}`,
    `- ${runtimeFiles?.shared_instructions_file ?? "shared instructions file missing"}`,
    `- ${agentRuntimeFiles?.agent_file ?? "agent file missing"}`,
    `- ${agentRuntimeFiles?.command_file ?? "command file missing"}`,
    `- ${agentRuntimeFiles?.prompt_file ?? "run prompt file missing"}`,
    `Emit the first progress report immediately when work starts.`,
    `Then report each meaningful small work unit before moving on.`,
    `Keep runtime messages short and factual.`,
    `Use ${preferredLanguageName(language)} for user-facing status reports and summaries unless the Main agent explicitly changes that requirement.`,
    `Do not return runtime JSON in your final answer.`,
    `Current task: ${currentTaskId ?? "none"}`,
    `Dependencies: ${dependentAgents.length ? dependentAgents.map((item) => item.agent_id).join(", ") : "none"}`,
    `Use schema_version 1.0.0 in all runtime events.`
  ].join("\n");

  const startCommand = mainAgent
    ? buildMainReportCommand({
        run,
        runtimeFiles,
        type: "progress",
        taskId: currentTaskId,
        stepIndex: 1,
        totalSteps: 3,
        state: "running",
        message: phrases.startMessage,
        detail: phrases.startDetail
      })
    : currentTaskId
      ? [
          `node ${JSON.stringify(progressScript)}`,
          dbPathArg,
          `--plan-id ${JSON.stringify(plan.plan_id)}`,
          `--run-id ${JSON.stringify(run.run_id)}`,
          `--agent-id ${JSON.stringify(agent.agent_id)}`,
          `--task-id ${JSON.stringify(currentTaskId)}`,
          "--step-index 1 --total-steps 3 --state running",
          `--message ${JSON.stringify(phrases.startMessage)}`,
          `--detail ${JSON.stringify(phrases.startDetail)}`
        ].join(" ")
      : "";

  const completionCommand = mainAgent
    ? buildMainReportCommand({
        run,
        runtimeFiles,
        type: "completion",
        taskId: currentTaskId,
        result: "success",
        summary: phrases.completionSummary,
        detail: phrases.completionDetail,
        nextActions: "handoff"
      })
    : [
        `node ${JSON.stringify(completionScript)}`,
        dbPathArg,
        `--plan-id ${JSON.stringify(plan.plan_id)}`,
        `--run-id ${JSON.stringify(run.run_id)}`,
        `--agent-id ${JSON.stringify(agent.agent_id)}`,
        currentTaskId ? `--task-id ${JSON.stringify(currentTaskId)}` : "",
        '--result success',
        `--summary ${JSON.stringify(phrases.completionSummary)}`,
        `--detail ${JSON.stringify(phrases.completionDetail)}`,
        '--next-actions "handoff"'
      ].filter(Boolean).join(" ");

  const launchAckCommand = [
    `node ${JSON.stringify(sessionScript)}`,
    dbPathArg,
    `--plan-id ${JSON.stringify(plan.plan_id)}`,
    `--run-id ${JSON.stringify(run.run_id)}`,
    `--agent-id ${JSON.stringify(agent.agent_id)}`,
    currentTaskId ? `--task-id ${JSON.stringify(currentTaskId)}` : "",
    "--status running",
    `--message ${JSON.stringify(phrases.launchMessage)}`,
    `--detail ${JSON.stringify(phrases.launchDetail)}`
  ].filter(Boolean).join(" ");

  const idleCommand = mainAgent
    ? buildMainReportCommand({
        run,
        runtimeFiles,
        type: "session",
        taskId: currentTaskId,
        status: "idle",
        message: phrases.idleMessage,
        detail: phrases.idleDetail
      })
    : [
        `node ${JSON.stringify(sessionScript)}`,
        dbPathArg,
        `--plan-id ${JSON.stringify(plan.plan_id)}`,
        `--run-id ${JSON.stringify(run.run_id)}`,
        `--agent-id ${JSON.stringify(agent.agent_id)}`,
        currentTaskId ? `--task-id ${JSON.stringify(currentTaskId)}` : "",
        "--status idle",
        `--message ${JSON.stringify(phrases.idleMessage)}`,
        `--detail ${JSON.stringify(phrases.idleDetail)}`
      ].filter(Boolean).join(" ");

  const delegationPrompt = [
    `You are ${agent.agent_id} for Sonol multi-agent run ${run.run_id}.`,
    `Do not invent or change plan_id/run_id/agent_id. Use exactly plan_id=${plan.plan_id}, run_id=${run.run_id} and agent_id=${agent.agent_id}.`,
    `Role: ${agent.role}`,
    `Execution class: ${normalizeExecutionClass(agent)}`,
    `Provider agent type: ${providerAgentType}`,
    `Purpose: ${agent.purpose}`,
    `Current task id: ${currentTaskId ?? "none"}`,
    `Dependencies: ${dependentAgents.length ? dependentAgents.map((item) => item.agent_id).join(", ") : "none"}`,
    `Preferred user language: ${preferredLanguageName(language)}`,
    `Model: ${agent.model}`,
    `Reasoning: ${agent.model_reasoning_effort}`,
    `Sandbox: ${agent.sandbox_mode}`,
    `Skills: ${effectiveSkillsConfig.length ? effectiveSkillsConfig.join(", ") : "none"}`,
    `Read before work:`,
    `- ${runtimeFiles?.plan_summary_file ?? "plan summary file missing"}`,
    `- ${runtimeFiles?.shared_instructions_file ?? "shared instructions file missing"}`,
    `- ${agentRuntimeFiles?.agent_file ?? "agent file missing"}`,
    `- ${agentRuntimeFiles?.command_file ?? "command file missing"}`,
    `- ${agentRuntimeFiles?.prompt_file ?? "run prompt file missing"}`,
    `Alternate launcher files: ${agentRuntimeFiles?.command_files ? Object.values(agentRuntimeFiles.command_files).join(", ") : "none"}`,
    `If you were given an older prompt from another run, ignore it and use this current run prompt only.`,
    `Run-scoped immutable prompt file: ${agentRuntimeFiles?.prompt_file ?? "run prompt file missing"}`,
    `Write user-facing progress messages, completion summaries, and normal explanations in ${preferredLanguageName(language)} unless the Main agent explicitly instructs otherwise.`,
    `Manifest-only launch invariant: fork_context=false. Do not inherit stale parent conversation context into this child launch.`,
    `Sandbox, MCP, skills, and path restrictions are Sonol coordination policy unless the host launch surface enforces them natively.`,
    `At work start, run exactly this command:`,
    startCommand,
    `When your current unit is done but you are waiting, run this command:`,
    idleCommand,
    `When finished, run exactly this command:`,
    completionCommand,
    `Do not run launch_ack_command yourself. The Main agent records launch acknowledgement after delegation.`,
    mainAgent
      ? `Use report-main.mjs only. Do not use generic sonol-agent-runtime report-* scripts or JSON ingest for agent_main.`
      : `Never call report-main.mjs. That script is reserved for agent_main only.`,
    mainAgent
      ? `The generated report-main.mjs commands already embed the required main-session identity.`
      : `If local helper commands are unavailable, send the same events through ${ingestJsonScript} using the exact same identifiers.`,
    `Final answer must summarize your findings or changes, but do not emit runtime JSON in the final answer.`
  ].join("\n");

  const assistantLaunchRecipe = {
    launch_surface: adapterProvider === "codex" ? "spawn_agent" : "manual-subagent",
    requires_exact_prompt: true,
    prompt_source: agentRuntimeFiles?.prompt_file ?? null,
    exact_message: delegationPrompt,
    recommended_agent_type: providerAgentType,
    recommended_model: agent.model,
    recommended_reasoning_effort: agent.model_reasoning_effort,
    fork_context: false,
    notes: adapterProvider === "codex"
      ? [
          "Use spawn_agent with the exact generated message.",
          "The launch recipe can pin model, reasoning, and fork_context. Sandbox, MCP, skills, and path restrictions remain Sonol policy unless the host surface enforces them natively.",
          "Immediately after spawn_agent returns, run launch_ack_command so Sonol knows the agent was actually launched.",
          "Do not rewrite the role prompt.",
          "Do not drop the embedded report-* commands.",
          "Do not run launch_ack_command inside the child thread.",
          "Sub-agents must never call report-main.mjs."
        ]
      : [
          "Launch the provider sub-agent from the generated run-scoped prompt file.",
          "Sandbox, MCP, skills, and path restrictions remain Sonol policy unless the host surface enforces them natively.",
          "Immediately after manual launch, run launch_ack_command so Sonol knows the agent was actually launched.",
          "Do not rewrite the role prompt.",
          "Do not drop the embedded report-* commands.",
          "Do not run launch_ack_command inside the child thread.",
          "Sub-agents must never call report-main.mjs."
        ]
  };

  if (adapterProvider === "codex") {
    assistantLaunchRecipe.tool_name = "spawn_agent";
    assistantLaunchRecipe.tool_args = {
      agent_type: providerAgentType,
      fork_context: false,
      model: agent.model,
      reasoning_effort: agent.model_reasoning_effort,
      message: delegationPrompt
    };
  }

  return {
    run_id: run.run_id,
    plan_id: plan.plan_id,
    agent_id: agent.agent_id,
    role: agent.role,
    role_label: agent.role_label ?? agent.role,
    execution_class: normalizeExecutionClass(agent),
    provider_agent_type: providerAgentType,
    provider: adapterProvider,
    workstream_id: agent.workstream_id ?? null,
    selection_rationale: agent.selection_rationale ?? null,
    ...(agent.codex_agent_type ? { codex_agent_type: agent.codex_agent_type } : {}),
    model: agent.model,
    model_reasoning_effort: agent.model_reasoning_effort,
    sandbox_mode: agent.sandbox_mode,
    mcp_servers: agent.mcp_servers,
    skills_config: effectiveSkillsConfig,
    nickname_candidates: agent.nickname_candidates,
    approval_mode: agent.approval_mode,
    communication_mode: agent.communication_mode,
    reporting_contract: agent.reporting_contract,
    depends_on: agent.depends_on,
    execution_mode: agent.execution_mode,
    assigned_task_ids: assignedTaskIds,
    current_task_id: currentTaskId,
    runtime_context_root: runtimeFiles?.root_dir ?? null,
    runtime_plan_summary_file: runtimeFiles?.plan_summary_file ?? null,
    runtime_shared_instructions_file: runtimeFiles?.shared_instructions_file ?? null,
    runtime_ingest_json_report_script: runtimeFiles?.ingest_json_report_script ?? ingestJsonScript,
    runtime_agent_file: agentRuntimeFiles?.agent_file ?? null,
    runtime_command_file: agentRuntimeFiles?.command_file ?? null,
    runtime_command_files: agentRuntimeFiles?.command_files ?? null,
    runtime_prompt_file: agentRuntimeFiles?.prompt_file ?? null,
    launch_ack_command: launchAckCommand,
    start_report_command: startCommand,
    idle_report_command: idleCommand,
    completion_report_command: completionCommand,
    assistant_launch_recipe: assistantLaunchRecipe,
    reporting_transport: {
      preferred_mode: reportingPreferredMode,
      helper_skill: mainAgent ? "sonol-multi-agent" : "sonol-agent-runtime",
      commands_supported: reportingCommandsSupported,
      json_ingest_supported: true,
      ingest_json_report_script: runtimeFiles?.ingest_json_report_script ?? ingestJsonScript
    },
    delegation_prompt: delegationPrompt,
    read_paths: agent.read_paths,
    write_paths: agent.write_paths,
    deny_paths: agent.deny_paths,
    prompt
  };
}
