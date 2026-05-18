---
name: scrapling-crawler
description: Use when a user asks for Python-based crawling or scraping and Scrapling is a good fit, especially for structured extraction, session-aware crawling, adaptive selectors, spiders, or dynamic page fetching.
---

# Scrapling Crawler

Use Scrapling as one of the crawler options for Codex tasks.

Installed package:
- `scrapling==0.4.5`

Vendored reference repo:
- `C:\Users\imda0\.codex\vendor_imports\Scrapling`

Key reference files:
- `C:\Users\imda0\.codex\vendor_imports\Scrapling\README.md`
- `C:\Users\imda0\.codex\vendor_imports\Scrapling\docs\README_KR.md` if present

## When to prefer Scrapling

- Python crawling scripts
- Repeated structured extraction from HTML pages
- Session/cookie-aware crawling
- Spider-style crawling
- Pages that need dynamic rendering in a legitimate browser automation context
- Projects that benefit from adaptive selectors and strong parsing helpers

## Do not overclaim

- Do not promise bypass of anti-bot systems.
- Do not provide steps to evade bot protection, JS challenges, Akamai, Cloudflare, DataDome, or similar protection.
- If a site is protected, say clearly that access may require permission, official API usage, or user-provided authenticated context.

## Safe guidance

- Prefer official APIs when available.
- Respect rate limits, robots, and site terms.
- Use normal session persistence for pages the user is authorized to access.
- For dynamic pages, compare Scrapling with Playwright and choose the simpler safe route.

## Practical usage ideas

- Single page fetch + CSS extraction
- Multi-page spider with async parsing
- Saved session/cookie workflows for authorized sites
- Migration path:
  - static page -> Scrapling `Fetcher`
  - dynamic page -> Scrapling dynamic/browser fetcher or Playwright when appropriate
  - large crawl -> Scrapling spider

## Response rule

- If crawling is requested, mention Scrapling as an option when it genuinely fits.
- If another tool is better for the task, say so directly.
