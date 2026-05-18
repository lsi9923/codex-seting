# 사무실 레이아웃 좌표 참조

## 배경 이미지
- 파일: `Office_Design_2.gif` (LimeZu Modern Office)
- 원본 크기: 512×544 px
- 렌더: `objectFit: cover`, `imageRendering: pixelated`
- 업로드 경로: `/manus-storage/Office_Design_2_{hash}.gif`

## 좌표 체계
- 단위: 월드 캔버스 % (0–100)
- 기준: 에이전트 발 위치 (스프라이트 하단 중앙)
- 렌더 수식: `px = (x/100) * stageWidth - RENDERED_W/2`

## 기본 책상 배치 (Office_Design_2 기준)
```typescript
const DESK_POSITIONS = {
  // 상단 행 (4개 책상)
  youtube:   { x: 26, y: 32 },
  instagram: { x: 40, y: 32 },
  designer:  { x: 54, y: 32 },
  business:  { x: 68, y: 32 },
  // 하단 행 (2개 책상)
  developer: { x: 26, y: 56 },
  secretary: { x: 68, y: 56 },
  // CEO 룸 (하단 중앙)
  ceo:       { x: 47, y: 78 },
};
```

## 깊이 정렬 (z-index)
```typescript
const zIndex = 10 + Math.floor(agent.y * 0.1);
// y가 클수록 앞에 렌더 (아이소메트릭 깊이감)
```

## 사이버펑크 오버레이 레이어 순서
1. 배경 이미지 (z=0)
2. 사이버펑크 그리드 오버레이 (z=1)
3. 비네트 (z=2)
4. 책상 마커 / CEO 테이블 (z=3)
5. 연결 빔 (z=4)
6. 에이전트 스프라이트 (z=10+)
7. 말풍선 (z=50)
8. 파티클 (z=20)

## 커스텀 맵 사용 시
- `assets/map.jpeg` 같은 AI 생성 맵 사용 가능
- 이 경우 `DESK_POSITIONS`를 맵에 맞게 수동 조정 필요
- `CUSTOM_MAP_DESKS` 상수로 오버라이드

## 연결 빔 (CEO 보고 시)
```typescript
// 에이전트 → CEO 방향 빔
const dx = cx - ax, dy = cy - ay;
const len = Math.sqrt(dx*dx + dy*dy);
const angle = Math.atan2(dy, dx) * (180/Math.PI);
// div에 width=len, transform=rotate(angle)
```
