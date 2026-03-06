# IQAir integration plan for `uk-aq-ingest`

## Goal

Add IQAir as a **non-SOS connector** that can ingest UK IQAir data into the existing UK AQ ingest pipeline without disrupting the current connector model.

The plan below is designed to fit the repo conventions already in use:

- non-SOS networks live under `scripts/<network>/`
- non-SOS connectors are 1:1 with their network
- Cloud Run workers reuse the existing connector claim / run-recording flow where possible
- new network docs should be added under `system_docs/`

## What IQAir appears to expose

Based on the current IQAir API docs and support pages, the documented public API surface I could confirm is centered on:

- listing supported `countries`
- listing `states` for a country
- listing `cities` for a state + country
- fetching real-time `city` and `station` level data
- real-time weather data
- AQI values on the free plan, with pollutant concentrations available on higher paid tiers

IQAir’s published API plan page currently says the free Community plan is limited to **5 calls/minute, 500/day, 10,000/month**. That same page says the free plan includes **city and station level data**, **overall AQI (US & China)** and **real-time weather data**, while pollutant concentrations are listed for higher paid plans. I also found support guidance saying supported stations are **updated on an hourly basis**, though some stations may publish several hours late.

## Important constraint for UK-wide ingest

The biggest design constraint is **API call budget**.

If UK coverage must be discovered via:

1. `countries`
2. `states?country=United Kingdom`
3. `cities?state=...&country=United Kingdom`
4. one `city` or `station` request per place

then a full UK sweep can become expensive very quickly on the free plan.

That makes IQAir a good fit for **selective polling of a curated UK station/city inventory**, but a poor fit for wide frequent crawling unless you move to a paid plan.

## Unknowns I would treat as open until you test with a key

1. Whether the free plan returns enough **stable station identity** fields for clean timeseries upserts.
2. Whether UK data is best accessed through **city** endpoints, **station** endpoints, or both.
3. Whether a documented **bulk/historical** API exists for your plan. I could confirm real-time endpoints and device/dashboard export guidance, but I did **not** find a clearly documented public bulk UK historical endpoint suitable for backfill.
4. Whether IQAir’s UK coverage is mostly:
   - IQAir-owned devices
   - community devices
   - regulatory feeds re-published by IQAir
   - or a mix.

## Integration options

## Option A. City-level ingest only

### Summary
Use IQAir as a **city feed**, where each UK city becomes one logical station in your DB.

### Pros
- Lowest implementation complexity.
- Lowest API usage.
- Easiest to stay within the free plan if the UK city list is kept small.
- Small DB footprint because each city yields relatively few timeseries.

### Cons
- Loses source granularity if IQAir city values are aggregates from multiple stations.
- May not match your project’s preference for actual station/timeseries entities.
- Harder to compare with other networks on a like-for-like station basis.

### Egress / DB-size impact
- **Supabase egress:** low, because ingest writes are server-side and the object count stays modest.
- **DB size:** low to moderate.
- **External API usage:** lowest of all options.

## Option B. Station-level ingest from a curated UK inventory

### Summary
Build and maintain a **fixed inventory of UK IQAir stations/cities you actually want**, then poll only those on an hourly schedule.

### Pros
- Best match for your existing connector/timeseries model.
- Keeps API usage predictable.
- Lets you choose only meaningful UK coverage.
- Easier to dedupe and keep stable station refs once the inventory is frozen.

### Cons
- Requires an initial discovery/bootstrap step.
- Coverage can drift if IQAir adds, removes or renames stations.
- You need a refresh workflow for the inventory.

### Egress / DB-size impact
- **Supabase egress:** low.
- **DB size:** moderate and controllable because station count is capped by your curated inventory.
- **External API usage:** moderate and predictable.

## Option C. Full UK discovery + rolling poller

### Summary
Continuously discover UK states/cities/stations and poll everything IQAir exposes for the UK.

### Pros
- Maximum coverage.
- Minimal manual curation.

### Cons
- Very likely to hit free-plan limits.
- More complex retry/rate-limit handling.
- Greater risk of station churn, duplicates and unstable refs.
- More DB growth for a network that may overlap heavily with sources you already ingest.

### Egress / DB-size impact
- **Supabase egress:** still not the main problem.
- **DB size:** highest of the three options.
- **External API usage:** highest, and likely the blocking factor on the free plan.

## Recommendation

**Pick Option B: station-level ingest from a curated UK inventory.**

That is the best fit for your current ingest architecture because it preserves the connector/station/timeseries model, keeps the IQAir API budget under control, and avoids turning a rate-limited third-party API into a fragile wide crawler.

A good first phase is:

