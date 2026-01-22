# UK-AQ PCON Refresh workflow

This documents how `.github/workflows/uk_aq_pcon_refresh.yml` keeps station `pcon_code` up to date when it is null.

## Trigger and purpose
- Runs every 20 minutes via cron and can be invoked manually (`workflow_dispatch`).
- Goal: ensure parliamentary constituency (PCON) boundaries are present for the target version and queue/process stations missing `pcon_code`.

## Required secrets
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Dropbox: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- PCON metadata: `PCON_GEOJSON_DROPBOX_BASE` (or `PCON_GEOJSON_DROPBOX_PATH`), optional `PCON_VERSION`, `PCON_CODE_FIELD`, `PCON_NAME_FIELD`, `PCON_BOUNDARY_BATCH_SIZE`, `PCON_SLEEP_SECONDS`, `PCON_MAX_RETRIES`, `PCON_RETRY_BACKOFF_SECONDS`, `PCON_QUEUE_BATCH_SIZE`

## Step-by-step flow
1) **Checkout + Python setup**
   - Installs `requests`, `python-dotenv`, `supabase`.

2) **Resolve PCON GeoJSON from Dropbox**
   - Authenticates to Dropbox using refresh token.
   - Normalizes the configured base/path.
   - If a direct GeoJSON path is provided, uses it. Otherwise lists version folders under the base (supports year-only or month/year names like `July_2024`), picks the requested `PCON_VERSION` when possible, then finds the single GeoJSON file under that folder (recursively, e.g., `BFC/Data/...geojson`).
   - Downloads to `tmp/pcon.geojson` and writes `PCON_VERSION` and `PCON_GEOJSON_PATH` to `GITHUB_ENV`.

3) **Check existing PCON boundaries**
   - Queries Supabase `pcon_boundaries` for `pcon_version == PCON_VERSION`.
   - Sets `PCON_SKIP_BOUNDARIES=1` if rows already exist, otherwise 0.

4) **Upload PCON boundaries (conditional)**
   - Runs only if `PCON_SKIP_BOUNDARIES != 1`.
   - Calls `python3 scripts/uk_aq_load_pcon_boundaries.py` with the downloaded GeoJSON, version, code/name fields, batch size, sleep, retries.
   - Populates `pcon_boundaries` in Supabase for the target version.

5) **Process PCON queue**
   - Calls Supabase RPC `uk_aq_process_station_pcon_queue` with `target_version = PCON_VERSION` and `batch_limit = PCON_QUEUE_BATCH_SIZE`.
   - The RPC assigns PCON codes to stations missing `pcon_code` using the boundaries, in small batches to reduce DB load.

## What assigns PCON codes
- The GitHub Action itself does not compute PCON; it loads boundaries (if missing) and invokes the DB RPC `uk_aq_process_station_pcon_queue` to update stations with null `pcon_code`.
- Queue/table details are described in `system_docs/table_info/station_pcon_queue.md` and related table docs (see `system_docs/table_info/uk_aq_pcon_boundaries.md`, `uk_aq_pcon_current.md`, `uk_aq_station_pcon_history.md`).

## Notes and guardrails
- Boundaries are only uploaded when absent for the target version (skip flag).
- Batch sizes and sleeps are configurable via secrets to avoid overloading Supabase.
- The workflow uses a dedicated concurrency group `uk-aq-pcon-refresh` so overlapping runs are allowed but serialized per group.
- The boundary loader also supports `--skip-if-exists` to avoid re-uploading when the target version is already present.
- If `PCON_QUEUE_BATCH_SIZE` is supplied as a GitHub secret, Actions will mask matching values in logs (e.g., a batch size of `10` appears as `***`). Prefer setting it as a GitHub Actions variable to keep logs readable.

## Related script
- `scripts/uk_aq_load_pcon_boundaries.py` performs the boundary upsert and optional station/history refresh when run directly. In this workflow it is used only to load boundaries when missing.

## How to run manually
- Trigger `UK-AQ PCON Refresh` in GitHub Actions (workflow_dispatch). Ensure secrets are populated and the Dropbox path contains the desired GeoJSON. The workflow will download the latest year unless `PCON_VERSION` and a direct file path are supplied.
