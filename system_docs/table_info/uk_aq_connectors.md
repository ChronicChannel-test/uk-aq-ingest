# connectors

Defines each network connector and its polling configuration.

## Fields
- id: Internal bigint primary key (generated identity).
- connector_code: Short connector code used as filename prefix for connector outputs.
- label: Source label from the upstream service.
- display_name: UI-friendly connector name (curated).
- station_display_name_template: Template for station display names, with tokens `{station_name}`, `{station_label}`, `{station_ref}`.
- service_url: Base URL for the SOS API (if applicable).
- overwrite_station_name: Whether station ingests may overwrite existing `stations.station_name` values (default true).
- poll_enabled: Whether scheduled polling should run for this connector (default true).
- poll_interval_minutes: Intended polling cadence in minutes (default 60).
- poll_window_hours: Lookback window for polling recent observations (default 6).
- poll_timeseries_batch_size: Max timeseries per polling batch (default 50).
- stations_bbox_supported: Whether the connector supports bbox filtering for stations.
- timeseries_station_filter_supported: Whether the connector supports station filters for timeseries.
- last_polled_at: Timestamp of the last successful poll.
- created_at: Row creation timestamp (default now()).

## Notes
- `connector_code` is unique; internal joins use `id`.
- Known connectors can override the bbox/station filter support flags on insert.
- Cron dispatchers in `supabase/uk_aq_polling_cron.sql` skip polling when `poll_enabled` is false.
