export const SUPPORTED_LANGUAGES = ["ko", "en"];

export function normalizePreferredLanguage(value, fallback = "ko") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];

  if (normalized === "en") {
    return "en";
  }

  if (normalized === "ko") {
    return "ko";
  }

  return fallback === "en" ? "en" : "ko";
}

export function detectPreferredLanguage(value, fallback = "en") {
  if (typeof value !== "string" || !value.trim()) {
    return normalizePreferredLanguage(fallback, "ko");
  }

  if (/[가-힣]/.test(value)) {
    return "ko";
  }

  return "en";
}

export function localize(language, ko, en) {
  return normalizePreferredLanguage(language, "ko") === "en" ? en : ko;
}

export function preferredLanguageName(language) {
  return normalizePreferredLanguage(language, "ko") === "en" ? "English" : "Korean";
}

export function rolePurpose(role, language) {
  switch (role) {
    case "Main":
      return localize(language, "다른 역할의 결과를 하나로 정리하고 최종 결과를 사용자에게 전달합니다.", "Integrates results from other roles and delivers the final result to the user.");
    case "Planner":
      return localize(language, "요청을 실행 흐름으로 나누고 순서와 체크포인트를 정리합니다.", "Breaks the request into an execution flow and defines order and checkpoints.");
    case "Research":
      return localize(language, "필요한 정보와 제약, 선택지를 찾아 핵심만 정리합니다.", "Finds the relevant facts, constraints, and options, then summarizes only what matters.");
    case "Code":
      return localize(language, "실제 수정이나 구현 작업을 맡습니다.", "Owns the direct implementation and file changes.");
    case "Test":
      return localize(language, "동작 확인과 검증을 진행하고 문제를 찾습니다.", "Validates behavior and looks for issues or regressions.");
    case "Reviewer":
      return localize(language, "문제점, 위험, 놓친 부분이 없는지 최종 점검합니다.", "Performs a final review for issues, risk, and missing validation.");
    case "Docs":
      return localize(language, "설명 문서와 사용자용 안내를 정리합니다.", "Prepares explanatory documentation and user-facing guidance.");
    case "Refactor":
      return localize(language, "의도한 동작은 유지하면서 구조를 더 읽기 쉽게 다듬습니다.", "Improves readability and maintainability while preserving intended behavior.");
    default:
      return localize(language, "실행 환경, 연결 상태, 운영 관련 점검을 맡습니다.", "Checks runtime environment, connectivity, and operational concerns.");
  }
}

export function roleInstructions(role, language) {
  switch (role) {
    case "Main":
      return localize(language, "최종 정리를 맡습니다. 결과를 합치고 충돌을 정리해 하나의 결과로 마무리하세요.", "Own final integration. Combine results, resolve conflicts, and finish with one coherent outcome.");
    case "Planner":
      return localize(language, "계획 역할에 집중하세요. 작업 분해, 순서, 검증 시점을 먼저 분명히 하세요.", "Focus on planning. Clarify decomposition, ordering, and validation points before execution.");
    case "Research":
      return localize(language, "읽기와 조사에 집중하세요. 근거와 제약을 찾고, 긴 원문 대신 핵심만 정리해서 전달하세요.", "Focus on reading and research. Find the evidence and constraints, then summarize only the key points.");
    case "Code":
      return localize(language, "합의된 범위 안에서만 수정하세요. 범위를 넓혀야 하면 이유를 먼저 알리세요.", "Edit only within the agreed scope. If the scope must expand, explain why first.");
    case "Test":
      return localize(language, "동작을 검증하고 회귀 문제를 찾으세요. 통과와 실패 근거를 분명히 남기세요.", "Verify behavior and look for regressions. Leave clear pass and fail evidence.");
    case "Reviewer":
      return localize(language, "정확성, 회귀 위험, 빠진 검증이 없는지 점검하세요. 바로 조치할 수 있는 내용부터 정리하세요.", "Check correctness, regression risk, and missing validation. Start with the highest-signal findings.");
    case "Docs":
      return localize(language, "실제 구현과 맞는 설명만 간결하게 정리하세요.", "Keep documentation concise and aligned with the actual implementation.");
    case "Refactor":
      return localize(language, "동작은 유지한 채 더 읽기 쉽고 관리하기 좋게 정리하세요.", "Keep behavior intact while making the structure easier to read and maintain.");
    default:
      return localize(language, "실행 연결, 운영 안정성, 상태 확인에 집중하세요.", "Focus on runtime connectivity, operational stability, and state visibility.");
  }
}

