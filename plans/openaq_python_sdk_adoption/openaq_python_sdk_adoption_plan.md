# OpenAQ Python SDK adoption plan for `uk-aq-ingest`

Date: 2026-06-24

Repository reviewed: `ChronicChannel-test/uk-aq-ingest`

Status: planning only. No repo files have been changed or committed.

## Executive summary

Your current production OpenAQ ingest is using direct HTTP calls, but it is not mainly a Python implementation.

The production path is currently Deno and TypeScript:

1. Cloud Run starts `workers/uk_aq_openaq_cloud_run/run_service.ts`.
2. The service launches `workers/uk_aq_openaq_cloud_run/run_job.ts`.
3. The wrapper starts the existing OpenAQ ingest implementation from `supabase/functions/ingest_openaq/index.ts`.
4. The wrapper calls that local ingest process over `http://127.0.0.1:<port>/`.
5. The ingest implementation calls `https://api.openaq.org/v3` using Deno `fetch()`.

There is also a Python OpenAQ station script at `scripts/openaq/openaq_list_stations.py`. That script already uses raw HTTP via `requests.Session`, so it is the best immediate candidate for the official OpenAQ Python SDK.

The SDK looks useful, but the best adoption route is not to rewrite the production ingest first. The safer route is:

1. Use the SDK first for Python station inventory and missing-station audit tooling.
2. Use the SDK to reduce custom Python HTTP code in `scripts/openaq/openaq_list_stations.py`.
3. Keep the production Deno ingest as-is initially, because it is tightly coupled to your existing checkpointing, shared request budget, Cloud Tasks scheduling, Dropbox logging, and observs write paths.
4. Only consider a production Python worker after parity testing proves the SDK can reproduce the same station, sensor, hourly measurement, checkpoint, and telemetry behaviour.

## OpenAQ SDK facts relevant to this plan

The OpenAQ Python SDK is now a stable-looking option. PyPI currently lists `openaq 1.0.3`, released 2026-06-19, as the latest release. It is described as the official OpenAQ Python SDK, requires Python 3.10 or newer, and is classified as production/stable.

Important packaging note: the `1.0.0`, `1.0.1`, and `1.0.2` releases are shown as yanked on PyPI because they were wheel-only releases. For a real dependency pin, prefer:

```txt
openaq>=1.0.3,<2
```

The SDK documentation lists the features that matter here:

- automatic rate limiting
- expressive error handling
- typed responses
- response objects instead of raw dictionaries
- HTTP connection pooling
- official support for Python 3.10 and newer

## Current OpenAQ implementation observed in the repo

### Production runtime

The Cloud Run image is Deno-based:

```txt
workers/uk_aq_openaq_cloud_run/Dockerfile
```

It uses `denoland/deno:2.1.4`, copies `run_job.ts`, `run_service.ts`, and the existing `supabase/functions/ingest_openaq/index.ts`, then starts the Deno service.

This means the official Python SDK cannot be imported directly into the current production ingest without changing the container and runtime shape.

### OpenAQ production HTTP path

The main OpenAQ implementation is:

```txt
supabase/functions/ingest_openaq/index.ts
```

It defines:

- `DEFAULT_BASE_URL = "https://api.openaq.org/v3"`
- `OPENAQ_API_KEY`
- `OPENAQ_BBOX`
- `OPENAQ_PAGE_LIMIT`
- `OPENAQ_CONCURRENCY`
- `OPENAQ_RATE_LIMIT_RETRIES`
- `OPENAQ_MAX_REQUESTS_PER_RUN`
- shared DB-backed OpenAQ budget settings

The function `openaqRequest()` builds a URL from `OPENAQ_BASE_URL`, sets query parameters, enforces request budget checks, reserves a shared token budget, and then calls:

```ts
fetch(url.toString(), { headers: openaqHeaders() })
```

It also parses OpenAQ rate limit headers and handles low remaining quota, `401`, `403`, and `429` responses.

Current OpenAQ endpoints used in production include:

- `locations?bbox=...&limit=...&page=...`
- `locations/{locationId}/latest?limit=1000`
- `sensors/{timeseriesRef}/measurements/hourly?datetime_from=...&datetime_to=...`

### Current rate-limit and budget protections

Your current implementation already has several layers of protection:

