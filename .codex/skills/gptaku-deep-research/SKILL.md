---
name: gptaku-deep-research
description: Use when the user asks for GPTaku deep research, deep-research plugin behavior, or wants a structured multi-source research workflow inside Codex, especially for Korean web research including Naver.
---

# GPTaku Deep Research For Codex

This is a Codex-native adaptation of GPTaku's Claude-only deep-research plugin.

Vendored reference files:
- `C:\Users\imda0\.codex\vendor_imports\gptaku_plugins\plugins\deep-research\README.md`
- `C:\Users\imda0\.codex\vendor_imports\gptaku_plugins\plugins\deep-research\skills\deep-research-main\SKILL.md`
- `C:\Users\imda0\.codex\vendor_imports\gptaku_plugins\plugins\deep-research\skills\deep-research-query\SKILL.md`

## Do not do this

- Do not tell the user to use `/plugin install deep-research` in Codex.
- Do not rely on Claude-only tools like `AskUserQuestion`.

## Codex-native workflow

1. Clarify the topic in plain language if needed.
2. Break it into 3-5 subtopics.
3. Use live web search for recent sources.
4. Prefer primary or official sources where possible.
5. For Naver content:
   - search first
   - if search snippets are weak, use browser verification or interactive browsing fallback
   - explicitly note when access is limited
6. Cross-check important claims with at least 2 sources when feasible.
7. Output a structured summary:
   - 핵심 결론
   - 근거 소스
   - 확실한 내용 / 불확실한 내용
   - 다음 확인 항목

## Quality bar

- Use concrete dates for anything recent.
- Distinguish confirmed facts from inference.
- Include source links.
- If Naver or another site is blocked, say that clearly and explain the fallback used.
