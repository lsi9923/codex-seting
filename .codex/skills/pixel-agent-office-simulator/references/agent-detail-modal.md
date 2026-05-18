# 에이전트 상세 모달 설계

## 개요

에이전트 스프라이트를 클릭하면 역할·현재 상태·전문 분야·완료 이력을 보여주는 모달 패널.

## 완료 이력 타입

```typescript
export interface CompletedTask {
  task: string;
  completedAt: number; // Date.now() timestamp
  durationMs: number;  // 사이클 시작부터 완료까지 소요 시간
}

// SimulationState에 추가
completedTasks: Record<string, CompletedTask[]>; // 에이전트별 최근 20건
```

## 이력 기록 위치

`runAgentCycle` 내 step 1(Thinking 시작)에서 `cycleStartMs = Date.now()` 기록,
step 6(Working 진입)에서 이력 저장:

```typescript
const cycleStartMs = Date.now(); // step 1에서

// step 6에서
const entry: CompletedTask = {
  task,
  completedAt: Date.now(),
  durationMs: Date.now() - cycleStartMs,
};
completedTasksRef.current = {
  ...completedTasksRef.current,
  [agentId]: [entry, ...prev].slice(0, 20),
};
```

## 클릭 이벤트 연결

### PixelAgent — onClick prop 추가
```typescript
interface PixelAgentProps {
  onClick?: (agentId: string) => void;
}

// 루트 div
<div
  onClick={onClick ? () => onClick(agent.id) : undefined}
  style={{
    pointerEvents: onClick ? 'auto' : 'none',
    cursor: onClick ? 'pointer' : 'default',
    height: `${RH + 30}px`, // 이름표 영역까지 포함
  }}
>
```

### OfficeStage → PixelAgent 전달
```typescript
interface OfficeStageProps {
  onAgentClick?: (agentId: string) => void;
}
// PixelAgent에 onClick={onAgentClick} 전달
```

### Home.tsx — 상태 관리
```typescript
const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
const handleAgentClick = useCallback((id: string) => setSelectedAgentId(id), []);
const handleModalClose = useCallback(() => setSelectedAgentId(null), []);
```

## AgentDetailModal 컴포넌트 구조

```
AgentDetailModal
├── Header: 스프라이트 미리보기 + 이름 + 역할 + 완료건수 배지 + 닫기버튼
├── Body (스크롤)
│   ├── Tagline (역할 한 줄 설명)
│   ├── 현재 상태 (LED + 상태 레이블 + 현재 작업/idle 생각)
│   ├── 전문 분야 (specialty 항목 목록)
│   └── 완료 이력 (최근 20건, 최신 항목 강조)
└── Footer: ESC/외부클릭 안내 + persona 한 줄
```

## 닫기 처리

```typescript
// ESC 키
useEffect(() => {
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [onClose]);

// 배경 클릭
<div ref={overlayRef} onClick={e => { if (e.target === overlayRef.current) onClose(); }}>
```

## 애니메이션 키프레임

```css
@keyframes overlayFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes modalSlideIn {
  from { opacity: 0; transform: translateY(16px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

## 시간 포맷 유틸

```typescript
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s/60)}분 ${s%60}초`;
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
```
