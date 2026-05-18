import { appendStructuredLog } from "./sonol-log.mjs";
import { writeRunAuthorityArtifacts } from "./sonol-authority-artifacts.mjs";
import { CLAUDE_ADAPTER_BACKEND, CLAUDE_ADAPTER_TYPE, claudeCodeAdapter } from "./sonol-claude-code-adapter.mjs";
import { CODEX_ADAPTER_BACKEND, CODEX_ADAPTER_TYPE, codexAdapter } from "./sonol-codex-adapter.mjs";
import { inferAdapterConfigForWorkspace } from "./sonol-provider-session.mjs";

const REGISTRY = new Map([
  [`${CODEX_ADAPTER_TYPE}:${CODEX_ADAPTER_BACKEND}`, codexAdapter],
  [`${CLAUDE_ADAPTER_TYPE}:${CLAUDE_ADAPTER_BACKEND}`, claudeCodeAdapter]
]);

export function defaultAdapterConfig(options = {}) {
  const envType = process.env.SONOL_DEFAULT_ADAPTER_TYPE;
  const envBackend = process.env.SONOL_DEFAULT_ADAPTER_BACKEND;
  if (envType && envBackend && REGISTRY.has(`${envType}:${envBackend}`)) {
    return {
      adapter_type: envType,
      adapter_backend: envBackend
    };
  }
  const inferred = inferAdapterConfigForWorkspace({ workspaceRoot: options.workspaceRoot ?? null });
  if (inferred && REGISTRY.has(`${inferred.adapter_type}:${inferred.adapter_backend}`)) {
    return {
      adapter_type: inferred.adapter_type,
      adapter_backend: inferred.adapter_backend
    };
  }
  return {
    adapter_type: CODEX_ADAPTER_TYPE,
    adapter_backend: CODEX_ADAPTER_BACKEND
  };
}

export function getAdapter(adapterType = CODEX_ADAPTER_TYPE, adapterBackend = CODEX_ADAPTER_BACKEND) {
  return REGISTRY.get(`${adapterType}:${adapterBackend}`) ?? null;
}

export function listAdapters() {
  const defaults = defaultAdapterConfig();
  return Array.from(REGISTRY.values()).map((adapter) => ({
    adapter_type: adapter.adapter_type,
    adapter_backend: adapter.adapter_backend,
    provider: adapter.provider,
    default_for_install: adapter.adapter_type === defaults.adapter_type && adapter.adapter_backend === defaults.adapter_backend,
    capabilities: {
      auto_launch_supported: adapter.capabilities?.auto_launch_supported ?? false,
      remote_cancel_supported: adapter.capabilities?.remote_cancel_supported ?? false,
      remote_status_supported: adapter.capabilities?.remote_status_supported ?? false,
      runtime_reporting: adapter.capabilities?.runtime_reporting ?? ["script_commands", "json_ingest"]
    }
  }));
}

export function getAdapterCapabilities(adapterType = CODEX_ADAPTER_TYPE, adapterBackend = CODEX_ADAPTER_BACKEND) {
  const adapter = getAdapter(adapterType, adapterBackend);
  return {
    auto_launch_supported: adapter?.capabilities?.auto_launch_supported ?? false,
    remote_cancel_supported: adapter?.capabilities?.remote_cancel_supported ?? false,
    remote_status_supported: adapter?.capabilities?.remote_status_supported ?? false,
    runtime_reporting: adapter?.capabilities?.runtime_reporting ?? ["script_commands", "json_ingest"]
  };
}

export function requireAdapter(adapterType = CODEX_ADAPTER_TYPE, adapterBackend = CODEX_ADAPTER_BACKEND) {
  const adapter = getAdapter(adapterType, adapterBackend);
  if (!adapter) {
    throw new Error(`Unsupported adapter: ${adapterType}:${adapterBackend}`);
  }
  return adapter;
}

export function adapterForRun(run) {
  return requireAdapter(run?.adapter_type, run?.adapter_backend);
}

export function prepareRunContextForRun(store, run, options = {}) {
  return adapterForRun(run).prepareRunContext(store, run.run_id, options);
}

export function buildLaunchManifestForRun(store, run, options = {}) {
  return adapterForRun(run).buildLaunchManifest(store, run.run_id, options);
}

export function buildAgentPacketForRun(run, plan, agent, options = {}) {
  return adapterForRun(run).buildSubagentPacket(plan, run, agent, options);
}

export function launchRunWithAdapter(store, run, options = {}) {
  const adapter = adapterForRun(run);
  const dispatch = adapter.launch(store, run.run_id, options);
  writeRunAuthorityArtifacts({ run, dispatch });
  if (dispatch?.runtime_context || dispatch?.provider_refs) {
    const current = store.getRun?.(run.run_id) ?? run;
    try {
      store.saveRun?.({
        ...current,
        provider_refs: {
          ...(current.provider_refs ?? {}),
          ...(dispatch.provider_refs ?? {})
        },
        runtime_bindings: {
          binding_id: current.runtime_bindings?.binding_id ?? null,
          workspace_id: current.workspace_id ?? null,
          db_path: dispatch.runtime_context?.db_path ?? current.runtime_bindings?.db_path ?? null,
          runtime_root: dispatch.runtime_context?.root_dir ?? current.runtime_bindings?.runtime_root ?? null
        }
      }, {
        expectedUpdatedAt: current.updated_at ?? null
      });
    } catch {
    }
  }
  if (options.log !== false) {
    appendStructuredLog("sonol-runtime", {
      action: "adapter_launch_prepared",
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      dispatch_mode: dispatch?.dispatch_mode ?? null,
      auto_launch_supported: dispatch?.auto_launch_supported ?? null,
      next_action: dispatch?.next_action ?? null
    });
  }
  return dispatch;
}

export function cancelRunWithAdapter(store, run, options = {}) {
  const adapter = adapterForRun(run);
  const cancellation = adapter.cancel(store, run.run_id, options);
  if (options.log !== false) {
    appendStructuredLog("sonol-runtime", {
      action: "adapter_cancel_requested",
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      cancel_supported: cancellation?.cancel_supported ?? null,
      cancel_mode: cancellation?.cancel_mode ?? null
    });
  }
  return cancellation;
}

export function collectAdapterStatusForRun(store, run, options = {}) {
  const adapter = adapterForRun(run);
  const status = adapter.collectStatus(store, run.run_id, options);
  if (options.log !== false) {
    appendStructuredLog("sonol-runtime", {
      action: "adapter_status_collected",
      run_id: run.run_id,
      plan_id: run.plan_id,
      adapter_type: run.adapter_type,
      adapter_backend: run.adapter_backend,
      run_status: status?.run_status ?? null,
      monitor_state: status?.monitor_state ?? null,
      latest_event_type: status?.latest_event_type ?? null
    });
  }
  return status;
}
