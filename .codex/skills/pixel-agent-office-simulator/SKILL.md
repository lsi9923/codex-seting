---
name: pixel-agent-office-simulator
description: >
  React + Vite 웹앱에 LimeZu 픽셀 스프라이트 기반 AI 에이전트 오피스 시뮬레이터를 구현하는 스킬.
  connect-ai / Hermes Desktop 스타일의 2D 사무실 시뮬레이터를 처음 만들거나 개선할 때 사용.
  포함 내용: GitHub 저장소에서 스프라이트·에이전트 정보 추출, LimeZu 스프라이트 애니메이션 루프,
  ease-out cubic 이동 보간, CEO 보고 상태 머신(순차/병렬 모드), 말풍선 충돌 회피,
  에이전트 클릭 상세 모달(역할·완료 이력), 사이버펑크 UI 테마.
license: Complete terms in LICENSE.txt
---

# Pixel Agent Office Simulator

## 개요

connect-ai 또는 유사한 AI 에이전트 프로젝트에서 **YouTube 영상처럼 생동감 있는 픽셀 에이전트 오피스 시뮬레이터**를 React 웹앱으로 구현하는 전체 프로세스를 안내한다.

핵심 구성요소: LimeZu 스프라이트 애니메이션, ease-out cubic 이동 보간, CEO 보고 상태 머신, 순차/병렬 보고 모드, 말풍선 충돌 회피, 에이전트 클릭 상세 모달, 사이버펑크 UI.

---

## 워크플로

### 1단계: 소스 저장소 분석

```bash
git clone https://github.com/lsi9923/connect-ai.git connect-ai-source
python /home/ubuntu/skills/pixel-agent-office-simulator/scripts/extract_sprite_info.py connect-ai-source
```

추출 대상:
- `src/agents.ts` — 에이전트 정의 (id, name, emoji, color, sprite)
- `assets/pixel/characters/*.png` — LimeZu 스프라이트 시트 (2688×1968)
- `assets/pixel/office/Office_Design_2.gif` — 사무실 배경
- `src/extension.ts` — 책상 위치(`HOME_POS`), 애니메이션 루프

스프라이트 시트 구조는 `references/sprite-sheet-spec.md` 참조.

### 2단계: 에셋 업로드

```bash
manus-upload-file --webdev \
  connect-ai-source/assets/pixel/characters/{ceo,youtube,instagram,designer,developer,business,secretary}.png \
  connect-ai-source/assets/pixel/office/Office_Design_2.gif
```

반환된 `/manus-storage/{id}_{hash}.png` 경로를 `agents.ts`에 기록한다.

### 3단계: 핵심 파일 구현

구현 순서:

1. **`client/src/data/agents.ts`** — 에이전트 정의, 책상 위치, 스프라이트 설정, idle 방향 사이클
   → `templates/agents-data.ts.template` 복사 후 실제 해시로 교체

2. **`client/src/hooks/useAgentSimulation.ts`** — 상태 머신 + RAF 보간 + 순차/병렬 모드 + 완료 이력
   → `references/agent-state-machine.md`, `references/parallel-report-mode.md` 참조

3. **`client/src/components/PixelAgent.tsx`** — 스프라이트 렌더링, 도착 파티클, 이름+역할 뱃지, onClick
   → `references/sprite-sheet-spec.md` 참조

4. **`client/src/components/OfficeStage.tsx`** — 사무실 스테이지, 말풍선 충돌 회피, 다중 빔
   → `references/office-layout.md` 참조

5. **`client/src/components/AgentDetailModal.tsx`** — 클릭 상세 모달
   → `references/agent-detail-modal.md` 참조

6. **`client/src/pages/Home.tsx`** — CEO 커맨드 패널, 모드 전환 버튼, 에이전트 상태 그리드, 로그

7. **`client/src/index.css`** — 사이버펑크 테마 + 모달 애니메이션
   → `templates/cyberpunk-theme.css.template` 참조

8. **`client/index.html`** — Google Fonts 추가