- bootstrap the UK inventory once
- freeze it into repo data files and/or DB reference tables
- poll only that fixed inventory hourly
- add a separate manual or weekly refresh job for inventory changes

## Proposed repo shape

```text
network_info/
  IQAir/
    README.md
    iqair_uk_inventory_seed.json
    iqair_field_mapping.csv

scripts/
  iqair/
    iqair_api.py
    iqair_discover_uk.py
    iqair_ingest.py
    iqair_normalize.py

workers/
  uk_aq_iqair_cloud_run/
    README.md
    Dockerfile
    service_entrypoint.py

system_docs/
  iqair.md
```

## Connector model

Use IQAir as a standard **non-SOS connector**.

Suggested defaults:

- `connector_code`: `iqair`
- `service_ref`: `iqair`
- `label`: `IQAir`
- `display_name`: `IQAir`

Because your repo notes say non-SOS connectors are 1:1 with their network, IQAir should live in `connectors`, not in `uk_air_sos_networks`.

## Recommended implementation phases

## Phase 1. Research spike and inventory bootstrap

### Deliverables
- `network_info/IQAir/README.md`
- `scripts/iqair/iqair_discover_uk.py`
- a seed inventory file such as `network_info/IQAir/iqair_uk_inventory_seed.json`

### What this step should do
1. Call `countries` and confirm the exact country label IQAir expects for the UK.
2. Call `states` for the UK.
3. Call `cities` for each returned UK state/country combination.
4. For each candidate city, fetch one real-time record and capture:
   - source identifiers
   - display names
   - coordinates
   - available pollutants / AQI fields
   - timestamp field
   - any station/source metadata
5. Produce a deduped inventory of places/stations worth ingesting.

### Output shape to aim for
```json
[
  {
    "station_ref": "iqair:station:...",
    "city_ref": "iqair:city:...",
    "station_name": "...",
    "city": "...",
    "state": "...",
    "country": "United Kingdom",
    "latitude": 0,
    "longitude": 0,
    "pollutants": ["pm25", "pm10", "no2"],
    "active": true
  }
]
```

### Why Phase 1 matters
This is where you verify the two risky assumptions:

- whether IQAir gives you stable enough IDs
- whether station-level ingest is actually available/useful for your plan

## Phase 2. Normalization contract

### Deliverables
- `scripts/iqair/iqair_normalize.py`
- `network_info/IQAir/iqair_field_mapping.csv`

### Normalization rules
Map IQAir payloads into your existing entities:

- **connector**: `iqair`
- **station**: one per curated IQAir station or city surrogate
- **timeseries**: one per station + pollutant + averaging period + unit
- **observation**: one per `(connector_id, timeseries_id, observed_at)`

### Suggested source-to-project mapping
- `station_ref`: stable IQAir station identifier if present, otherwise a deterministic hash from country/state/city/name/lat/lon
- `station_code`: `iqair_<sanitized-stable-id>`
- `timeseries_ref`: `iqair:<station_ref>:<pollutant>:hourly`
- `unit`: likely `ug/m3` for pollutant concentrations where available
- `observed_at`: IQAir timestamp as UTC

### Pollutants to ingest
Treat these as opportunistic rather than guaranteed:

- `pm25`
- `pm10`
- `no2`
- `o3`
- `so2`
- `co`
- AQI values if that is all the plan returns

If the free plan only gives AQI + weather for your key, I would still ingest it, but I would store it as an **AQI-only connector** and keep it clearly separate from raw pollutant networks.

## Phase 3. Ingest script

### Deliverables
- `scripts/iqair/iqair_api.py`
- `scripts/iqair/iqair_ingest.py`

### Script responsibilities

`iqair_api.py`
- auth and base URL handling
- rate-limit aware GET helper
- retry/backoff for 429/5xx
- payload validation

`iqair_ingest.py`
- load curated UK inventory
- fetch current IQAir data for scoped stations/cities
- normalize payloads
- upsert stations/timeseries if needed
- upsert observations
- write ingest run summary

### Environment variables
```bash
IQAIR_BASE_URL=https://api.airvisual.com/v2
IQAIR_API_KEY=...
IQAIR_CONNECTOR_CODE=iqair
IQAIR_SERVICE_REF=iqair
IQAIR_SERVICE_LABEL=IQAir
IQAIR_LOG_LEVEL=INFO
IQAIR_DEFAULT_WINDOW_HOURS=6
IQAIR_BATCH_LIMIT=50
IQAIR_MIN_POLL_INTERVAL_MINUTES=60
```

## Phase 4. Scheduler / worker integration

### Recommendation
Model IQAir more like your **OpenAQ non-SOS Cloud Run worker** than the UK-AIR SOS worker.

