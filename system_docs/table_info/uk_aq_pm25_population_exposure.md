# pm25_population_exposure

PM2.5 Population Exposure Indicator (PEI) tracking by year.

## Fields
- id: Internal bigint primary key (generated identity).
- year: Year (unique).
- pei_base: Baseline PEI value.
- pei: PEI value for the year.
- yearly_change: Year-over-year change.
- cumulative_change: Cumulative change since baseline.
- cumulative_change_pct: Cumulative percent change since baseline.
- collected_at: Timestamp of data collection (default now()).

## Notes
- Uniqueness is enforced on year.
