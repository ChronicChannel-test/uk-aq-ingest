# Cross-repo map: CIC-test-uk-aq-ingest

## Purpose
This repo houses ingestion, backfill, and connector tooling for UK AQ, plus Supabase Edge Functions that power live polling and API access. It is the operational hub that reads from external data sources and writes to the database defined in the schema repo.

## Repo structure (top-level)
- `scripts/`: Python entry points for ingest, backfills, exports, and utilities.
- `supabase/`: Supabase Edge Functions and config (functions are deployed from here).
- `workers/`: Worker/dispatcher code for scheduled runs.
- `system_docs/`: Operational/system documentation (including gap logic notes).
- `tests/`: Pytest-based tests (some live tests gated by env flags).
- `network_info/`, `data/`, `archive/`: Data snapshots, analysis outputs, and historical scripts.
- `package.json`: Node helper scripts (e.g., keepalive).

## How this repo connects to the others
- **Schema source**: `uk-aq-schema` provides the SQL DDL (tables, views, functions). Ingest queries here assume those schemas exist.
- **History repo**: `uk-aq-history` (if present) contains long-run/backfill analysis scripts; this repo does the current ingest and operational backfills.
- **Edge Functions**: owned and deployed from this repo under `supabase/functions/*`.
- **Change flow**: schema changes in `uk-aq-schema` can require updating ingest SQL, RPCs, or column mappings here.

## Setup & run (lightweight)
### Required env vars (names only; discoverable in code)
Common / core:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SB_SUPABASE_URL`
- `SB_SERVICE_ROLE_KEY`
- `SB_UK_AQ_CRON_SECRET`

Source-specific (used by connectors / edge functions):
- `OPENAQ_API_KEY`, `OPENAQ_BASE_URL`
- `BREATHELONDON_API_KEY`, `BREATHELONDON_BASE_URL`
- `LAQN_BASE_URL`
- `UK_AIR_SOS_BASE_URL`, `UK_AIR_SOS_SERVICE_LABEL`
- `SCOMM_BASE_URL`

Dropbox/logging (used by multiple ingests):
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- `UK_AQ_DROPBOX_ROOT`

(See `supabase/functions/*/index.ts` and `scripts/*.py` for full usage.)

### Commands (from existing repo docs/config)
- Python venv + deps: see `README.md`.
- UK-AIR SOS ingest (example): `python3 scripts/uk_air_sos/uk_air_sos_ingest.py --discover --backfill-2025`
- Node keepalive: `npm run keepalive` (from `package.json`).

## Where to start
- **Main scripts**: `scripts/uk_air_sos/`, `scripts/openaq/`, `scripts/breathelondon/`, `scripts/erg_laqn/`.
- **Edge functions**: `supabase/functions/` (deploy from this repo).
- **Gap logic docs**: `system_docs/openaq_gap_logic.md`.
- **Supabase config**: `supabase/config.toml`.

## Conventions
- Connector codes / service refs: `openaq`, `uk_air_sos`, `breathelondon`, `erg_laqn`, `sensorcommunity`.
- Database schema namespaces: `uk_aq_core`, `uk_aq_raw`, `uk_aq_public` (defined in schema repo).
- Edge functions are named `ingest_*` for data ingestion and `uk_aq_*` for API endpoints.
- Naming conventions live in `AGENTS.md` (source of truth). Highlights:
  - Prefer `uk_aq` in filenames/docs; do not rename service `UK-AIR SOS`.
  - Use “timeseries” (not “sensors”) in code/docs.
  - SOS networks use `gov_uk_<network>_` prefixes under `scripts/gov_uk_<network>/`.
  - Non-SOS networks use `<network>_` prefixes under `scripts/<network>/`.
  - `*_ref` = source id, `*_code` = internal code, `label` = raw source label, `display_name` = curated UI label.

## Permissions (REQUIRED)
- The agent may edit any files without asking for permission, except files under any `/archive` directory.

## Links
- Existing README: `README.md`
- Supabase config: `supabase/config.toml`
- Edge functions: `supabase/functions/`
- System docs: `system_docs/`
- Naming conventions: `AGENTS.md`
- Schema repo (sibling): `../CIC-test-uk-aq-schema/uk-aq-schema`
- History repo (sibling): `../CIC-test-uk-aq-history/uk-aq-history`

## WORKING STYLE (IMPORTANT)

REQUIRED OUTPUT FORMAT

Summary (2–5 bullets)
Files changed (paths)
Implementation details (short, specific)
Supabase steps (instructions only)
Verification checklist (clear pass/fail)
