# services

Defines each SOS service instance (data source) and its polling configuration.

## Fields
- id: Internal bigint primary key (generated identity).
- service_ref: External service identifier (string), unique across services.
- label: Human-readable service name.
- service_url: Base URL for the SOS API.
- poll_enabled: Whether scheduled polling should run for this service (default true).
- poll_interval_minutes: Intended polling cadence in minutes (default 60).
- poll_window_hours: Lookback window for polling recent observations (default 6).
- poll_timeseries_batch_size: Max timeseries per polling batch (default 50).
- stations_bbox_supported: Whether the service supports bbox filtering for stations.
- timeseries_station_filter_supported: Whether the service supports station filters for timeseries.
- last_polled_at: Timestamp of the last successful poll.
- created_at: Row creation timestamp (default now()).

## Notes
- `service_ref` is unique; internal joins use `id`.
- Known services can override the bbox/station filter support flags on insert.
