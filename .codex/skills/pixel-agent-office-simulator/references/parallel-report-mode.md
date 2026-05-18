# 병렬 보고 모드 설계

## 개요

순차(sequential)와 병렬(parallel) 두 가지 보고 모드를 지원한다.
- **순차**: 에이전트가 한 명씩 CEO에게 이동·보고·복귀
- **병렬**: 모든 에이전트가 stagger 간격으로 동시 출발, 각자 독립적으로 사이클 완료

## 상태 타입 추가

```typescript
export type ReportMode = 'sequential' | 'parallel';

export interface SimulationState {
  // ... 기존 필드 ...
  reportMode: ReportMode;
  /** 병렬 모드에서 CEO 앞에 있는 에이전트들 */
  reportingAgentIds: string[];
}
```

## 핵심 구현 패턴

### 순차 처리
```typescript
const processSequential = async () => {
  while (queue.length > 0) {
    const agentId = queue.shift();
    await runAgentCycle(agentId, task);
    await delay(350); // 다음 에이전트 출발 전 짧은 대기
  }
};
```

### 병렬 처리 (stagger 출발)
```typescript
const STAGGER_MS = 300; // 에이전트 간 출발 간격

const processParallel = async () => {
  const agentIds = [...queue];
  queue = [];

  const promises = agentIds.map((agentId, idx) =>
    new Promise<void>(async resolve => {
      await delay(idx * STAGGER_MS); // stagger
      await runAgentCycle(agentId, task);
      resolve();
    })
  );

  await Promise.all(promises); // 모두 완료될 때까지 대기
};
```

## CEO 접근 오프셋 — 반원형 배치

병렬 모드에서 여러 에이전트가 CEO 주변에 겹치지 않게 배치:

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

## 빔 렌더링 — 순차/병렬 모두 지원

```typescript
// 병렬: 보고 중인 모든 에이전트에 빔
// 순차: 활성 에이전트 1명에만 빔
const beamAgents = isParallel
  ? agents.filter(a => a.state === 'walking_to_ceo' || a.state === 'reporting')
  : (activeAgent?.state === 'walking_to_ceo' || activeAgent?.state === 'reporting')
    ? [activeAgent] : [];
```

## 모드 전환 제약

- 실행 중(`processingRef.current === true`)에는 전환 불가
- UI 버튼에 `disabled={state.isRunning}` 적용

## UI 표시

```tsx
// 헤더 모드 전환 버튼
<button onClick={toggleReportMode} disabled={state.isRunning}>
  {isParallel ? '⧈ PARALLEL' : '▶ SEQUENTIAL'}
</button>

// 스테이지 레이블 — 병렬 모드 배지
{isParallel && <span>⧈ PARALLEL</span>}

// 동시 보고 인원 표시
{reportingAgents.length > 1 && <span>{reportingAgents.length}명 동시 보고</span>}
```
