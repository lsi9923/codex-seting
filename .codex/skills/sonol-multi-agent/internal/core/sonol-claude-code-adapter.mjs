import { buildSubagentPacket as buildBaseSubagentPacket } from "./sonol-bridge.mjs";
import { prepareRunContextFiles } from "./sonol-runtime-context.mjs";

export const CLAUDE_ADAPTER_TYPE = "claude-code-subagent";
export const CLAUDE_ADAPTER_BACKEND = "claude-code-manual";

export const claudeCodeAdapter = {
  adapter_type: CLAUDE_ADAPTER_TYPE,
  adapter_backend: CLAUDE_ADAPTER_BACKEND,
  provider: "claude-code",
  capabilities: {
    auto_launch_supported: false,
    remote_cancel_supported: false,
    remote_status_supported: false,
    runtime_reporting: ["script_commands", "json_ingest"]
  },
  prepareRunContext(store, runId, options = {}) {
    return prepareRunContextFiles(store, runId, {
      ...options,
      packetBuilder: (plan, run, agent, packetOptions) => this.buildSubagentPacket(plan, run, agent, packetOptions)
    });
  },
  buildSubagentPacket(plan, run, agent, options = {}) {
    const base = buildBaseSubagentPacket(plan, run, agent, {
      ...options,
      provider: "claude-code",
      reportingPreferredMode: "json_ingest",
      reportingCommandsSupported: true
    });
    return {
      ...base,
      provider: "claude-code",
      provider_agent_type: agent.provider_agent_type ?? agent.codex_agent_type ?? "default",
      execution_target: {
        provider: "claude-code",
        backend: run.adapter_backend,
        profile: agent.provider_agent_type ?? agent.codex_agent_type ?? "default",
        capabilities: ["manual-launch", "runtime-events", "json-ingest"]
      },
      reporting_transport: {
        preferred_mode: "json_ingest",
        helper_skill: "sonol-agent-runtime",
        commands_supported: true,
        json_ingest_supported: Boolean(options.runtimeFiles?.ingest_json_report_script),
        ingest_json_report_script: options.runtimeFiles?.ingest_json_report_script ?? null
      },
      adapter_guidance: {
        provider: "claude-code",
        launch_surface: "manual-subagent",
        remote_control_supported: false,
        note: "Sonol targets Claude Code sidechain subagents through a manual manifest flow and does not call a Claude launch API directly. If a Claude Code subagent finishes but its Sonol completion report is missing, report-main can reconcile from a Claude session file or session id."
      },
      prompt: base.prompt,
      delegation_prompt: base.delegation_prompt
    };
  },
  buildLaunchManifest(store, runId, options = {}) {
    const launchData = store.getRunLaunchCandidates?.(runId) ?? null;
    if (!launchData) {
      return null;
    }

    const { run, plan, candidates } = launchData;
    const runtimeFiles = this.prepareRunContext(store, run.run_id, options);
    const packets = candidates.map((entry) => {
      const agent = plan.agents.find((candidate) => candidate.agent_id === entry.agent_id);
      return agent
        ? {
            ...entry,
            packet: this.buildSubagentPacket(plan, run, agent, { runtimeFiles })
          }
        : null;
    }).filter(Boolean);

    return {
      run_id: run.run_id,
      plan_id: plan.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      candidate_count: packets.length,
      unsupported_auto_spawn: true,
      note: "This Sonol adapter targets Claude Code sidechain subagents only and prepares a manual launch manifest rather than calling a scriptable launch API. Missing completion reports can be reconciled from Claude session data.",
      candidates: packets
    };
  },
  launch(store, runId, options = {}) {
    const run = store.getRun?.(runId) ?? null;
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const runtimeContext = this.prepareRunContext(store, runId, options);
    const manifest = this.buildLaunchManifest(store, runId, { ...options, runtimeFiles: runtimeContext });
    return {
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      dispatch_mode: "manifest_only",
      auto_launch_supported: false,
      next_action: "assistant_launch_from_manifest",
      note: "Use the generated manifest to launch Claude Code sidechain subagents manually in the current conversation. If a Claude Code subagent later finishes without writing Sonol completion, report-main can reconcile from a Claude session file or session id.",
      provider_refs: {
        provider_run_id: null,
        conversation_id: null,
        thread_id: null,
        session_id: null,
        launch_truth_source: "manifest_only",
        status_truth_source: "local_projection",
        launch_surface: "manual-subagent",
        dispatch_mode: "manifest_only",
        status_transport: "local_store_projection",
        remote_status_supported: false,
        remote_cancel_supported: false
      },
      runtime_context: runtimeContext,
      manifest
    };
  },
  cancel(store, runId) {
    const run = store.getRun?.(runId) ?? null;
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return {
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      cancel_supported: false,
      cancel_mode: "local_status_only",
      note: "Claude Code cancellation is not wired to a public scriptable API in this Sonol adapter. Stop the run locally and halt delegated work manually."
    };
  },
  collectStatus(store, runId) {
    const run = store.getRun?.(runId) ?? null;
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const snapshot = store.getSnapshot?.() ?? null;
    const monitor = snapshot?.run_monitors?.find((item) => item.run_id === runId) ?? null;
    const events = store.listEvents?.(runId) ?? [];
    const effectiveProviderRefs = {
      ...(run.provider_refs ?? {}),
      launch_truth_source: run.provider_refs?.launch_truth_source && run.provider_refs.launch_truth_source !== "none"
        ? run.provider_refs.launch_truth_source
        : "manifest_only",
      status_truth_source: "local_projection",
      launch_surface: run.provider_refs?.launch_surface ?? "manual-subagent",
      dispatch_mode: run.provider_refs?.dispatch_mode ?? "manifest_only",
      status_transport: run.provider_refs?.status_transport ?? "local_store_projection",
      remote_status_supported: false,
      remote_cancel_supported: false
    };
    return {
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      transport: "local_store_projection",
      provider_refs: effectiveProviderRefs,
      launch_truth_source: effectiveProviderRefs.launch_truth_source,
      status_truth_source: "local_projection",
      status_transport: effectiveProviderRefs.status_transport,
      remote_control_supported: false,
      run_status: monitor?.status ?? run.status,
      latest_event_type: events.at(-1)?.event_type ?? null,
      latest_event_id: events.at(-1)?.payload?.event_id ?? null,
      monitor_state: monitor?.status ?? null,
      agent_states: monitor?.agent_states ?? []
    };
  }
};
