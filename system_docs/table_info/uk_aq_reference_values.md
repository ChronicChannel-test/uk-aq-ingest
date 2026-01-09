# reference_values

Reference lines attached to a timeseries (for charting thresholds or targets).

## Fields
- id: UUID primary key (generated).
- timeseries_id: FK to `timeseries.id`.
- name: Label for the reference line.
- color: Suggested display color (string).
- value: Numeric threshold/target value.
- created_at: Row creation timestamp (default now()).

## Notes
- Rows are optional and only present when the source provides reference values.
