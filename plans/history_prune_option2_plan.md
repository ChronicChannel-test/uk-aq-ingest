# History Prune Option 2 Plan (3-Day Hot Window + Pre-Prune Backup/Aggregation)

## Goal
- Keep HistoryDB within the 32-day / 500 MB target by retaining a 3-day hot write window.
- Keep ingest DB retention at 7 days.
- Preserve raw observation granularity in HistoryDB.
- Add pre-prune safeguards so older data is backed up and queryable before prune runs.

## Scope
- Applies to the ingest prune service flow.
- Adds pre-prune backup and aggregation stages that run before any ingest-row deletion.
- Adds repair logic for missing history rows.

## Why This Option
- A wider hot window (7-8 days) increases permanent history index size and risks crossing the 500 MB target.
- A 3-day hot window is storage-efficient, but needs explicit repair handling for older late/missed rows.
- This option keeps low permanent storage growth while maintaining recoverability.

## Execution Order (Single Prune Run)
1. Acquire run lock and compute UTC boundaries.
2. Phase A: Recent-window history completeness check (last 3 UTC days).
3. Phase B: Backup ingest rows older than 7 days to Cloudflare R2 as Parquet.
4. Phase C: Build/refresh `aggregated_daily` for the same older-than-7-day set.
5. Phase D: Cold completeness check for prune candidates (>7 days), enqueue repair tasks for missing history.
6. Phase E: Cold repair worker step (temporary reheat per day when required).
7. Phase F: Prune ingest rows older than 7 days only when backup + aggregation + repair prerequisites pass.
8. Emit run summary and alerts.

## Phase Details

### Phase A: Recent 3-Day Completeness Check
- Check ingest vs history completeness for the last 3 UTC days.
- If gaps are found in this window, replay through normal history upsert path (already indexed/hot).
- Do not delete ingest rows in this phase.

### Phase B: R2 Parquet Backup (Pre-Prune)
- Source: ingest rows with `observed_at < now_utc - interval '7 days'`.
- Output: partitioned Parquet files in Cloudflare R2 by UTC day (and optionally connector).
- Write a manifest per run:
  - day_utc
  - source_row_count
  - parquet_object_keys
  - file_count
  - checksum/hash
  - backed_up_at_utc
- Backup success for a day is required before that day can be pruned.

### Phase C: `aggregated_daily` Build (Pre-Prune)
- Build daily aggregates from the same older-than-7-day ingest slice.
- Store in a separate `aggregated_daily` database/schema/table set.
- Keep HistoryDB raw granularity unchanged.
- Aggregation success for a day is required before that day can be pruned.

### Phase D: Cold Completeness Check (>7 Days)
- For prune-candidate days, compare ingest day totals vs history day totals (or checksum/fingerprint where available).
- If missing in history, create a repair queue entry keyed by day.
- Mark day state as `repair_required`.

### Phase E: Cold Repair via Temporary Reheat
- For one queued day at a time:
  - Create temporary unique key index on that day partition:
    - `(connector_id, timeseries_id, observed_at)`
  - Replay missing rows for that day.
  - Validate completeness.
  - Drop temporary unique index.
- Retry with bounded attempts and backoff.
- On repeated failure or stale age SLA breach, send Dropbox error report and keep day blocked from prune.

### Phase F: Safe Prune Gate
- A day may be pruned only if all are true:
  - Backup complete in R2.
  - `aggregated_daily` complete.
  - History completeness marked resolved (or no repair needed).
- If any gate fails, skip prune for that day and log reason.

## Data/Control Additions
- Add prune run state fields (or tables) for per-day gate status:
  - `backup_done`
  - `aggregate_done`
  - `history_repair_status` (`not_required|queued|in_progress|resolved|failed`)
- Add `history_cold_repair_queue` with:
  - day_utc
  - status
  - attempts
  - last_error
  - next_retry_at
  - created_at / updated_at

## Alerting
- Dropbox alert conditions:
  - cold repair exceeds max attempts
  - queued repair older than SLA (example: 24h)
  - backup or aggregate phase fails for a prune-eligible day
- Include run_id, day_utc, counts, error summary, and recommended next action.

## Egress and DB Size Impact
- Supabase endpoint egress:
  - Expected near-neutral; this is primarily write/control-path work.
- Upload/write traffic:
- Increases from backup manifest writes, repair queue writes, and replay writes.
- HistoryDB size:
  - Permanent growth remains aligned with 3-day hot window.
  - Temporary size increase only during day-level reheat index creation.
- Ingest DB size:
  - 7-day retention unchanged.
  - Small overhead for queue/state metadata tables.

## Operational Notes
- Run pre-prune phases before deletion in the same service run to avoid race windows.
- Keep all day boundaries in UTC.
- Process cold repair one day at a time to cap lock and resource impact.
- Keep replay idempotent and deduplicated on `(connector_id, timeseries_id, observed_at)`.

## Acceptance Criteria
- No prune deletion occurs without successful backup + aggregation + history completeness gates.
- Recent 3-day completeness gaps are auto-repaired without manual intervention.
- Cold repair queue drains within SLA under normal load.
- HistoryDB remains on 3-day hot window policy.
- 32-day history footprint remains compatible with 500 MB target trajectory.
