# OpenAQ "NO2 mass" label trace (connector 6, station_id=16488, timeseries_ref=4815)

## Scope and method
- Searched the repo for label construction, units handling, and OpenAQ timeseries upserts.
- Traced both OpenAQ workflows:
  1. `scripts/openaq/openaq_list_stations.py` (list-stations sync)
  2. `supabase/functions/ingest_openaq/index.ts` (measurements ingest)

## Direct evidence for the specific example
- The station/timeseries pair appears in project output with label `2488 NO₂ mass`:
  - `station_id=16488`, `station_ref=2488`, `timeseries_ref=4815`, connector `openaq`.  
  (`plans/uk_aq_station_duplicate_candidates_long.csv`, row shown at line 132)
- The OpenAQ raw payload for sensor `id=4815` contains:
  - `parameter.name = "no2"`
  - `parameter.units = "µg/m³"`
  - `parameter.displayName = "NO₂ mass"`

## Where the label is set

### A) List-stations workflow (`scripts/openaq/openaq_list_stations.py`)
- `_collect_timeseries_rows(...)` sets timeseries label as:
  - `f"{station_ref} {display_name if present else name}"`
- For sensor `4815` at location `2488`, this yields `"2488 NO₂ mass"` because `displayName` from provider is `NO₂ mass`.
- `upsert_timeseries(...)` writes this row into `uk_aq_core.timeseries` and on conflict updates `label` and `uom`.

### B) Measurements ingest workflow (`supabase/functions/ingest_openaq/index.ts`)
- If `OPENAQ_INGEST_STATION_FETCH` is enabled, ingest fetches locations/sensors and also builds timeseries rows with label:
  - ```${locationId} ${parameter.displayName ?? parameter.name}```
- It then calls `upsertTimeseries(timeseriesRows)`.
- If `OPENAQ_INGEST_STATION_FETCH` is disabled, ingest does **not** build/upsert timeseries labels; it loads existing refs and only upserts observations + last values.

## Is "mass" added internally?
- No internal rule appending `mass` was found in OpenAQ list-stations or ingest code.
- The `mass` text comes from OpenAQ provider field `parameter.displayName` (`NO₂ mass`) and is passed through.
- `units` (`µg/m³`) are stored in `uom` directly; there is no condition like "if µg/m³ then append mass" in these paths.

## Which workflow is responsible here?
- For this specific case, the label value is provider-derived and can be set by:
  1. list-stations sync, and
  2. ingest run **only when** station fetch is enabled.
- In typical measurements-only runs (`OPENAQ_INGEST_STATION_FETCH` false), labels are not rewritten by ingest.
- If both workflows run with timeseries upsert enabled, "last write wins" because both upserts update `timeseries.label` on conflict.

## Minimal fix option (no implementation)
- Minimal reversible option: keep current API/data contracts, but prefer `parameter.name` for `timeseries.label` and store provider `displayName` in metadata/extras for UI use.
  - This avoids hard-coding `mass` into canonical label while preserving source fidelity.

## Next-step edit shortlist (if you want a change)
- Add a tiny label-normalization helper used in **both**:
  - `scripts/openaq/openaq_list_stations.py`
  - `supabase/functions/ingest_openaq/index.ts`
- Rule option: use `displayName` only when explicitly requested; default to `name` for canonical label.
- Keep `uom` unchanged and preserve raw provider display text in metadata for debugging/UI.
