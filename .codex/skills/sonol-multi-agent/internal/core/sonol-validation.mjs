function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || ".";
}

function hasCycle(nodes, getEdges) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node) {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }

    visiting.add(node);
    for (const next of getEdges(node)) {
      if (visit(next)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of nodes) {
    if (visit(node)) {
      return true;
    }
  }

  return false;
}

function overlap(left, right) {
  if (left === "." || right === ".") {
    return true;
  }
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pushIssue(target, severity, code, message, details = {}) {
  target.push({ severity, code, message, ...details });
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

export function validateRequestSummaryInput(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return {
      ok: false,
      severity: "error",
      error_code: "MISSING_REQUEST_SUMMARY",
      message: "Missing required flag: --request-summary"
    };
  }
  if (normalized.startsWith("--")) {
    return {
      ok: false,
      severity: "error",
      error_code: "INVALID_REQUEST_SUMMARY",
      message: "The request summary cannot start with a flag-like token."
    };
  }
  if (!/[0-9A-Za-z\u3131-\u318E\uAC00-\uD7A3]/.test(normalized) || normalized.length < 6) {
    return {
      ok: false,
      severity: "error",
      error_code: "INVALID_REQUEST_SUMMARY",
      message: "The request summary is too short or not natural-language text."
    };
  }
  return {
    ok: true,
    normalized
  };
}

export function isStructurallyMultiAgentPlan(plan) {
  const agents = Array.isArray(plan?.agents) ? plan.agents : [];
  const nonMainAgents = agents.filter((agent) => !isMainAgent(agent));
  if (nonMainAgents.length === 0) {
    return false;
  }

  if (agents.length > 1) {
    return true;
  }

  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const edges = Array.isArray(plan?.dependency_edges) ? plan.dependency_edges : [];
  return (
    tasks.length > 1 ||
    edges.length > 0 ||
    nonMainAgents.some((agent) => (agent.depends_on ?? []).length > 0) ||
    nonMainAgents.some((agent) => (agent.assigned_task_ids ?? []).length > 0)
  );
}

function normalizeAdapterDescriptor(adapter) {
  if (!adapter || typeof adapter !== "object") {
    return null;
  }
  const provider = String(adapter.provider ?? "").trim();
  const adapterType = String(adapter.adapter_type ?? "").trim();
  const adapterBackend = String(adapter.adapter_backend ?? "").trim();
  if (!provider && !adapterType && !adapterBackend) {
    return null;
  }
  return {
    provider,
    adapter_type: adapterType,
    adapter_backend: adapterBackend
  };
}

function isInheritedExecutionTarget(target) {
  const provider = String(target?.provider ?? "").trim();
  const backend = String(target?.backend ?? "").trim();
  return (
    !provider ||
    provider === "inherit-run-adapter" ||
    provider === "provider-neutral" ||
    backend === "selected-at-launch"
  );
}

export function validatePlanForAdapter(plan, adapterDescriptor) {
  const descriptor = normalizeAdapterDescriptor(adapterDescriptor);
  const errors = [];
  const warnings = [];
  if (!descriptor) {
    return {
      valid: true,
      errors,
      warnings,
      counts: { errors: 0, warnings: 0 }
    };
  }

  for (const agent of Array.isArray(plan?.agents) ? plan.agents : []) {
    if (!agent?.execution_target) {
      continue;
    }

    if (isInheritedExecutionTarget(agent.execution_target)) {
      continue;
    }

    const targetProvider = String(agent.execution_target.provider ?? "").trim();
    const targetBackend = String(agent.execution_target.backend ?? "").trim();

    if (descriptor.provider && targetProvider && targetProvider !== descriptor.provider) {
      pushIssue(
        errors,
        "error",
        "execution_target_provider_mismatch",
        "계획의 실행 대상 provider와 선택한 adapter provider가 맞지 않습니다.",
        {
          agent_id: agent.agent_id,
          expected_provider: descriptor.provider,
          actual_provider: targetProvider
        }
      );
      continue;
    }

    if (descriptor.adapter_backend && targetBackend && targetBackend !== descriptor.adapter_backend) {
      pushIssue(
        warnings,
        "warning",
        "execution_target_backend_mismatch",
        "계획의 실행 대상 backend와 선택한 adapter backend가 다릅니다.",
        {
          agent_id: agent.agent_id,
          expected_backend: descriptor.adapter_backend,
          actual_backend: targetBackend
        }
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      errors: errors.length,
      warnings: warnings.length
    }
  };
}

export function validatePlan(plan) {
  const errors = [];
  const warnings = [];
  const agents = Array.isArray(plan?.agents) ? plan.agents : [];
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const edges = Array.isArray(plan?.dependency_edges) ? plan.dependency_edges : [];

  const requestSummaryValidation = validateRequestSummaryInput(plan?.request_summary);
  if (!requestSummaryValidation.ok) {
    pushIssue(errors, "error", String(requestSummaryValidation.error_code ?? "request_summary_invalid").toLowerCase(), requestSummaryValidation.message);
  }

  if (agents.length < 1 || agents.length > 6) {
    pushIssue(errors, "error", "agent_count_invalid", "역할 수는 1개 이상 6개 이하여야 합니다.");
  }

  const mainAgents = agents.filter((agent) => isMainAgent(agent));
  if (mainAgents.length !== 1) {
    pushIssue(errors, "error", "main_agent_invalid", "중심 역할은 반드시 1개여야 합니다.");
  }

  const agentIds = agents.map((agent) => agent.agent_id);
  const uniqueAgentIds = new Set(agentIds);
  if (uniqueAgentIds.size !== agentIds.length) {
    pushIssue(errors, "error", "agent_id_duplicate", "역할 ID가 서로 겹치면 안 됩니다.");
  }

  const structuralMulti = isStructurallyMultiAgentPlan(plan);

  if (plan?.single_or_multi === "single" && agents.length > 2) {
    pushIssue(errors, "error", "single_mode_too_many_agents", "단일 흐름 계획에는 많은 역할이 함께 들어갈 수 없습니다.");
  }

  if (plan?.single_or_multi === "multi" && agents.length < 2) {
    pushIssue(errors, "error", "multi_mode_too_few_agents", "여러 역할 흐름에는 2개 이상의 역할이 필요합니다.");
  }

  if (Boolean(plan?.multi_agent_beneficial) !== (plan?.single_or_multi === "multi")) {
    pushIssue(errors, "error", "multi_flag_mismatch", "계획 유형과 추천 상태가 서로 맞지 않습니다.");
  }

  if (structuralMulti && plan?.single_or_multi !== "multi") {
    pushIssue(errors, "error", "structural_multi_mode_mismatch", "에이전트 구성이 실제로는 멀티 에이전트이므로 계획 유형도 multi 여야 합니다.");
  }

  if (structuralMulti && plan?.multi_agent_beneficial !== true) {
    pushIssue(errors, "error", "structural_multi_flag_mismatch", "에이전트 구성이 실제로는 멀티 에이전트이므로 multi_agent_beneficial 이 true 여야 합니다.");
  }

  if (!structuralMulti && plan?.single_or_multi === "multi") {
    pushIssue(warnings, "warning", "multi_without_structure", "계획은 multi 로 표시되어 있지만 실제 하위 에이전트 구조는 거의 없습니다.");
  }

  const agentIdSet = new Set(agentIds);
  for (const agent of agents) {
    const providerAgentType = String(agent.provider_agent_type ?? agent.codex_agent_type ?? "").trim();
    if (!providerAgentType) {
      pushIssue(errors, "error", "provider_agent_type_missing", "모든 역할에는 provider_agent_type 이 필요합니다.", {
        agent_id: agent.agent_id
      });
    }

    if (!String(agent.purpose ?? "").trim()) {
      pushIssue(errors, "error", "agent_purpose_missing", "모든 역할에는 목적 설명이 필요합니다.", {
        agent_id: agent.agent_id
      });
    }

    if (agent.sandbox_mode === "read-only" && Array.isArray(agent.write_paths) && agent.write_paths.length > 0) {
      pushIssue(errors, "error", "read_only_with_write_paths", "읽기 전용 역할에는 수정 가능 위치를 넣을 수 없습니다.", {
        agent_id: agent.agent_id
      });
    }

    if (agent.sandbox_mode !== "read-only" && (!Array.isArray(agent.write_paths) || agent.write_paths.length === 0)) {
      pushIssue(errors, "error", "writer_without_paths", "수정 권한이 있는 역할에는 수정 가능 위치가 필요합니다.", {
        agent_id: agent.agent_id
      });
    }

    if (Array.isArray(agent.assigned_task_ids) && agent.assigned_task_ids.length > 1) {
      pushIssue(errors, "error", "agent_multi_task_unsupported", "현재 Sonol v1 런타임은 한 에이전트의 여러 작업 동시 할당을 지원하지 않습니다.", {
        agent_id: agent.agent_id
      });
    }

    if ((!Array.isArray(agent.assigned_task_ids) || agent.assigned_task_ids.length !== 1)) {
      pushIssue(errors, "error", "agent_task_assignment_missing", "각 역할에는 정확히 1개의 assigned_task_ids 항목이 필요합니다.", {
        agent_id: agent.agent_id
      });
    }

    if (agent.current_task_id) {
      const allowedTaskIds = new Set(Array.isArray(agent.assigned_task_ids) ? agent.assigned_task_ids : []);
      if (allowedTaskIds.size > 0 && !allowedTaskIds.has(agent.current_task_id)) {
        pushIssue(errors, "error", "agent_current_task_mismatch", "현재 작업 ID가 이 에이전트의 할당 작업 목록에 없습니다.", {
          agent_id: agent.agent_id,
          task_id: agent.current_task_id
        });
      }
    } else {
      pushIssue(errors, "error", "agent_current_task_missing", "각 역할에는 current_task_id 가 필요합니다.", {
        agent_id: agent.agent_id
      });
    }

    for (const dependsOn of agent.depends_on ?? []) {
      if (!agentIdSet.has(dependsOn)) {
        pushIssue(errors, "error", "agent_dependency_missing", "선행 작업 역할이 현재 팀 안에 없습니다.", {
          agent_id: agent.agent_id,
          depends_on: dependsOn
        });
      }
      if (dependsOn === agent.agent_id) {
        pushIssue(errors, "error", "agent_dependency_self", "역할이 자기 자신을 기다리도록 설정할 수 없습니다.", {
          agent_id: agent.agent_id
        });
      }
    }

    if (agent.sandbox_mode === "danger-full-access") {
      pushIssue(warnings, "warning", "danger_full_access", "전체 권한이 포함되어 있어 실행 전 한 번 더 확인하는 것이 좋습니다.", {
        agent_id: agent.agent_id
      });
    }
  }

  if (hasCycle(agentIds, (id) => agents.find((agent) => agent.agent_id === id)?.depends_on ?? [])) {
    pushIssue(errors, "error", "agent_dependency_cycle", "역할 사이의 선행 관계가 서로 꼬여 있습니다.");
  }

  const writableAgents = agents.filter((agent) => Array.isArray(agent.write_paths) && agent.write_paths.length > 0);
  for (let index = 0; index < writableAgents.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < writableAgents.length; compareIndex += 1) {
      const left = writableAgents[index];
      const right = writableAgents[compareIndex];
      const leftPaths = left.write_paths.map(normalizePath);
      const rightPaths = right.write_paths.map(normalizePath);

      const hasOverlap = leftPaths.some((leftPath) => rightPaths.some((rightPath) => overlap(leftPath, rightPath)));
      if (hasOverlap) {
        pushIssue(warnings, "warning", "write_scope_overlap", "둘 이상의 역할이 같은 수정 위치를 공유하고 있습니다. 충돌 가능성을 확인해 주세요.", {
          agents: [left.agent_id, right.agent_id]
        });
      }
    }
  }

  const taskIds = tasks.map((task) => task.task_id);
  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    pushIssue(errors, "error", "task_id_duplicate", "작업 ID가 서로 겹치면 안 됩니다.");
  }

  const taskIdSet = new Set(taskIds);
  for (const edge of edges) {
    if (!taskIdSet.has(edge.from) || !taskIdSet.has(edge.to)) {
      pushIssue(errors, "error", "task_dependency_missing", "작업 연결 정보가 현재 작업 목록과 맞지 않습니다.", {
        from: edge.from,
        to: edge.to
      });
    }
    if (edge.from === edge.to) {
      pushIssue(errors, "error", "task_dependency_self", "작업이 자기 자신을 기다리도록 설정할 수 없습니다.", {
        task_id: edge.from
      });
    }
  }

  if (hasCycle(taskIds, (taskId) => edges.filter((edge) => edge.from === taskId).map((edge) => edge.to))) {
    pushIssue(errors, "error", "task_dependency_cycle", "작업 순서가 서로 꼬여 있어 진행할 수 없습니다.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      errors: errors.length,
      warnings: warnings.length
    }
  };
}
