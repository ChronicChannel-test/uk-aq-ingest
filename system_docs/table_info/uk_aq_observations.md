# observations

Raw time-value observations for each timeseries. One row per timestamp per series.

## Fields
- timeseries_id: FK to `timeseries.id` (the series these values belong to).
- observed_at: Timestamp for the observation (timestamptz).
- value: Numeric reading (nullable if the series reports a missing value).
- status: Optional status flag from the source (string).
- created_at: Row creation timestamp (default now()).

## Notes
- Primary key is (timeseries_id, observed_at) to prevent duplicates per timestamp.
- An index on `observed_at` supports time-based queries across series.