1. Per-run request budget using `OPENAQ_MAX_REQUESTS_PER_RUN`.
2. Shared DB-backed token budget via `uk_aq_rpc_openaq_token_budget_reserve`.
3. OpenAQ header parsing for `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `x-ratelimit-used`.
4. Stop when remaining quota is low.
5. Stop on `429`.
6. Cloud Run wrapper hourly guard using recent `uk_aq_ingest_runs.response_payload.requests_total`.
7. Cloud Tasks rescheduling based on next due checkpoint and rate-limit reset hints.

The SDK's automatic rate limiting is useful, but it should not replace all of these immediately. The SDK can handle client-level API politeness, but your existing system also needs global coordination across Cloud Run tasks, manual scripts, shared budget users, and run telemetry.

## Where the Python SDK would be useful

## Priority A: Python station inventory script

Target:

```txt
scripts/openaq/openaq_list_stations.py
```

This is the clearest near-term win because it is already Python and currently contains a custom OpenAQ HTTP client built on `requests.Session`.

Current custom code includes:

- manual API headers
- manual session creation
- manual minimum interval throttling
- manual `429` handling
- manual server error retries
- manual rate limit header parsing
- manual pagination for `locations`

Recommended change:

Create an SDK-backed adapter for the station list script while preserving the script's CLI, output formats, and DB writer behaviour.

Suggested shape:

```txt
scripts/openaq/lib/openaq_sdk_client.py
scripts/openaq/openaq_list_stations.py
```

The script can keep the same command examples:

```bash
python3 scripts/openaq/openaq_list_stations.py
python3 scripts/openaq/openaq_list_stations.py --format csv --output uk_openaq_stations.csv
python3 scripts/openaq/openaq_list_stations.py --to-supabase
```

But internally it should use the SDK to list locations rather than raw `requests.Session` calls.

Preserve the existing DB writer and shared budget logic until you have decided whether the SDK's rate limiting is sufficient for non-production station tools. For now, the safest pattern is to keep your shared budget wrapper around SDK calls where the script can consume the same global budget as the Cloud Run ingest.

Benefits:

- less custom OpenAQ HTTP code
- less duplicate rate-limit code
- better typed response handling
- easier autocomplete and inspection while debugging missing stations
- lower risk than changing the production ingest

## Priority A: Missing station and sensor audit tooling

The SDK is a very good fit for investigation scripts that compare OpenAQ's current catalogue against your Supabase tables.

Suggested new read-only scripts:

```txt
scripts/openaq/openaq_sdk_inventory.py
scripts/openaq/openaq_sdk_compare_db.py
scripts/openaq/openaq_sdk_missing_stations.py
```

Suggested outputs:

```txt
outputs/openaq/openaq_locations_<timestamp>.csv
outputs/openaq/openaq_sensors_<timestamp>.csv
outputs/openaq/openaq_missing_in_db_<timestamp>.csv
outputs/openaq/openaq_db_missing_upstream_<timestamp>.csv
```

These scripts should default to read-only and should not update Supabase unless explicitly passed a write flag.

Useful checks:

1. OpenAQ UK locations in bbox that are missing from `uk_aq_core.stations`.
2. OpenAQ sensors missing from `uk_aq_core.timeseries`.
3. Locations with no sensors.
4. Sensors with parameters outside your expected pollutant and met list.
5. Locations whose coordinates changed upstream.
6. Sensor ID changes for existing station refs.
7. Stations present in your DB but absent from the current OpenAQ response.
8. Parameter unit drift, such as `µg/m³` vs other units.
9. Provider and owner drift.
10. Differences between bbox search and point/radius searches around known missing stations.

This would help with the sort of missing-station problem you have been investigating, because you would have a repeatable catalogue comparison instead of relying on known station names.

## Priority B: SDK parity harness against current Deno ingest

Before using the SDK in production, build a parity harness.

Suggested script:

```txt
scripts/openaq/openaq_sdk_parity_probe.py
```

Inputs:

- station refs or OpenAQ location IDs
- sensor refs or OpenAQ sensor IDs
- `datetime_from`
- `datetime_to`
- bbox
- page limit

Outputs:

- SDK raw-ish JSON export
- current Deno ingest raw Dropbox ZIP comparison, where available
- CSV summary of row counts and timestamp coverage

Checks:

1. Same locations returned for the same bbox.
2. Same sensor IDs found for the same locations.
3. Same hourly measurement timestamps returned for the same sensor and time window.
4. Same interpretation of `datetime`, `period`, and `coverage` fields.
5. Same handling of future-looking timestamps.
6. Same handling of empty hourly pages.
7. Same pagination behaviour.
8. Same error classes for `401`, `403`, `429`, and server failures.

This is important because the current Deno ingest contains specific mapping logic for fields like `sensorsId`, `period.datetimeTo`, `period.datetimeFrom`, and `coverage.datetimeTo`. The SDK may expose these through typed classes rather than raw dictionaries, so parity tests should confirm that the same data can still be extracted.

## Priority C: Optional production Python worker spike

Only consider this after the station tooling and parity scripts are stable.

There are three possible production approaches.

### Option 1: Deno wrapper keeps control, Python SDK helper fetches OpenAQ only

A small Python helper process uses the SDK and returns normalized JSON to the existing Deno wrapper or ingest function.

Pros:

- lowest production migration risk
- keeps existing DB writes, observs writes, checkpointing, Cloud Tasks scheduling, and run telemetry
- allows SDK use where it matters most, the OpenAQ API requests

Cons:

- mixed runtime container
- Deno-to-Python subprocess boundary
- more deployment complexity

### Option 2: Full Python OpenAQ worker

Rewrite the OpenAQ Cloud Run worker in Python using the SDK.

Pros:

- cleanest SDK integration
- easier use of SDK types and connection pooling
- easier future OpenAQ-specific tooling

Cons:

- highest risk
- must reimplement lots of existing TypeScript logic
- must preserve Supabase RPC calls, observs outbox or Pub/Sub writes, Dropbox logging, shared budget, checkpointing, and Cloud Tasks scheduling
- likely not worth doing first

### Option 3: Keep production Deno direct HTTP and use SDK only for tooling

This is the recommended starting point.

Pros:

- no production runtime change
- immediate benefit for station discovery and missing-station checks
- avoids destabilising the current Cloud Run ingest
- keeps existing rate-limit telemetry and checkpoint behaviour

Cons:

- production ingest still has custom HTTP client code
- duplicate OpenAQ access patterns remain across Deno and Python

## Rate-limit strategy

The SDK's automatic rate limiting is a useful improvement, especially for Python tools. However, it should be treated as one layer, not the whole policy.

Keep these existing protections:

- DB-backed shared OpenAQ budget
- Cloud Run wrapper hourly guard
- per-run request cap
- run status telemetry in `uk_aq_ingest_runs`
- stop or defer behaviour when quota is low
- Cloud Tasks rescheduling based on reset time

Use the SDK to simplify:

- per-request waiting
- retry handling
- connection pooling
- typed response handling
- error classes

Do not rely only on SDK automatic rate limiting until it has been tested with your Cloud Tasks schedule and manual scripts. The SDK can protect one client process, but your DB-backed budget protects the whole system.

## Suggested phased implementation

## Phase 0: Confirm SDK API surface

Goal: confirm exact SDK methods and response shapes against the endpoints your ingest uses.

Tasks:

1. Add an optional dependency file:

```txt
requirements-openaq.txt
```

With:

```txt
openaq>=1.0.3,<2
```

2. Create a tiny SDK smoke-test script that only performs read-only calls.
3. Confirm SDK support for:
   - locations list by bbox
   - locations get by id
   - sensors for a location
   - hourly measurements for a sensor with date filters
   - pagination controls
   - rate-limit handling behaviour
4. Record exact SDK method names in `system_docs/openaq.md` or a new system doc.

Acceptance checks:

- smoke test works with `OPENAQ_API_KEY`
- no DB writes
- output includes at least one known OpenAQ location and sensor
- response objects can be converted to JSON or dictionaries for raw debug logging

## Phase 1: Migrate the Python station list script

Goal: replace raw Python `requests` OpenAQ access in `scripts/openaq/openaq_list_stations.py` with an SDK-backed client.

Tasks:

1. Archive the current script before changing it.
2. Keep CLI options and outputs stable.
3. Keep `--to-supabase` behaviour stable.
4. Keep provider/owner/station name mapping stable.
5. Keep DB writer unchanged.
6. Add a `--client raw|sdk` switch for initial parity, defaulting to `raw` for the first PR if you want a safer rollout.
7. After parity is proven, change default to `sdk` and keep `raw` as fallback for one release.

Acceptance checks:

- same or intentionally explained location count for the UK bbox
- same station refs for known examples
- same CSV columns
- same Supabase upsert behaviour in dry-run/parity mode
- no write behaviour unless `--to-supabase` is passed

## Phase 2: Add SDK inventory and missing-station audit scripts

Goal: create repeatable tools for finding OpenAQ stations and sensors missing from your DB.

Tasks:

1. Create SDK inventory export script.
2. Create DB comparison script.
3. Add point/radius search support for known missing station investigations.
4. Add bbox search support using the current UK bbox.
5. Add CSV and JSON outputs.
6. Make DB writes opt-in only.

Acceptance checks:

- shows OpenAQ location refs present upstream but absent from DB
- shows OpenAQ sensor refs present upstream but absent from DB timeseries
- shows DB station refs not returned by current upstream bbox query
- can run locally from `.env`
- can be used without modifying production data

## Phase 3: Build a production parity harness

Goal: test whether SDK-backed fetching can reproduce the current Deno ingest results.

Tasks:

1. Pick a fixed sample of station refs.
2. Include known tricky cases:
   - recently updated stations
   - stale stations
   - gap stations
   - stations with multiple sensors
   - stations with PM2.5, PM10, NO2, O3, and met sensors where available
3. Compare SDK hourly responses against current Deno fetch responses.
4. Compare derived observation rows before DB write.
5. Compare checkpoint update decisions.
6. Compare request counts and rate-limit stop behaviour.

Acceptance checks:

- same hourly timestamp coverage for each sensor
- same rows prepared before write, or differences documented
- no lost pollutant mappings
- no lost owner/provider metadata
- no unexpected unit changes
- no higher request count for equivalent coverage

## Phase 4: Decide whether to use SDK in production

Goal: decide using evidence rather than optimism.

Adopt the SDK in production only if the spike proves:

- same or better data completeness
- same or lower error rate
- no increase in `429` events
- request totals are still captured
- shared budget still works across all OpenAQ callers
- Cloud Tasks scheduling still respects rate-limit reset hints
- observs writes remain correct
- checkpoint behaviour remains correct

If those checks are not met, keep the SDK for tooling only.

## Files to add or change later

Suggested planning file in repo:

```txt
plans/openaq_python_sdk_adoption_plan.md
```

Suggested optional new files:

```txt
requirements-openaq.txt
scripts/openaq/lib/openaq_sdk_client.py
scripts/openaq/openaq_sdk_smoke.py
scripts/openaq/openaq_sdk_inventory.py
scripts/openaq/openaq_sdk_compare_db.py
scripts/openaq/openaq_sdk_missing_stations.py
scripts/openaq/openaq_sdk_parity_probe.py
system_docs/openaq_python_sdk.md
```

Suggested files to archive before editing:

```txt
scripts/openaq/openaq_list_stations.py
system_docs/openaq.md
system_docs/uk_aq_scripts.md
```

Use the normal archive pattern already used in the repo, for example:

```txt
archive/2026-06-24/openaq-python-sdk-adoption/changed-before/
```

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Runtime mismatch | Production ingest is Deno, SDK is Python | Start with Python scripts and audit tooling |
| SDK response shape differs from raw JSON | Current code relies on specific fields such as `sensorsId`, `period`, and `coverage` | Build parity harness before production use |
| Auto rate limiting is process-local | Your system needs global budget protection across Cloud Run and scripts | Keep DB-backed shared budget |
| Production telemetry could be lost | `uk_aq_ingest_runs.response_payload` drives scheduling and diagnostics | Preserve request totals and stop reasons |
| 1.0.0 package yanked | Installing exactly `1.0.0` may not be ideal | Pin `openaq>=1.0.3,<2` |
| Full rewrite scope creep | Current ingest also handles DB writes, observs, Dropbox, checkpoints, and Cloud Tasks | Do not rewrite production first |

## Recommendation

Use the OpenAQ Python SDK now, but start where it is naturally useful:

1. Replace or wrap the existing Python station inventory script.
2. Add SDK-based read-only audit tools for missing stations and missing sensors.
3. Keep the production Deno ingest unchanged until SDK parity is proven.
4. Keep your existing shared budget and hourly wrapper guard even when SDK auto rate limiting is used.
5. Reconsider production SDK use only after Phase 3 parity checks pass.

The most valuable near-term outcome is not a production rewrite. It is a reliable OpenAQ catalogue audit tool that can tell you which UK locations and sensors OpenAQ currently exposes, which ones your DB has, and which ones are missing from either side.
