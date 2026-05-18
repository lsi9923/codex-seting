# 에이전트 상태 머신 설계

## 상태 정의
```
idle → thinking → walking_to_ceo → reporting → walking_home → working → idle
```

| 상태 | 스프라이트 행 | LED 색상 | 말풍선 내용 |
|------|------------|---------|-----------|
| idle | row 1 (idle) | 어두운 회색 | AGENT_THOUGHTS 랜덤 |
| thinking | row 2 (work) | #ffab40 (주황) | 작업 요약 |
| walking_to_ceo | row 2 (walk) | #22D3EE (청록) | "CEO에게 이동 중..." |
| reporting | row 2 (work) | 에이전트 색상 | "보고: {task}..." |
| walking_home | row 2 (walk) | #22D3EE (청록) | "자리로 복귀 중..." |
| working | row 2 (work) | 에이전트 색상 | ROLE_WORK_MESSAGES 랜덤 |

## 이동 보간 (RAF + useRef 패턴)

`useRef`로 에이전트 위치를 추적하고 RAF에서 lerp 계산 후 `setState`로 렌더 트리거.
`useState`에서 직접 계산하면 리렌더가 과도하게 발생한다.

```typescript
const agentsRef = useRef<AgentStatus[]>(initialAgents);
const completedTasksRef = useRef<Record<string, CompletedTask[]>>({});

const animate = (now: number) => {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  agentsRef.current = agentsRef.current.map(a => {
    if (!a.isWalking) return a;
    const newProgress = Math.min(a.walkProgress + dt / WALK_DURATION, 1);
    const t = 1 - Math.pow(1 - newProgress, 3); // ease-out cubic
    if (newProgress >= 1) return { ...a, x: a.targetX, y: a.targetY, walkProgress: 1, isWalking: false };
    return { ...a, x: a.fromX + (a.targetX - a.fromX) * t, y: a.fromY + (a.targetY - a.fromY) * t, walkProgress: newProgress };
  });
  syncState();
  rafRef.current = requestAnimationFrame(animate);
};
```

## 완료 이력 추적

```typescript
// runAgentCycle step 1에서
const cycleStartMs = Date.now();

// runAgentCycle step 6(Working 진입)에서
const entry: CompletedTask = { task, completedAt: Date.now(), durationMs: Date.now() - cycleStartMs };
completedTasksRef.current = {
  ...completedTasksRef.current,
  [agentId]: [entry, ...(completedTasksRef.current[agentId] || [])].slice(0, 20),
};
```

## 방향 계산
```typescript
function getDirection(fromX, fromY, toX, toY): 'down'|'left'|'right'|'up' {
  const dx = toX - fromX, dy = toY - fromY;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
```

## CEO 접근 오프셋 (겹침 방지 — 반원형 배치)
```typescript
const CEO_OFFSETS = {
  youtube:   { dx: -14, dy: -7 },
  instagram: { dx: -7,  dy: -10 },
  designer:  { dx:  0,  dy: -12 },
  business:  { dx:  7,  dy: -10 },
  developer: { dx:  14, dy: -7 },
  secretary: { dx:  0,  dy:  5 },
};
```

## Idle 방향 사이클

3.8초마다 `IDLE_DIR_CYCLE[agentId]`를 순환하여 에이전트가 자연스럽게 시선을 바꾼다.

```typescript
useEffect(() => {
  const iv = setInterval(() => {
    agentsRef.current = agentsRef.current.map(a => {
      if (a.state !== 'idle') return a;
      const cycle = IDLE_DIR_CYCLE[a.id] || ['down'];
      const nextIdx = (a.idleDirIdx + 1) % cycle.length;
      return { ...a, direction: cycle[nextIdx], idleDirIdx: nextIdx,
               bubble: pickRandom(AGENT_THOUGHTS[a.id] || ['...']) };
    });
    syncState();
  }, 3800);
  return () => clearInterval(iv);
}, [syncState]);
```

## 도착 연출 (arrivedAt)

에이전트가 CEO 앞 또는 책상에 도착할 때 파티클 버스트 트리거:

```typescript
// CEO 도착 시
updateAgent(agentId, { arrivedAt: 'ceo' });
await delay(150);
updateAgent(agentId, { arrivedAt: null }); // 파티클 재생 후 리셋

// 책상 복귀 시
updateAgent(agentId, { arrivedAt: 'desk' });
await delay(150);
updateAgent(agentId, { arrivedAt: null });
```

## 중요한 React 훅 규칙
- wouter `<Route>` 안에서 훅을 사용할 때 `component={Home}` 대신 `{() => <Home />}` 사용
- 이유: wouter 패치 버전에 따라 component prop이 함수 직접 호출로 처리될 수 있음
