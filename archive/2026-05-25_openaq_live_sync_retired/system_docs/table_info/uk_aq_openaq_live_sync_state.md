# uk_aq_openaq_live_sync_state

Schema: `uk_aq_ops`

Purpose:
- Tracks lock/cursor/status for LIVE -> TEST OpenAQ mirror runs.
- Prevents overlapping mirror runs per mode (`observations`, `core`, `reseed`).

Primary key:
- `job_name` (`observations` | `core` | `reseed`)

Key columns:
- `cursor_observed_at`, `cursor_timeseries_id`: observation delta cursor.
- `cursor_core_synced_at`: core metadata sync watermark.
- `lock_owner`, `lock_acquired_at`, `lock_expires_at`: lease-based run lock.
- `last_run_started_at`, `last_run_finished_at`, `last_status`, `last_error`: run status.
- `rows_read`, `rows_written_ingest`, `rows_written_observs`: latest run counters.
- `updated_at`: last state update timestamp.

Timestamp note:
- Timestamp columns use `timestamptz` and are displayed in UTC for this project.

Writers/readers:
- Writer/reader RPCs (schema `uk_aq_public`):
  - `uk_aq_rpc_openaq_live_sync_lock_acquire`
  - `uk_aq_rpc_openaq_live_sync_lock_release`
  - `uk_aq_rpc_openaq_live_sync_state_get`
- Consumed by edge function: `supabase/functions/uk_aq_sync_openaq_from_live`.