Reason:
- IQAir is a non-SOS connector.
- It is externally rate-limited.
- A self-scheduling worker or one-off Cloud Tasks model is a better fit for bounded batches than broad dispatcher-style SOS fanout.

### Deliverables
- `workers/uk_aq_iqair_cloud_run/README.md`
- `workers/uk_aq_iqair_cloud_run/Dockerfile`
- runtime entrypoint
- new edge/local ingest wrapper if needed

### Runtime behaviour
1. Check connector due state in `uk_aq_core.connectors`.
2. Claim the connector via the existing dispatch claim RPC.
3. Select the next batch of IQAir inventory rows due for polling.
4. Run one bounded ingest batch.
5. Record status in ingest runs / error logs.
6. Schedule the next run conservatively.

### Batch strategy
Because IQAir says supported stations update hourly and can be late, start with:

- poll interval: **60 minutes**
- stale allowance: **up to 3 hours** before treating missing updates as late/problematic
- batch size: tuned to remain comfortably under daily call limits

## Phase 5. Documentation updates

Per your repo notes, when this is implemented you should also update:

- `system_docs/uk_aq_scripts.md`
- add `system_docs/iqair.md`
- add `network_info/IQAir/...` supporting files
- if you add a Supabase edge function under `supabase/functions/`, update `.github/workflows/supabase_edge_deploy.yml`
- if edge logic changes, update `system_docs/uk_aq_edge_functions.md`

## Backfill position

I would plan IQAir as **forward ingest only** unless your chosen paid plan clearly exposes historical endpoints or bulk export suitable for automated backfill.

For now, the safest assumption is:

- current real-time ingest: **yes**
- automated historical UK-wide backfill: **not yet confirmed**

So the plan should avoid coupling IQAir to your HistoryDB backfill pipeline until you have verified that with a live key and documentation.

## Data quality notes

IQAir says its platform combines data from ground-based stations, regulatory monitors, satellite inputs and weather/climate data, and it applies validation/calibration and machine learning. That is useful for consumer-facing AQ information, but for your project it means IQAir may be a **derived/published network**, not always a direct primary-source measurement feed.

Because of that, I would tag IQAir clearly in metadata so you always know when a chart is showing IQAir-derived values rather than direct network-native values.

## Suggested acceptance criteria

1. A live API key can enumerate UK coverage and build a stable curated inventory.
2. The ingest path can upsert IQAir stations/timeseries/observations idempotently.
3. Hourly polling stays within your selected IQAir plan limits.
4. Late timestamps do not create duplicate observations.
5. IQAir records are clearly identifiable as `connector_code=iqair` in downstream queries.
6. The implementation adds the required docs under `system_docs/` and `network_info/`.

## First implementation checklist

- Create IQAir API key in IQAir dashboard.
- Run a discovery script against UK country/state/city endpoints.
- Inspect 20 to 50 UK samples manually.
- Decide whether the payload is station-level enough for your schema.
- Freeze a first curated inventory.
- Implement the ingest script against that inventory.
- Add worker scheduling.
- Only then decide whether paid-plan upgrade is worth it.

## Practical recommendation in one line

Treat IQAir as a **curated, rate-limited, non-SOS connector**, not as a full-UK wide crawler.

## Sources

- IQAir API docs: https://api-docs.iqair.com/
- IQAir API plan page: https://www.iqair.com/gb/commercial-air-quality-monitors/api
- IQAir support: access API keys: https://www.iqair.com/support/knowledge-base/access-airvisuals-aqi-air-quality-and-pollution-api
- IQAir support: timestamps and update behaviour: https://www.iqair.com/support/knowledge-base/airvisual-api-timestamp-how-does-it-work
- IQAir support: station API link from dashboard: https://www.iqair.com/me/support/knowledge-base/how-do-i-get-my-stations-data-through-api
- Repo README: https://raw.githubusercontent.com/ChronicChannel-test/uk-aq-ingest/main/README.md
- Repo AGENTS notes: https://raw.githubusercontent.com/ChronicChannel-test/uk-aq-ingest/refs/heads/main/AGENTS.md
- Repo scripts doc: https://raw.githubusercontent.com/ChronicChannel-test/uk-aq-ingest/main/system_docs/uk_aq_scripts.md
- Existing OpenAQ worker pattern: https://raw.githubusercontent.com/ChronicChannel-test/uk-aq-ingest/main/workers/uk_aq_openaq_cloud_run/README.md
- Existing UK-AIR SOS worker pattern: https://raw.githubusercontent.com/ChronicChannel-test/uk-aq-ingest/main/workers/uk_aq_uk_air_sos_cloud_run/README.md
