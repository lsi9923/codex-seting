# codex-seting

Windows Codex settings backup for moving skills, agents, prompts, and safe local configuration notes to another computer.

## Included

- `.codex/skills/` - installed Codex skills
- `.codex/agents/` - custom/native agent TOML files
- `.codex/prompts/` - reusable prompt files
- `.codex/rules/` - local rule files
- `.codex/AGENTS.md` - global assistant instruction
- `.codex/hooks.json` - oh-my-codex hook wiring
- `.codex/config.example.toml` - example Codex config copied from this computer

## Not Included

The following files are intentionally not uploaded:

- `auth.json`
- `.sandbox-secrets/`
- `sessions/`
- `archived_sessions/`
- `logs_*.sqlite`
- `state_*.sqlite`
- `cache/`, `.tmp/`, `.sandbox/`, `.sandbox-bin/`
- browser profiles, generated images, model cache, app state files

Those files can contain login tokens, old conversations, local DB state, or large runtime artifacts. On a new computer, sign in to Codex again instead of copying auth files.

## New Computer Setup

Open PowerShell in this repository folder:

```powershell
PS C:\Users\<you>\Desktop\codex-seting> .\install-to-codex.ps1
```

That copies skills, agents, prompts, rules, `AGENTS.md`, and `hooks.json` into `$HOME\.codex`.

To also copy the example config:

```powershell
PS C:\Users\<you>\Desktop\codex-seting> .\install-to-codex.ps1 -ApplyConfig
```

Before using `-ApplyConfig`, review `.codex/config.example.toml` because it contains Windows paths from the original computer. Adjust paths such as `C:\Users\imda0\...` for the new computer if needed.

## Requirements

- Codex CLI installed
- Node.js installed
- `oh-my-codex` installed if you want `hooks.json` to work
- Re-login to Codex on the new computer

Checked source machine versions:

- `codex-cli 0.130.0`
- `node v22.22.2`
- `npm 10.9.7`
- `oh-my-codex 0.16.4`
