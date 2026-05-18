# LimeZu Premade_Character_48x48 스프라이트 시트 사양

## 시트 규격
- 전체 크기: 2688×1968 px
- 셀 크기: 48px(가로) × 96px(세로) — 타일 2칸 높이
- 렌더 권장 스케일: 1.4× (67px × 134px)

## 행(Row) 구조 — y 오프셋 기준
| Row | y 오프셋 | 용도 |
|-----|---------|------|
| 0 | 0 | 그림자/베이스 |
| 1 | -96px | **대기(idle)** — 방향별 6프레임, 미세 호흡 |
| 2 | -192px | **걷기/작업(walk/work)** — 방향별 6프레임 |

## 열(Column) 구조 — 방향별 오프셋
| 방향 | colOffset | 프레임 범위 |
|------|-----------|------------|
| down | 0 | col 0–5 |
| left | 6 | col 6–11 |
| right | 12 | col 12–17 |
| up | 18 | col 18–23 |

## backgroundPosition 계산
```
col = colOffset + (Math.floor(frameCount / speed) % 6)
x = -(col * 48)px
y = -(row * 96)px
```

## 속도 권장값
- idle: speed=14 (느린 호흡)
- walk/work: speed=7 (빠른 걸음)

## CSS 핵심 속성
```css
.character {
  width: 48px;
  height: 96px;
  background-image: url(sprite.png);
  background-repeat: no-repeat;
  background-size: auto;
  image-rendering: pixelated;
}
```

## 사용 가능한 캐릭터 ID
`ceo`, `youtube`, `instagram`, `designer`, `developer`, `business`, `secretary`, `editor`, `researcher`, `writer`

## 스프라이트 업로드 경로 (connect-ai 프로젝트 기준)
원본: `assets/pixel/characters/{id}.png`  
업로드 후: `/manus-storage/{id}_{hash}.png`
