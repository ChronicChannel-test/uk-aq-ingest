# UK-AQ PCON lookup workflow (end-to-end logic)

This document explains **how PCON codes get updated**, which script and workflow does the work, how many stations are processed at once, and where the work happens (Supabase vs GitHub Actions).

## Components involved

### 1) GitHub Actions workflow
**File:** `.github/workflows/uk_aq_pcon_lookup.yml`

**Purpose:**
- Runs on a schedule (every 10 minutes) or manually.
- Invokes the batch script that fills missing PCON codes for stations.

**When it runs:**
- Scheduled: `*/10 * * * *` (every 10 minutes).
- Manual: via `workflow_dispatch`.

### 2) Batch script
**File:** `scripts/uk_aq_pcon_lookup_batch.py`

**Purpose:**
- Fetch a small batch of stations that have geometry but no `pcon_code`.
- Look up a PCON code for each station.
- Update the station record in Supabase.

### 3) SQL helper (optional station-name reuse)
**Function:** `uk_aq_station_name_for_point(target_point)`

**Purpose:**
- If a station is missing `station_name`, this function can reuse the name from another station at the exact same coordinates.
- Keeps naming consistent without needing external geocoding.

## End-to-end flow (current implementation)

### Step 1: GitHub Action kicks off
- The workflow runs every 10 minutes.
- It starts a single job with a 10‑minute timeout.
- It installs Python dependencies from `requirements-dev.txt`.

### Step 2: (Optional) download GeoJSON
- The workflow **can download a boundary file**, but this is currently optional.
- The current batch script **does not read that file yet**; it still uses MapIt for lookups.

### Step 3: Batch script selects stations
The script fetches stations from Supabase that meet these conditions:
- `geometry` **is not null**
- `pcon_code` **is null**

**Batch size:**
- Default `--limit 10` (the workflow runs with `--limit 10`).

### Step 4: PCON lookup per station
For each station in the batch:
1. Extract lon/lat from `geometry`.
2. Look up PCON using **MapIt** (current implementation).
3. If the station has no `station_name`, try to reuse a name from an exact coordinate match (via `uk_aq_station_name_for_point`).
4. Update `stations.pcon_code` and `stations.pcon_version` (and optionally `station_name`).

### Step 5: Throttling + timing
- The script sleeps between stations (default `--sleep-seconds 1.0`, workflow uses `--sleep-seconds 2`).
- It stops early if it exceeds `--max-seconds` (workflow uses `--max-seconds 300`).

## How many stations are processed at once?
- **10 stations per run** (current workflow setting).
- With a run every 10 minutes, that means **~1 station per minute on average**, before retries.

## Does it still call Supabase, or is work done in GitHub Actions?
**Both:**
- **GitHub Actions** runs the script and does the external lookup work.
- **Supabase** is still used for:
  - selecting missing stations,
  - updating `pcon_code`/`pcon_version`,
  - reusing `station_name` via SQL function.

So the workflow **reduces heavy spatial joins in Supabase**, but still uses Supabase for reading and writing station rows.

## Why the script still waits (even as a GitHub Action)
Even though GitHub Actions runs on its own schedule, the script **still uses sleep** to:
- avoid hitting external APIs too fast (MapIt or other geocoders),
- reduce the chance of rate limits,
- keep resource usage stable.

If you move the lookup fully local (using a GeoJSON file + spatial engine on the runner), the sleep can be reduced or removed. Until then, it is a safety valve.

## Planned Dropbox directory flow (no URL sharing)
If you want **Dropbox directory-based selection** by geo type and year, the plan is:

1. **Inputs**:
   - `geo_type` (e.g., `PCON`)
   - `year` or `latest`
2. **List years**:
   - Call `files/list_folder` on `/GEOJSON/{geo_type}`.
   - Parse folder names like `2022`, `2024`.
3. **Resolve year**:
   - If `latest`, choose the highest year found.
4. **Pick file**:
   - Call `files/list_folder` on `/GEOJSON/{geo_type}/{year}`.
   - Select the single `.geojson` file (or apply a naming rule if multiple).
5. **Download**:
   - Use `files/download` to fetch into the runner.
6. **Run lookup**:
   - Use the local GeoJSON to resolve PCON codes instead of MapIt.

**Where this runs:**
- A small helper step in the GitHub Action (Python or shell).
- The batch script reads the downloaded GeoJSON to do local point‑in‑polygon matching.

## What changes if PCON lookup is done locally
If you switch to local GeoJSON lookups:
- **Supabase load drops** (no spatial joins needed in DB).
- **MapIt can be removed** (no API calls).
- **Sleep can be reduced** (no rate limits).
- **GitHub Actions does more work** (point‑in‑polygon on runner).

## Summary checklist (current state)
- ✅ GitHub Action schedules work every 10 minutes.
- ✅ Script processes 10 stations per run.
- ✅ Supabase used for reading/updating stations + station_name reuse.
- ✅ External PCON lookup currently uses MapIt.
- ✅ Workflow supports downloading a GeoJSON file (not yet used by the script).

## Summary checklist (target state)
- ✅ GitHub Action still schedules work every 10 minutes.
- ✅ Script still processes 10 stations per run.
- ✅ Supabase used only for reads/writes.
- ✅ PCON lookup uses local GeoJSON from Dropbox directory structure.
- ✅ MapIt dependency removed.
