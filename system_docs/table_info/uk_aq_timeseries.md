# timeseries

Metadata for each SOS timeseries. One row per unique series in a connector/service_ref.

## Fields
- id: Internal bigint primary key (generated identity).
- timeseries_ref: External SOS timeseries identifier (string), unique per service_ref.
- label: Human-readable name for the series.
- uom: Unit of measure for values (as provided by the service).
- station_id: FK to `stations.id` for the monitoring site.
- connector_id: FK to `connectors.id` for the SOS connector.
- service_ref: External SOS service identifier (string).
- offering_id: FK to `offerings.id` (logical grouping) when provided.
- feature_id: FK to `features.id` (feature of interest) when provided.
- procedure_id: FK to `procedures.id` (sensor/method) when provided.
- phenomenon_id: FK to `phenomena.id` (pollutant/parameter) when provided.
- category_id: FK to `categories.id` when provided.
- first_value_at: Earliest observed timestamp seen for this series.
- last_value_at: Most recent observed timestamp seen for this series.
- last_value: Most recent observed value (for quick status checks).
- extras: Raw metadata blob from the SOS response (JSONB).
- rendering_hints: Optional rendering hints from the SOS response (JSONB).
- status_intervals: Optional status interval metadata from the SOS response (JSONB).
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (connector_id, service_ref, timeseries_ref).
- `last_value_at` and `last_value` are updated by the ingest process to track freshness.
