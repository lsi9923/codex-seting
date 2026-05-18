# Public Release Boundary

Use a generated public release when you want to publish Sonol externally, such
as on GitHub, without shipping private deployment artifacts.

## What the public release contains

- `sonol-multi-agent/`
- `sonol-agent-runtime/`

The public release keeps the working operator experience intact:

- local SQLite remains authoritative
- the local loopback bridge remains authoritative for dashboard/runtime access
- the remote dashboard stays a thin UI against that local bridge
- the local Codex or Claude session still authors the creative draft
- the hosted planner service remains deterministic and only normalizes/binds

## What the public release must not contain

- private hosted service implementation
- deployment-unit files or service-manager templates for the hosted planner
- unpublished remote dashboard shell artifacts
- raw working copies that include duplicate or internal-only packaging paths

## Export workflow

1. Generate the public release root:
   - `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/export-public-release.mjs`
2. Validate the generated root:
   - `node $SONOL_INSTALL_ROOT/skills/sonol-multi-agent/scripts/check-public-release.mjs --release-root /abs/output/sonol-public`
3. Publish the generated root, not the raw working install tree.

## Notes

- The hosted planner remains remote. The public release only ships the local
  client/runtime surface needed to talk to it.
- Browser storage is never authoritative for Sonol orchestration state.
- The public release is intentionally separate from the portable machine-to-machine
  bundle. Use `export-portable-bundle.mjs` for private machine transfer, and
  `export-public-release.mjs` for external publishing.
