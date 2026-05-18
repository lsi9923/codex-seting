## Hosted Plan Normalizer Extension

The public/community edition of Sonol ships only the local client pieces:

- local SQLite state
- local loopback bridge for dashboard/runtime access
- remote plan normalizer HTTP client

The hosted plan normalizer implementation is private and is not bundled here.

## Public Client Contract

Standard public/community installs use the hosted Sonol planner service at:

- `https://agent.zooo.kr/v1/planner/draft`
- `https://agent.zooo.kr/v1/planner/ticket`
- `https://agent.zooo.kr/sonol-dashboard/`

No extra planner environment variables are required for that default public path.

If you operate a compatible private or self-hosted hosted plan normalizer, override the local client with:

- `SONOL_PLANNER_DRIVER=remote_http`
- `SONOL_REMOTE_PLAN_NORMALIZER_URL=https://your-planner.example/v1/planner/draft`
- `SONOL_REMOTE_PLAN_NORMALIZER_TICKET_URL=https://your-planner.example/v1/planner/ticket`
- `SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN=<token>`
- `SONOL_REMOTE_DASHBOARD_BASE_URL=https://agent.example/sonol-dashboard/`

`SONOL_REMOTE_PLAN_NORMALIZER_BEARER_TOKEN` is optional in the public default path and is only needed when the hosted service you target requires bearer authentication in addition to ticket flow.

The local SQLite database remains the authority for plans, runs, and runtime
events. The hosted service should only normalize a local AI-authored creative
draft into an executable Sonol plan. It must not author the initial draft and
must not take ownership of the local runtime store.

If the hosted normalizer is unavailable or a custom override is misconfigured,
the public/community edition fails fast during planning. It does not generate a
local fallback draft.
