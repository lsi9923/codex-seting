# Sonol Portable Setup

Use this checklist when moving Sonol to another computer.

## Requirements

- Node.js `>=22`
- Writable Sonol directories through one of:
  - `SONOL_HOME_DIR`
  - `SONOL_DATA_DIR`
  - `SONOL_RUNTIME_ROOT`
  - user home state directories such as `~/.local/state/sonol`
- A portable Sonol bundle that already contains:
  - `skills/sonol-multi-agent`
  - `skills/sonol-agent-runtime`
  - bundled runtime dependencies under `skills/sonol-multi-agent/node_modules`
  - bundled dashboard assets under `skills/sonol-multi-agent/internal/dashboard/dist`

## Recommended Install Steps

1. Export a portable bundle from a prepared Sonol install:
   - `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs`
   - Optional destination: `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-portable-bundle.mjs --output-dir /abs/output`
   - For GitHub or other public sharing, use `scripts/export-public-release.mjs` instead of publishing the raw working folders.
2. Export `SONOL_INSTALL_ROOT` to the portable bundle root on the target machine.
3. Copy the portable bundle so `$SONOL_INSTALL_ROOT/skills/sonol-multi-agent` and `$SONOL_INSTALL_ROOT/skills/sonol-agent-runtime` exist on the target machine.
4. Export environment variables if the defaults are not suitable:
   - `SONOL_HOME_DIR`
   - `SONOL_DB_PATH`
   - `SONOL_RUNTIME_ROOT`
   - `SONOL_WORKSPACE_ROOT`
   - `SONOL_DASHBOARD_HOST`
   - `SONOL_CODEX_SESSIONS_ROOT`
   - `SONOL_CLAUDE_PROJECTS_ROOT`
   - `SONOL_DEFAULT_ADAPTER_TYPE`
   - `SONOL_DEFAULT_ADAPTER_BACKEND`
   - `SONOL_MAIN_PROVIDER_SESSION_THREAD_ID`
   - `SONOL_MAIN_PROVIDER_SESSION_ID`
   - `SONOL_MAIN_PROVIDER_SESSION_FILE`
5. Advanced overrides only when intentionally needed:
   - `SONOL_DASHBOARD_PORT`
   - `SONOL_DASHBOARD_URL`
   - `SONOL_PLANNER_DRIVER`
   - `SONOL_PLANNER_MODEL`
   - `SONOL_REMOTE_PLAN_NORMALIZER_URL`
   - `SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL`
   - `SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN`
   - `SONOL_REMOTE_PLAN_NORMALIZER_ALLOW_UNSIGNED`
   - `SONOL_REMOTE_DASHBOARD_BASE_URL`
6. Start the dashboard with:
   - `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs`
   - Optional: `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs --workspace-root /abs/workspace --db /abs/sonol.sqlite`
   - Optional explicit URL override: `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/start-dashboard.mjs --workspace-root /abs/workspace --db /abs/sonol.sqlite --dashboard-url http://127.0.0.1:18081`
7. Run the portability smoke test:
   - `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/portable-smoke-test.mjs`

## Portability Notes

- Runtime command files are generated as `.sh`, `.cmd`, and `.ps1`.
- The current platform chooses one primary launcher file, but alternate launcher files are generated alongside it.
- Plan and run state should be treated as machine-local unless the same DB path and runtime root are intentionally shared.
- `export-portable-bundle.mjs` writes a bundle directory containing only `skills/sonol-multi-agent`, `skills/sonol-agent-runtime`, a top-level `README.md`, and `SONOL_PORTABLE_BUNDLE.json`.
- `export-public-release.mjs` writes a publishable root that contains only `sonol-multi-agent/` and `sonol-agent-runtime/`, while removing private deployment-only artifacts.
- By default the export script runs the copied bundle's `portable-smoke-test.mjs` immediately after export. That smoke test validates both bundled skills, bundled runtime deps, and bundled dashboard assets. Use `--skip-validate` only when you intentionally want a raw copy without post-export verification.
- If bundled `dist` assets are missing under `skills/sonol-multi-agent/internal/dashboard/dist`, the dashboard server can start but the UI will not render correctly.
- On WSL-style `/mnt/<drive>/...` mounts, Sonol normalizes workspace, DB, and runtime paths to lowercase before opening SQLite. This avoids cases where Node file APIs can see a path but `node:sqlite` cannot open it.
- Sonol now derives a stable local dashboard port from `workspace_root` by default. Different workspaces should normally land on different local dashboard URLs without extra setup.
- Treat `SONOL_DASHBOARD_PORT` and `SONOL_DASHBOARD_URL` as explicit overrides, not as the normal default. Avoid exporting one global dashboard URL or port across multiple workspaces unless you intentionally want that override everywhere.
- `present-proposal.mjs` is the preferred orchestration entrypoint. It decides the plan's `authoritative_db_path`, starts or rebinds the local loopback bridge, and prints the exact remote dashboard URL the operator should review.
- That remote review URL is a same-computer session link, not a cross-computer permanent link. It only works while the local loopback bridge for that workspace is alive on the same machine.
- Keep the exact original review URL including the `#bridge=...` fragment. The plain dashboard address without that fragment is not enough to bootstrap the local bridge again in a new tab or browser.
- If a dashboard tab is already open, pasting the full original review URL with the `#bridge=...` fragment back into that same tab should reinitialize the dashboard for the new bridge. Pasting only the plain dashboard address is still not enough.
- If the first browser load happens immediately after startup, the local bridge may still be coming up. Retry the same original review URL after a few seconds before falling back to the manual `start-dashboard.mjs` command.
- Public/community edition planning uses a local AI-authored creative draft plus a hosted normalizer. Standard installs default to `https://agent.zooo.kr/v1/planner/draft`, `https://agent.zooo.kr/v1/planner/ticket`, and `https://agent.zooo.kr/sonol-dashboard/` with no extra planner env needed.
- Set `SONOL_REMOTE_PLAN_NORMALIZER_URL`, `SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL`, and optionally `SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN` only when overriding that public default for a private or self-hosted control-plane.
- Pass a creative draft with `--creative-draft-file /abs/draft.json` or `SONOL_CREATIVE_DRAFT_FILE=/abs/draft.json`. The hosted service must not author the initial draft on behalf of the local AI session.
- Author the draft from the canonical contract and examples:
  `references/creative-draft-contract.md`,
  `references/creative-draft.example.ko.json`,
  `references/creative-draft.example.en.json`
- Sonol now validates the creative draft before planner locks and DB state are mutated, so invalid drafts fail fast without leaving pending planner state behind.
- Codex CLI and Claude Code differ in adapter/runtime session handling after approval, not in planner backend selection.
- When using a non-default DB location, pass the same `--workspace-root` and `--db` pair to both `present-proposal.mjs` and `start-dashboard.mjs` so the draft plan, loopback bridge health, and terminal confirmation all resolve to the same authoritative DB.
- `confirm-plan.mjs` should usually be called with `--workspace-root` and no explicit `--db`. In that mode it can follow the dashboard health response and the plan's `authoritative_db_path` instead of stale local assumptions.
- In Claude Code terminals, prefer `SONOL_DEFAULT_ADAPTER_TYPE=claude-code-subagent` and `SONOL_DEFAULT_ADAPTER_BACKEND=claude-code-manual` unless you intentionally pin a different adapter per command.
- Codex and Claude session transcript discovery no longer assumes `/root/...` paths. Override the search roots with `SONOL_CODEX_SESSIONS_ROOT` and `SONOL_CLAUDE_PROJECTS_ROOT` when the host stores transcripts elsewhere.
