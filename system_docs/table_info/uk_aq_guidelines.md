# uk_aq_guidelines

Air quality guideline limits (WHO/UK/EU, etc.).

## Fields
- id: Internal bigint primary key (generated identity).
- pollutant: Pollutant name (e.g., pm2.5).
- averaging_period_label: Human-readable averaging period.
- averaging_period_interval: Interval representing the averaging period.
- level_label: Limit level label (e.g., AQG_2021).
- limit_value: Numeric limit value.
- uom: Unit of measure.
- source: Optional data source label.
- notes: Optional notes.
- valid_from: Optional start date for validity.
- valid_to: Optional end date for validity.
- created_at: Row creation timestamp (default now()).

## Notes
- Uniqueness is enforced on (pollutant, averaging_period_label, level_label, source).