export function operationalConstraints(language) {
  return [
    localize(language, "Sonol runtime reporting 규칙을 따라야 합니다.", "You must follow Sonol runtime reporting rules."),
    localize(language, "작업 범위를 넓혀야 하면 이유를 먼저 알려야 합니다.", "Explain why before expanding scope."),
    localize(language, "경로 제한은 반드시 지켜야 하는 협업 규칙입니다.", "Path limits are hard coordination rules."),
    localize(language, "v1에서는 하위 에이전트를 다시 만들면 안 됩니다.", "Do not spawn child agents in v1.")
  ];
}

export function taskTitle(taskId, requestSummary, language) {
  if (taskId === "task_main_integrate") {
    return localize(language, "Main 에이전트 최종 통합", "Main agent integrates results");
  }

  if (taskId === "task_single_execute") {
    return localize(language, `단일 에이전트 실행: ${requestSummary}`, `single-agent execution for: ${requestSummary}`);
  }

  const key = taskId.replace(/^task_/, "").replace(/_/g, " ");
  return localize(language, `${key} 작업: ${requestSummary}`, `${key} for: ${requestSummary}`);
}

export function buildRecommendationSummary(singleOrMulti, agentCount, language) {
  if (singleOrMulti === "single") {
    return localize(language, "이번 요청은 여러 역할로 나누는 것보다 일반 방식으로 진행하는 편이 더 간단합니다.", "This request is simpler to handle in the normal single-agent flow.");
  }

  return localize(
    language,
    `여러 에이전트로 나눠 진행하는 편이 좋습니다. 총 ${agentCount}개의 에이전트 초안이면 조사, 구현, 검증, 정리를 무리 없이 분담할 수 있습니다.`,
    `Multi-agent orchestration is a better fit. A draft with ${agentCount} agents can distribute research, implementation, validation, and synthesis without overloading one thread.`
  );
}

export function buildOperatorMessage(singleOrMulti, dashboardUrl, language) {
  return singleOrMulti === "multi"
    ? localize(language, `대시보드에서 에이전트 초안을 확인하고 필요하면 수정한 뒤 승인하세요. 마지막 실행은 터미널에서 확정합니다. 대시보드: ${dashboardUrl}`, `Review the agent draft in the dashboard, edit it if needed, then approve it there. Final execution is confirmed in the terminal. Dashboard: ${dashboardUrl}`)
    : localize(language, "일반 방식으로 바로 진행하면 됩니다. 이번 요청에서는 여러 역할 구성이 꼭 필요하지 않습니다.", "Proceed in the normal flow. A multi-agent setup is not necessary for this request.");
}

export function recommendationReasons(singleOrMulti, agentCount, language) {
  return [
    localize(language, `요청 복잡도와 포함된 작업 성격을 기준으로 총 ${agentCount}개의 에이전트 초안을 구성했습니다.`, `Built a draft with ${agentCount} agents based on request complexity and task mix.`),
    singleOrMulti === "single"
      ? localize(language, "작업 흐름이 비교적 짧아 하나의 중심 흐름으로도 충분합니다.", "The workflow is short enough that one primary thread is sufficient.")
      : localize(language, "병렬로 분리할 작업과 순차 의존 작업이 함께 보여, 자율 초안 뒤에 사용자 조정이 가능한 멀티 에이전트 구성이 더 적합합니다.", "The request mixes parallelizable work and sequential dependencies, so a multi-agent draft with later user edits is a better fit.")
  ];
}

export function runtimeDefaultPhrases(language) {
  return {
    startMessage: localize(language, "시작", "Start"),
    startDetail: localize(language, "무엇을 시작했고 무엇을 먼저 확인하는지 적으세요.", "Describe what you started and what you are checking first."),
    progressMessage: localize(language, "작업 진행", "Progress update"),
    progressDetail: localize(language, "바뀐 내용과 다음 단계를 1~3문장으로 적으세요.", "Describe what changed and what comes next in 1 to 3 short sentences."),
    idleMessage: localize(language, "다음 작업 대기", "Waiting next task"),
    idleDetail: localize(language, "현재 단위 작업이 끝났고 다음 지시를 기다립니다.", "The current work unit is done. Waiting for the next instruction."),
    completionSummary: localize(language, "완료", "Done"),
    completionDetail: localize(language, "무엇을 끝냈고 다음에 무엇이 이어져야 하는지 적으세요.", "Describe what was finished and what should happen next."),
    launchMessage: localize(language, "작업 지시 전달됨", "Work packet delivered"),
    launchDetail: localize(language, "현재 run 컨텍스트와 command file을 전달했습니다. 첫 progress 보고를 기다립니다.", "Delivered the current run context and command file. Waiting for the first progress report."),
    missingReportMessage: localize(language, "보고 시작 대기", "Waiting for first report"),
    missingReportReason: localize(language, "정해진 시간 안에 상태 보고가 없습니다.", "No status report was received within the expected window.")
  };
}