```html
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

### 4단계: 검증

```bash
npx tsc --noEmit   # TypeScript 오류 없어야 함
pnpm build         # 프로덕션 빌드 성공해야 함
```

---

## 핵심 구현 패턴

### 스프라이트 애니메이션

```typescript
// 방향별 열 오프셋: down=0, left=6, right=12, up=18
const col = DIRS[direction] + (Math.floor(frameCount / speed) % 6);
const bgPos = `-${col * 48}px -${row * 96}px`;
// row: 1=idle, 2=walk/work   speed: idle=16, walk=6
```

자세한 계산식은 `references/sprite-sheet-spec.md` 참조.

### 이동 보간 (RAF + useRef)

`useRef`로 에이전트 위치를 추적하고 RAF에서 lerp 계산 후 `setState`로 렌더 트리거.

```typescript
const t = 1 - Math.pow(1 - progress, 3); // ease-out cubic
newX = fromX + (targetX - fromX) * t;
```

전체 구현은 `references/agent-state-machine.md` 참조.

### 순차 vs 병렬 보고 모드

```typescript
// 병렬: 모든 에이전트를 300ms stagger로 동시 출발
const promises = agentIds.map((id, idx) =>
  new Promise<void>(async resolve => {
    await delay(idx * 300);
    await runAgentCycle(id, task);
    resolve();
  })
);
await Promise.all(promises);
```

전체 구현은 `references/parallel-report-mode.md` 참조.

### 에이전트 클릭 상세 모달

```typescript
// PixelAgent에 onClick prop 추가
<div onClick={onClick ? () => onClick(agent.id) : undefined}
     style={{ pointerEvents: onClick ? 'auto' : 'none' }}>

// Home.tsx에서 모달 렌더링
{selectedAgentId && (
  <AgentDetailModal
    agent={state.agents.find(a => a.id === selectedAgentId)}
    completedTasks={state.completedTasks[selectedAgentId] ?? []}
    onClose={() => setSelectedAgentId(null)}
  />
)}
```

전체 구현은 `references/agent-detail-modal.md` 참조.

### 말풍선 충돌 회피

```typescript
for (const placed of slots) {
  if (Math.abs(ax - placed.x) < BUBBLE_W) stackY -= (BUBBLE_H + GAP);
}
offsets[agent.id] = stackY; // PixelAgent의 bubbleOffsetY prop으로 전달
```

### wouter Route 훅 오류 방지

```tsx
// ❌ 문제 가능
<Route path="/" component={Home} />
// ✅ 안전
<Route path="/">{() => <Home />}</Route>
```

---

## 사이버펑크 디자인 원칙

| 요소 | 값 |
|------|-----|
| 배경 | `#050810` |
| 주 강조색 | `#00ff41` (네온 그린) |
| 보조 강조색 | `#22D3EE` (청록) |
| 병렬 모드 색상 | `#A78BFA` (퍼플) |
| 헤더 폰트 | `Press Start 2P` |
| 본문 폰트 | `JetBrains Mono` |
| 스캔라인 | `repeating-linear-gradient` z-index:9999 |

CSS 전체 템플릿은 `templates/cyberpunk-theme.css.template` 참조.

---

## 자주 발생하는 문제

| 문제 | 원인 | 해결 |
|------|------|------|
| 스프라이트가 머리만 보임 | height를 48px로 설정 | `height: 96px` (CHAR_HEIGHT = TILE×2) |
| 에이전트가 뚝뚝 끊겨 이동 | CSS transition 사용 | RAF + lerp 방식으로 교체 |
| 말풍선이 겹침 | 고정 Y 오프셋 | `computeBubbleOffsets()` 함수 적용 |
| React 훅 오류 | wouter Route 방식 | `{() => <Component />}` 패턴 사용 |
| 빌드 후 이미지 없음 | public 폴더에 이미지 저장 | `manus-upload-file --webdev` 사용 |
| SCALE 중복 선언 오류 | 파일 편집 중 잔존 코드 | Vite 캐시(`node_modules/.vite`) 삭제 후 재시작 |
| 병렬 모드 중 전환 불가 | 의도된 동작 | `processingRef.current` 체크로 실행 중 전환 차단 |
| 모달이 클릭 안 됨 | pointerEvents: none | PixelAgent onClick 있을 때 `pointerEvents: 'auto'` |

---

## 번들 리소스 목록

| 파일 | 용도 |
|------|------|
| `scripts/extract_sprite_info.py` | connect-ai 저장소에서 스프라이트·책상 위치 추출 |
| `references/sprite-sheet-spec.md` | LimeZu 스프라이트 시트 행/열 구조 상세 사양 |
| `references/agent-state-machine.md` | 상태 머신 설계 + RAF 보간 + 완료 이력 추적 |
| `references/office-layout.md` | 사무실 좌표 체계 + 레이어 순서 |
| `references/parallel-report-mode.md` | 순차/병렬 모드 구현 패턴 + CEO 반원형 배치 |
| `references/agent-detail-modal.md` | 클릭 상세 모달 구조 + 완료 이력 타입 |
| `templates/agents-data.ts.template` | `agents.ts` 보일러플레이트 (idleDir + IDLE_DIR_CYCLE 포함) |
| `templates/cyberpunk-theme.css.template` | 사이버펑크 CSS 테마 + 키프레임 전체 |
