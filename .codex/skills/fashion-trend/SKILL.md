---
name: fashion-trend
description: This skill should be used when the user asks about fashion trends, clothing, shoes, bags, accessories, jewelry, watches, KREAM popular items, or trend reports, including requests like "요즘 뭐가 인기야", "패션 트렌드 알려줘", "옷 트렌드", "가방 뭐가 잘 나가", "악세사리 인기 상품", "크림 인기 상품", "KREAM 트렌드", "신발 트렌드", "인기 스니커즈", "남자 인기 상품", "여자 인기 상품", "트렌드 리포트 만들어줘", or "fashion trend". KREAM 크롤링으로 실시간 패션 트렌드를 수집하고 이미지 포함 HTML 리포트를 자동 생성합니다. Make sure to use this skill whenever the user mentions fashion items or fashion trend research.
---

# 패션 트렌드 큐레이션

> KREAM(크림) 크롤링으로 옷, 신발, 가방, 악세사리 같은 패션 카테고리에서 지금 뭐가 인기인지 파악하고, 이미지 포함 HTML 트렌드 리포트를 자동 생성하는 스킬.

---

## 워크플로우

### Step 0: 환경 확인 (온보딩)
**타입**: script

스킬 실행 전, Scrapling 설치 상태를 확인한다.

```bash
bash "${SKILL_DIR}/scripts/setup.sh" check
```

**설치 안 되어 있으면**, 아래 안내를 보여주고 자동 설치한다:

```
이 스킬을 처음 사용하시네요! 웹 크롤링 도구를 설치할게요.
약 2~3분 소요됩니다.

설치 항목:
1. Scrapling — 웹 크롤링 프레임워크
2. Playwright 브라우저 — 안티봇 우회용
```

```bash
bash "${SKILL_DIR}/scripts/setup.sh" install
```

**이미 설치되어 있으면**, scrapling 경로를 확인하고 Step 1로 바로 진행한다.

```bash
SCRAPLING_BIN=$(bash "${SKILL_DIR}/scripts/setup.sh" path)
```

**중요**: 온보딩 완료 후, 사용자가 처음에 요청했던 내용을 이어서 바로 처리한다.

### Step 1: 사용자 의도 파싱 + 옵션 선택
**타입**: prompt + ask

사용자 입력에서 카테고리, 성별, 조회 방식을 추출한다.
이미 명시된 경우 해당 질문을 스킵한다.

예: "남자 신발 인기순" → 카테고리(신발), 성별(남성), 정렬(인기순) 모두 파악됨 → 바로 Step 2

불명확한 경우 AskUserQuestion으로 물어본다:

```json
{
  "questions": [
    {
      "question": "어떤 트렌드가 궁금해요?",
      "header": "카테고리",
      "options": [
        {"label": "전체 TOP 100 (추천)", "description": "지금 가장 핫한 상품 TOP 100 랭킹을 한눈에"},
        {"label": "키워드 검색", "description": "신발, 상의, 가방, 브랜드명 등 원하는 키워드로 검색"},
        {"label": "브랜드별", "description": "나이키, 아디다스 등 특정 브랜드 인기 상품"}
      ],
      "multiSelect": false
    },
    {
      "question": "성별 기준은?",
      "header": "성별",
      "options": [
        {"label": "남성 인기순", "description": "20대 남성 기준 인기 랭킹"},
        {"label": "여성 인기순", "description": "20대 여성 기준 인기 랭킹"},
        {"label": "추천순 (성별 무관)", "description": "KREAM 전체 추천 기준"}
      ],
      "multiSelect": false
    }
  ]
}
```

### Step 2: URL 조합 + 크롤링 실행
**타입**: script

사용자 선택에 따라 URL을 조합하고 크롤링을 실행한다.

**방식 A: 키워드 검색**

```
URL 패턴: https://kream.co.kr/search?keyword={키워드}&tab=products&sort={정렬}
```

정렬 파라미터 매핑:
- 남성 인기순: `male_popularity`
- 여성 인기순: `female_popularity`
- 추천순: `recommend`
- 프리미엄 낮은순: `pricepremium[asc]`

**방식 B: TOP 100 큐레이션**

