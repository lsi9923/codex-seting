import { buildSubagentPacket as buildBaseSubagentPacket } from "./sonol-bridge.mjs";
import { prepareRunContextFiles } from "./sonol-runtime-context.mjs";

export const CODEX_ADAPTER_TYPE = "codex-conversational-subagent";
export const CODEX_ADAPTER_BACKEND = "codex-conversation";

export const codexAdapter = {
  adapter_type: CODEX_ADAPTER_TYPE,
  adapter_backend: CODEX_ADAPTER_BACKEND,
  provider: "codex",
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
      provider: "codex",
      reportingPreferredMode: "script_commands",
      reportingCommandsSupported: true
    });
    return {
      ...base,
      execution_target: {
        provider: "codex",
        backend: run.adapter_backend,
        profile: agent.provider_agent_type ?? agent.codex_agent_type ?? "default",
        capabilities: ["manual-launch", "runtime-events"]
      },
      reporting_transport: {
        ...base.reporting_transport,
        preferred_mode: "script_commands",
        commands_supported: true
      },
      adapter_guidance: {
        provider: "codex",
        launch_surface: "manual-subagent",
        remote_control_supported: false,
        note: "Codex public runtime does not expose a script-callable spawn API. Launch subagents from the manifest in the current conversation."
      }
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
      note: "Codex public runtime does not expose a script-callable spawn API. Use this manifest as the exact source for assistant-driven subagent launch.",
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
      note: "Codex public runtime does not expose a script-callable spawn API. Launch subagents from the manifest in the current conversation.",
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
      note: "Codex public runtime does not expose a script-callable cancel API. Mark the run cancelled locally and stop assistant-driven subagents manually."
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
