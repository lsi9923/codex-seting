---
name: gptaku-codex-bridge
description: Use when a user mentions GPTaku plugins, deep-research, docs-guide, kkirikkiri, pumasi, or asks to reuse Claude-only GPTaku plugin ideas inside Codex. Adapts vendored GPTaku plugin content to Codex-native workflows instead of using Claude /plugin commands.
---

# GPTaku Codex Bridge

This skill bridges the vendored GPTaku Claude plugins into Codex-friendly behavior.

Vendored source repo:
- `C:\Users\imda0\.codex\vendor_imports\gptaku_plugins`

Important limitation:
- GPTaku plugins are built for Claude Code `/plugin ...` commands.
- Codex does **not** support Claude's `/plugin` marketplace/install/update flow.
- Never tell the user to run `/plugin ...` inside Codex.

## What to do when triggered

1. Check which GPTaku plugin the user is referring to.
2. Open only the relevant vendored plugin README / skill docs under:
   - `C:\Users\imda0\.codex\vendor_imports\gptaku_plugins\plugins\...`
3. Reuse the idea and workflow, but translate it into Codex-native tools:
   - Web research -> Codex web search / browser debugging / Playwright
   - Docs lookup -> official docs browsing
   - Team building -> Codex subagents
   - Parallel coding -> Codex worker/explorer/reviewer agents
4. Clearly say if something is a conceptual adaptation rather than a direct plugin install.

## Plugin mapping

- `deep-research`
  - Use vendored references:
    - `...\plugins\deep-research\README.md`
    - `...\plugins\deep-research\skills\deep-research-main\SKILL.md`
  - Adapt to Codex with web search, browser debugging, citations, structured report.

- `docs-guide`
  - Use vendored references:
    - `...\plugins\docs-guide\README.md`
    - `...\plugins\docs-guide\skills\docs-guide-knowledge\SKILL.md`
  - Prefer official docs lookup and version-aware explanation.

- `kkirikkiri`
  - Use vendored references:
    - `...\plugins\kkirikkiri\README.md`
    - `...\plugins\kkirikkiri\skills\kkirikkiri\SKILL.md`
  - Adapt to Codex subagent team composition, but do not rely on Claude-only AskUserQuestion behavior.

- `pumasi`
  - Use vendored references:
    - `...\plugins\pumasi\README.md`
    - `...\plugins\pumasi\skills\pumasi\SKILL.md`
  - Adapt to Codex worker/explorer/reviewer subagent orchestration.

## Naver-specific note

If the user wants Naver research:
- Prefer live web search and browser-based verification.
- For blog/news/forum style pages, verify with current browsing rather than static training knowledge.
- If Naver blocks lightweight fetches, use browser debugging / Playwright-style fallback when available in the current environment.

## Response rule

- Be explicit:
  - "Claude plugin direct install is not available in Codex."
  - "I adapted the GPTaku workflow into Codex-native steps."
- Keep the adaptation practical and action-oriented.
