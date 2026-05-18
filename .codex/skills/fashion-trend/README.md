# fashion-trend

KREAM(크림) 크롤링으로 실시간 패션 트렌드를 수집하고, 다크 에디토리얼 매거진 스타일의 HTML 리포트를 자동 생성하는 Claude Code 스킬.

한 문장만 말하면 — `"요즘 인기있는 남성신발"` — 카테고리 파싱 → KREAM 크롤링 → 트렌드 분석 → HTML 리포트까지 약 1분 내 완성된다.

---

## Features

- **실시간 KREAM 랭킹 수집** — 남성/여성 인기순, 검색, TOP 100 큐레이션 지원
- **Claude 기반 트렌드 분석** — 단순 집계가 아닌, 패션 에디터 관점의 인사이트(브랜드 판도, 카테고리 시프트, 가격대 분석, 시즌 인사이트 등)
- **감각적 HTML 리포트** — 다크 매거진 테마, 모바일 반응형, 상품 카드 그리드
- **안티봇 우회 크롤링** — Scrapling `stealthy-fetch`로 보호된 페이지 접근
- **차단 자동 감지 + 재시도** — 30초 대기 후 1회 재시도, 실패 시 사용자에게 안내

---

## Installation

Claude Code 스킬 폴더에 이 레포를 복사하면 끝.

### 전역 설치 (모든 프로젝트에서 사용)

```bash
git clone https://github.com/fivetaku/fashion-trend.git ~/.claude/skills/fashion-trend
```

### 프로젝트 로컬 설치

```bash
cd <your-project>
git clone https://github.com/fivetaku/fashion-trend.git .claude/skills/fashion-trend
```

설치 후 Claude Code를 재시작하거나 새 세션을 열면 스킬이 자동으로 인식된다.

### 의존성

Scrapling과 Playwright 브라우저가 필요하다. **첫 실행 시 스킬이 자동으로 설치**하므로 수동 설치는 필요 없다. 수동으로 설치하려면:

```bash
pip install "scrapling[all]"
scrapling install
```

---

## Usage

설치 후 Claude Code에서 자연어로 부르면 된다. 키워드를 감지해 자동 실행된다.

```
요즘 인기있는 남성신발 알려줘
KREAM에서 여자 가방 인기순 보여줘
남자 스니커즈 트렌드 리포트 만들어줘
요즘 뭐가 인기야
```

명확한 의도(카테고리+성별+정렬)가 이미 들어있으면 추가 질문 없이 바로 크롤링 → 리포트 생성으로 진입한다.

결과물은 `trend-report/{YYYYMMDD}-{카테고리}.html`로 저장되고, 브라우저에서 바로 열어볼 수 있다.

---

## How it works

```
사용자 입력
    ↓
[Step 0] Scrapling 설치 확인 (최초 1회)
    ↓
[Step 1] 의도 파싱 (카테고리/성별/정렬)
    ↓
[Step 2] KREAM URL 조합 + stealthy-fetch 크롤링
    ↓
[Step 3] 마크다운 파싱 → 상품 데이터 구조화
    ↓
[Step 4] (선택) 상위 상품 상세 크롤링 — 프리미엄율 계산
    ↓
[Step 5] Claude가 트렌드 인사이트 작성 + HTML 리포트 생성
```

자세한 워크플로우는 [`SKILL.md`](./SKILL.md) 참고.

---

## File structure

```
fashion-trend/
├── README.md           # 이 파일
├── LICENSE             # MIT
├── SKILL.md            # 스킬 본체 (Claude Code가 읽는 프롬프트)
└── scripts/
    ├── setup.sh        # Scrapling 설치 확인/자동 설치
    └── crawl.sh        # KREAM 크롤링 실행 + 차단 감지
```

---

## Requirements

- macOS / Linux (Windows는 테스트되지 않음)
- Python 3.11 이상
- `pip`, `bash`
- Claude Code CLI

`setup.sh`는 현재 macOS의 `~/Library/Python/3.x/bin` 경로를 우선 탐지한다. Linux/다른 환경에서는 `command -v scrapling` 폴백을 사용한다.

---

## Disclaimer (중요)

이 스킬은 **개인 학습 및 리서치 목적**으로만 사용해야 한다.

- **상업적 이용 및 재배포 금지** — 생성된 리포트에는 KREAM CDN의 상품 이미지와 브랜드 정보가 포함되며, 이에 대한 저작권은 원 권리자에게 있다.
- **KREAM 이용약관 준수 책임은 사용자에게 있다** — 이 스킬은 Scrapling의 `stealthy-fetch`로 봇 탐지를 우회하지만, 대상 사이트의 ToS 및 `robots.txt`를 확인하고 준수할 책임은 사용자 본인에게 있다.
- **과도한 요청 금지** — 스킬은 상세 크롤링 시 요청 간 2초 간격을 기본으로 두지만, 짧은 시간 내 반복 실행은 대상 사이트에 부담을 줄 수 있으므로 자제한다.
- **법적 책임** — 이 스킬 사용으로 인해 발생하는 모든 법적/윤리적 이슈는 사용자에게 있으며, 이 레포의 작성자는 어떠한 책임도 지지 않는다.

요약하면 — **내가 공부/실험용으로 쓰는 건 OK, 크롤링 결과물을 공개 배포하거나 상업적으로 쓰는 건 NO**.

---

## License

[MIT](./LICENSE)

---

## Credits

- [Scrapling](https://github.com/D4Vinci/Scrapling) — 안티봇 우회 웹 크롤링 프레임워크
- [Claude Code](https://claude.com/claude-code) — AI 기반 개발 환경