```
남성 TOP100: https://kream.co.kr/exhibitions/15243
여성 TOP100: https://kream.co.kr/exhibitions/15242
```

크롤링 실행:

```bash
bash "${SKILL_DIR}/scripts/crawl.sh" "$SCRAPLING_BIN" "$URL" "${SKILL_DIR}/../../artifacts/kream-result.md" 40000
```

결과 JSON의 `success`가 false이면:
- `BLOCKED`: "KREAM 접근이 일시적으로 제한됐어요. 30초 후 다시 시도합니다." → 30초 대기 후 1회 재시도
- `EMPTY_RESULT`: "페이지 로딩에 실패했어요. 다시 시도할까요?"
- 재시도도 실패하면 사용자에게 알리고 종료

### Step 3: 데이터 파싱
**타입**: prompt

크롤링된 마크다운 파일을 Read로 읽고, 상품 데이터를 구조화한다.

추출 대상:
- 랭킹 번호 (TOP100의 경우)
- 브랜드명
- 상품명 (한글)
- 영문 상품명
- 가격 (현재 거래가)
- 할인율 (있으면)
- 이미지 URL (kream-phinf.pstatic.net 도메인)
- 상품 URL (/products/{id})
- 관심수, 리뷰수, 거래수

파싱 결과 검증:
- 추출된 상품 수가 3개 미만이면 "파싱에 문제가 있을 수 있어요" 경고
- 원본 파일은 `artifacts/`에 보관하여 디버깅 가능

### Step 4: (선택) 상품 상세 크롤링
**타입**: script

상위 5~10개 상품의 상세 페이지에서 추가 정보를 수집한다.

```bash
bash "${SKILL_DIR}/scripts/crawl.sh" "$SCRAPLING_BIN" "https://kream.co.kr/products/{id}" "${SKILL_DIR}/../../artifacts/product-{id}.md" 30000
```

추출 데이터:
- 모델번호
- 발매가
- 현재 거래가
- 프리미엄율: (거래가 - 발매가) / 발매가 × 100
- 사이즈별 거래가 (있으면)

**주의**: 상세 페이지 크롤링은 상품당 5~15초 소요. 5개 = 약 1분. 사용자에게 진행 상황을 알려준다.
"1/5 상품 상세 정보 수집 중..." 식으로.

연속 요청 시 차단 위험이 있으므로 각 요청 사이에 2초 간격을 둔다.

### Step 5: HTML 트렌드 리포트 생성
**타입**: generate

파싱된 데이터를 기반으로 감각적인 HTML 트렌드 리포트를 생성한다.

**디자인 스펙:**

```
테마: 다크 에디토리얼 매거진
배경: #0A0A0A
텍스트: #FAFAFA
포인트: #FFFFFF
폰트: 시스템 산세리프 (Apple SD Gothic Neo 등)
레이아웃: 카드 그리드 (2~3열)
```

**HTML 구조:**

```html
<header>
  KREAM TREND REPORT
  2026.03.28 기준 | {카테고리} | {성별} 인기순
</header>

<section class="trend-insight">
  <!-- Claude가 파싱된 데이터를 보고 직접 분석한 트렌드 인사이트 -->
  <!-- 단순 통계가 아니라, 패션 에디터 관점의 분석을 제공한다 -->

  분석 항목:
  1. 브랜드 트렌드 — 어떤 브랜드가 강세인지, 신흥 브랜드가 있는지
  2. 카테고리 트렌드 — 러닝화/스니커즈/슬리퍼 등 어떤 유형이 뜨는지
  3. 가격대 분석 — 주력 가격대, 프리미엄 vs 가성비 트렌드
  4. 시즌 인사이트 — 계절/시즌에 따른 트렌드 변화
  5. 주목할 상품 — 급상승 또는 특이한 상품 픽
  6. 한줄 요약 — 이번 트렌드를 한 문장으로

  예시:
  "뉴발란스 1906A와 992가 나란히 TOP5 진입. 레트로 러닝 실루엣이 여전히 강세다.
   에어포스 1은 부동의 스테디셀러이나 할인율 31%로 시세가 하락 중.
   아식스 러닝화가 4개나 랭크인하며 '고프코어 → 러닝코어' 전환을 보여준다.
   평균 거래가 16만원대, 10~20만원 가성비 구간이 주력."
</section>

<section class="product-grid">
  <!-- 상품 카드 반복 -->
  <div class="product-card">
    <img src="{이미지 CDN URL}">
    <span class="rank">#1</span>
    <span class="brand">{브랜드}</span>
    <h3>{상품명}</h3>
    <span class="price">{가격}</span>
    <span class="premium">프리미엄 +23%</span>  <!-- 상세 크롤링 시 -->
    <span class="stats">관심 3,311 · 거래 253</span>
    <a href="https://kream.co.kr/products/{id}">KREAM에서 보기 →</a>
  </div>
</section>

<footer>
  Scrapling + Claude Code로 자동 생성
</footer>
```

**이미지**: KREAM CDN URL 직접 참조 (`kream-phinf.pstatic.net`)

**스타일 요구사항:**
- 모던하고 감각적인 CSS 인라인 스타일 (외부 의존성 없음)
- 모바일 반응형
- 상품 이미지가 카드의 주인공 — 크게 배치
- 프리미엄율이 양수면 빨간색(🔼), 음수면 파란색(🔽)
- hover 시 카드 확대 효과
- KREAM 상품 페이지로 바로 이동하는 링크 포함

파일 저장: `trend-report/{YYYYMMDD}-{카테고리}.html`
저장 후 사용자에게 파일 경로를 안내하고 "브라우저에서 열어보세요!"라고 안내한다.

---

## Scrapling CLI 사용법

이 스킬은 Scrapling 웹크롤링 프레임워크의 CLI를 사용한다.

### 설치

```bash
pip install "scrapling[all]"    # 라이브러리 + 브라우저 엔진
scrapling install               # Playwright 브라우저 설치
```

### CLI 명령어

```bash
# 기본 (정적 페이지)
scrapling extract get {URL} {출력파일}

# 안티봇 우회 (KREAM 등 보호된 사이트)
scrapling extract stealthy-fetch {URL} {출력파일} --network-idle --timeout 40000

# Cloudflare 우회
scrapling extract stealthy-fetch {URL} {출력파일} --solve-cloudflare

# 특정 요소만 추출
scrapling extract stealthy-fetch {URL} {출력파일} -s ".product-card"

# 실제 크롬 사용 (더 강한 우회)
scrapling extract stealthy-fetch {URL} {출력파일} --real-chrome
```

### 출력 파일 형식

- `.html` → 원본 HTML
- `.md` → 마크다운 변환 (파싱에 적합)
- `.txt` → 텍스트만

### 차단 대응

1차: `stealthy-fetch --network-idle` (기본)
2차: `stealthy-fetch --real-chrome` (실제 크롬)
3차: 30초 대기 후 재시도
4차: 사용자에게 "현재 접근이 제한됨" 안내

---

## KREAM URL 구조

### 검색

```
https://kream.co.kr/search?keyword={키워드}&tab=products&sort={정렬}
```

| 정렬 | 파라미터 |
|------|---------|
| 남성 인기순 | `male_popularity` |
| 여성 인기순 | `female_popularity` |
| 추천순 | `recommend` |
| 인기점수 | `popular_score` |
| 프리미엄 낮은순 | `pricepremium[asc]` |

### TOP 100 큐레이션

```
남성: https://kream.co.kr/exhibitions/15243
여성: https://kream.co.kr/exhibitions/15242
```

### 상품 상세

```
https://kream.co.kr/products/{id}
```

추출 가능: 모델번호, 발매가, 현재 거래가, 사이즈별 거래가, 색상

---

## Scripts

- **`scripts/setup.sh`** — Scrapling 설치 확인 + PATH 탐지 + 자동 설치. `check`/`install`/`path` 3가지 액션.
- **`scripts/crawl.sh`** — KREAM 크롤링 실행 + 차단 감지 + 결과 검증. 성공/실패를 JSON으로 반환.

---

## Settings

| 설정 | 기본값 | 변경 방법 |
|------|--------|-----------|
| 크롤링 타임아웃 | 40초 | crawl.sh 4번째 인수 |
| 상세 크롤링 수 | 5개 | Step 4에서 조정 |
| 리포트 테마 | 다크 매거진 | Step 5 HTML 템플릿 수정 |
