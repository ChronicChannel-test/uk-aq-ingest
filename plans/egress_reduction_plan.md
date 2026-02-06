# Supabase Egress Reduction Plan (UK AQ)

Date: 2026-02-02
Scope: Analysis and plan only; no code changes performed.
Status update: 2026-02-06 (tracked against current repos).

Status markers:
- ✅ Done
- 🎯 Next (highest impact)
- ⏳ Pending
- [ONLY IF NECESSARY] Defer unless needed after higher-priority changes

This plan is based on the authoritative cross-repo READMEs and a scan of all five repos for Supabase-related network calls, polling patterns, and large payload risks.

---

## STEP 1 — Egress Inventory Table

One row per Supabase-related call site (active code + notable test/demo scripts). Archived code and logs are referenced but not treated as active.

| Repo | File path + function/script | Method | Target | Endpoint / query pattern | Read/Write | Auth context | Caching status | Payload size risk | Frequency risk |
|---|---|---|---|---|---|---|---|---|---|
| UK-AQ Webpage | `CIC-test-uk-aq/index.html` (`loadData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_bristol_latest?region&station_like&limit` | Read | Anon key | None detected | Med (up to 1000 rows with nested fields) | Med (5-min polling + manual refresh) |
| UK-AQ Webpage | `CIC-test-uk-aq/index.html` (`loadSeriesData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_timeseries?timeseries_id&window` | Read | Anon key | None detected | High (up to 20k points per call) | Med (5-min polling + on station change) |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_bristol.html` (`loadData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_bristol_latest?limit` | Read | Anon key | None detected | Med | Med |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_bristol.html` (`loadSeriesData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_timeseries?timeseries_id&window` | Read | Anon key | None detected | High | Med |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_surbiton.html` (`loadData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_surbiton_latest?limit` | Read | Anon key | None detected | Med | Med |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_surbiton.html` (`loadSeriesData`) | `fetch` | Edge Functions | `functions/v1/uk_aq_timeseries?timeseries_id&window` | Read | Anon key | None detected | High | Med |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_hex_map.html` (`loadMapData`, UK panel) | `fetch` | Edge Functions | `functions/v1/uk_aq_pcon_hex?limit` | Read | Anon key | None detected | Med (pcon rows) | High (60s polling) |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_hex_map.html` (`loadMapData`, UK panel) | `fetch` | Edge Functions | `functions/v1/uk_aq_latest?pollutant&scope=all&limit=10000` | Read | Anon key | None detected | High (up to 10k rows + nested fields) | High (60s polling) |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_hex_map.html` (C&R panel) | `fetch` | Edge Functions | `functions/v1/uk_aq_la_hex?limit` | Read | Anon key | None detected | Med | High (60s polling) |
| UK-AQ Webpage | `CIC-test-uk-aq/uk_aq_hex_map.html` (population overlay) | `fetch` | Edge Functions | `functions/v1/uk_aq_population?geo_type=PCON&reference_date&limit` | Read | Anon key | None detected | Med/High (up to 20k rows) | Low (currently commented in main page) |
| UK-AQ Webpage | `CIC-test-uk-aq/hex_map_test*.html` | `fetch` | Edge Functions | `functions/v1/uk_aq_pcon_hex`, `uk_aq_latest`, `uk_aq_population` | Read | Anon key | None detected | High (same as above) | Low/Med (10-min polling; test files) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_latest/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/timeseries?select=...&last_value_at=not.is.null&last_value=gte.0&limit` | Read | Service role | None detected | High (wide select, nested joins, up to 10k) | High (called by UI) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_bristol_latest/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/timeseries?...limit` | Read | Service role | None detected | Med/High | Med (UI polling) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_surbiton_latest/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/timeseries?...limit` | Read | Service role | None detected | Med/High | Med (UI polling) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_timeseries/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/observations?timeseries_id&observed_at&limit`, `uk_aq_guidelines`, `timeseries` | Read | Service role | None detected | High (timeseries points) | Med (UI polling) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_pcon_hex/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/pcon_latest_pm25?limit` | Read | Service role | None detected | Med | High (UI polling) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_la_hex/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/la_latest_pm25?limit` | Read | Service role | None detected | Med | High (UI polling) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_stations/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/stations?geometry=not.is.null&limit/page_size` | Read | Service role | None detected | High (geometry + memberships) | Low/Med (not used by main UI in this repo) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_dispatch_polls/index.ts` | `fetch` (PostgREST + functions) | PostgREST + Edge Functions | `/rest/v1/connectors`, `/rest/v1/uk_aq_ingest_runs`, `rpc/*`, `/functions/v1/*` | Read/Write | Service role | None detected | Med | Low/Med (scheduled/operational) |
| AQ Ingest | `CIC-test-uk-aq-ingest/supabase/functions/ingest_*` | `fetch` (PostgREST) | PostgREST | `/rest/v1/*` writes + reads | Read/Write | Service role | None detected | Med/High (batch writes) | Low/Med (scheduled) |
| AQ Ingest | `CIC-test-uk-aq-ingest/scripts/uk_aq_invoke_edge.py` | `requests` | Edge Functions | `/functions/v1/<name>` | Read/Write | Service role (likely) | None | Med | Low (manual) |
| AQ Ingest | `CIC-test-uk-aq-ingest/scripts/uk_aq_check_error_logs.py` | `requests` | PostgREST | `/rest/v1/error_logs` | Read | Service role | None | Low/Med | Low |
| AQ Ingest | `CIC-test-uk-aq-ingest/scripts/uk_aq_refresh_station_geo_aiven.py` | `requests` | PostgREST | `/rest/v1/stations` (GET/PATCH) | Read/Write | Service role | None | Med (station rows) | Low |
| AQ Ingest | `CIC-test-uk-aq-ingest/scripts/uk_aq_dashboard_local.py` | `requests` | PostgREST | `/rest/v1/*` (dashboard reads/patches) | Read/Write | Service role | None | Med | Low |
| Population Ingest | `CIC-Test-uk-population-ingest/supabase/functions/uk_aq_population/index.ts` | `fetch` (PostgREST) | PostgREST | `/rest/v1/uk_population_observations?select=...&geo_type&reference_date&limit` | Read | Service role | None detected | Med/High (up to 20k rows) | Med (UI calls if enabled) |
| Population Ingest | `CIC-Test-uk-population-ingest/supabase/functions/uk_population_external_ingest/index.ts` | `createClient` | PostgREST | `select('*')` from `<prefix>_geography_catalogue`, upsert to `*_population_observations` | Read/Write | Service role | None | Med | Low (monthly scheduled) |
| Population Ingest | `CIC-Test-uk-population-ingest/supabase/functions/uk_population_catalogue_load/index.ts` | `createClient` | PostgREST | delete/insert `*_geography_catalogue` | Write | Service role | None | Med | Low (monthly scheduled) |
| Population Ingest | `CIC-Test-uk-population-ingest/supabase/functions/nomis_monthly_check/index.ts` | `createClient` | PostgREST | select/upsert `nomis_dataset_registry` | Read/Write | Service role | None | Low | Low (monthly scheduled) |
| Population Ingest | `CIC-Test-uk-population-ingest/src/nomis_api/supabase.py` (used by `scripts/*.py`) | `requests` | PostgREST | `/rest/v1/<table>` upsert/insert/patch/delete | Write | Service role | None | Med | Low (manual/batch) |

---

## STEP 2 — Likely Top Egress Hotspots

1) **`uk_aq_hex_map.html` polling + `uk_aq_latest`**
   - Paths: `CIC-test-uk-aq/uk_aq_hex_map.html`, `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_latest/index.ts`
   - Why: 60-second polling, `limit=10000`, wide nested `select` on `timeseries` plus `station/connector/phenomenon` data.
   - Data shape: up to 10k rows, wide fields (nested objects).
   - Frequency: high (every 60s + manual refresh).

2) **`uk_aq_timeseries` response size**
   - Paths: `CIC-test-uk-aq/index.html`, `uk_aq_bristol.html`, `uk_aq_surbiton.html`, `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_timeseries/index.ts`
   - Why: up to 20k points per call (max 60k), called on load and refresh; payloads are raw time series.
   - Data shape: up to 20k rows with timestamps + values, plus guideline object.
   - Frequency: medium (5-min polling; re-fetch on station change).

3) **`uk_aq_pcon_hex` and `uk_aq_la_hex` polling**
   - Paths: `CIC-test-uk-aq/uk_aq_hex_map.html`, `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_pcon_hex/index.ts`, `uk_aq_la_hex/index.ts`
   - Why: 60-second polling, results include full constituency/LA lists with summary metrics.
   - Data shape: large-ish aggregated lists.
   - Frequency: high.

4) **`uk_aq_population` potential population overlay fetches**
   - Paths: `CIC-test-uk-aq/uk_aq_hex_map.html` (commented), `hex_map_test*.html`, `CIC-Test-uk-population-ingest/supabase/functions/uk_aq_population/index.ts`
   - Why: can return up to 20k rows by geo type; would be large if enabled on main map.
   - Data shape: 20k rows max; each row includes multiple fields.
   - Frequency: low currently; would become high if enabled in main map.

5) **`uk_aq_latest` and `uk_aq_*_latest` nested selects**
   - Paths: `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_latest/index.ts`, `uk_aq_bristol_latest/index.ts`, `uk_aq_surbiton_latest/index.ts`
   - Why: wide selects with nested joins and possible duplicates (two queries per stationLike), large response shapes.
   - Frequency: medium/high via UI polling.

6) **`uk_aq_stations` geometry payloads (if used)**
   - Paths: `CIC-test-uk-aq-ingest/supabase/functions/uk_aq_stations/index.ts`
   - Why: includes full geometry + network memberships; can return many rows up to 20k.
   - Frequency: unknown (not called by current UI).

---

## STEP 3 — Egress Reduction Options (by area)

### A) Webpage client data fetching (static HTML site)
**What we found**
- 5-min polling on `index.html`, `uk_aq_bristol.html`, `uk_aq_surbiton.html`.
- 60-second polling on `uk_aq_hex_map.html` (two panels).
- Test hex map pages poll every 10 minutes.

**Options**
1) **Increase polling intervals and add “only when visible” gating**
   - Pros: immediate egress savings; minimal code.
   - Cons: data feels less “live”.
   - Risk: low; Impact: high.
2) **Switch to “stale-while-revalidate” model in client**
   - Pros: preserves UI responsiveness; reduces frequent hits.
   - Cons: more logic; still needs cache storage.
   - Risk: low/med; Impact: med/high.
3) **Defer heavy endpoints until user interaction**
   - Pros: avoid fetching charts/tables until needed.
   - Cons: extra UI latency for first view.
   - Risk: low; Impact: med.
4) **One fetch per page load + manual refresh**
   - Pros: biggest egress drop for UI.
   - Cons: data can become stale; may not match “live” expectations.
   - Risk: low/med; Impact: high.

**Recommendation**
- Start with (1) and (2) for quick egress wins without changing UI behavior drastically.

---

### B) Edge Functions (supabase/functions) and responses
**What we found**
- `uk_aq_latest`, `uk_aq_*_latest`, `uk_aq_timeseries`, `uk_aq_pcon_hex`, `uk_aq_la_hex`, `uk_aq_population` produce large JSON payloads.
- Responses do not indicate cache headers.

**Options**
1) **Add cache headers to safe (public/anon) responses**
   - Pros: enables CDN/browser caching; large egress reduction.
   - Cons: requires careful TTL selection.
   - Risk: low; Impact: high.
2) **Add response shape trimming / field projection**
   - Pros: less JSON; reduced bandwidth.
   - Cons: requires UI updates if fields change.
   - Risk: med; Impact: high.
3) **Introduce “delta” responses (since timestamp)**
   - Pros: smaller responses; reduces repeated payloads.
   - Cons: requires client state and API changes.
   - Risk: med; Impact: high.
4) **Compress responses (gzip/brotli) via platform/CDN**
   - Pros: bandwidth reduction with minimal code.
   - Cons: may rely on hosting/CDN config.
   - Risk: low; Impact: med.

**Recommendation**
- Do (1) + (4) first; evaluate (2) for `uk_aq_latest` and `uk_aq_timeseries` once client dependencies are mapped.

---

### C) PostgREST queries (rest/v1) and data shape
**What we found**
- `uk_aq_latest` uses a wide `select` with nested joins and duplicates.
- `uk_aq_timeseries` uses large `limit` and raw observations.
- `uk_aq_population` has a high `limit` cap.

**Options**
1) **Narrow select lists (remove unused fields)**
   - Pros: reduces payloads immediately.
   - Cons: requires UI audit.
   - Risk: med; Impact: high.
2) **Add server-side “summary-only” endpoints**
   - Pros: UI can fetch smaller summary payloads.
   - Cons: new logic and data contract.
   - Risk: med; Impact: high.
3) **Pagination with explicit ranges**
   - Pros: controls max response size.
   - Cons: UI complexity for “load more”.
   - Risk: low/med; Impact: med.

**Recommendation**
- Start with (1) for the high-traffic endpoints (`uk_aq_latest`, `uk_aq_timeseries`).

---

### D) RPC / SQL functions, views, materialized views (schema repo)
**What we found**
- Views exist for `pcon_latest_pm25` and `la_latest_pm25`.
- No materialized views for heavy/expensive aggregates.

**Options**
1) **Materialize “latest per station/pollutant” views**
   - Pros: cheaper reads; stable output size.
   - Cons: requires refresh strategy.
   - Risk: med; Impact: high.
2) **RPC for aggregation with fixed outputs**
   - Pros: precise control over data shape; easy cache.
   - Cons: new SQL and API surface.
   - Risk: med; Impact: med/high.
3) **Add “since” or “updated_at” indexes for incremental fetching**
   - Pros: enables delta fetches.
   - Cons: depends on data model changes.
   - Risk: med; Impact: med.

**Recommendation**
- Plan for (1) in Phase 2; use (2) for endpoints where payloads are large and repetitive.

---

### E) Time-series strategy (raw vs aggregated, incremental)
**What we found**
- `uk_aq_timeseries` returns raw observations up to 20k+ rows.

**Options**
1) **Server-side downsampling (bucketed aggregates)**
   - Pros: huge response reduction; faster UI.
   - Cons: requires schema/RPC changes.
   - Risk: med; Impact: high.
2) **Incremental fetch: `since=last_observed_at`**
   - Pros: minimal transfer after initial load.
   - Cons: client state required; needs API change.
   - Risk: med; Impact: high.
3) **Client-side decimation with reduced server window**
   - Pros: easy to implement; smaller responses.
   - Cons: lower fidelity in UI.
   - Risk: low/med; Impact: med.

**Recommendation**
- Phase 1: reduce default window and cap to needed points.
- Phase 2: add server-side downsampling or `since` support.

---

### F) Client caching and deduping
**What we found**
- No explicit caching in JS; repeated fetches per interval.

**Options**
1) **In-memory caching with TTL per endpoint**
   - Pros: easy, reduces same-page refetches.
   - Cons: page refresh resets cache.
   - Risk: low; Impact: med.
2) **LocalStorage cache for map and population data**
   - Pros: persists across reloads.
   - Cons: cache invalidation complexity.
   - Risk: low/med; Impact: med.
3) **Use ETag/If-None-Match (if supported by server)**
   - Pros: low bandwidth on cache hits.
   - Cons: requires server support.
   - Risk: med; Impact: high.

**Recommendation**
- Start with (1) + (2), then layer (3) after server headers are in place.

---

### G) CDN caching options (Supabase/Cloudflare)
**What we found**
- Edge Function responses lack cache headers.
- Most endpoints are public/anon; safe for public caching.

**Options**
1) **Edge Function `Cache-Control` headers**
   - Pros: enables CDN + browser caching.
   - Cons: needs per-endpoint TTL decisions.
   - Risk: low; Impact: high.
   - Example: `Cache-Control: public, max-age=60, stale-while-revalidate=300`
2) **Cloudflare in front of site + API**
   - Pros: strong caching + analytics; can offload from Supabase.
   - Cons: config complexity; cache key tuning needed.
   - Risk: med; Impact: high.
3) **Worker proxy to normalize cache keys and set headers**
   - Pros: precise caching control and shielding of Supabase.
   - Cons: extra infrastructure.
   - Risk: med; Impact: high.

**Where caching will NOT help**
- Endpoints depending on user identity or mutable data that must be real-time.

**Recommendation**
- Start with (1) for all public Edge Functions; consider (2) if traffic is high.

---

### H) Storage egress and asset delivery
**What we found**
- No Supabase Storage usage in the UI.

**Options**
1) **Ensure assets are served from static host/CDN**
2) **Avoid serving large GeoJSON from Supabase** (already in repo `data/`)

**Recommendation**
- No changes required unless assets move to Supabase Storage later.

---

### I) Operational controls: rate limiting, refresh intervals, backoff
**What we found**
- Frequent polling without backoff.

**Options**
1) **Add exponential backoff on errors**
2) **Slow polling when tab is hidden**
3) **Rate-limit Edge Functions by IP / key**

**Recommendation**
- Implement (1) + (2) first; evaluate (3) if abuse or spikes occur.

---

### J) Observability: measuring egress by endpoint
**What we found**
- No explicit egress metrics in code.

**Options**
1) **Edge Function logging of response sizes + timing**
2) **Supabase logs + PostgREST metrics**
3) **Cloudflare analytics if proxying**
4) **Add `X-Cache` headers for cache hit/miss visibility**

**Recommendation**
- Start with (1) and (4) to get baseline data per endpoint.

---

## STEP 4 — Best Path (Phased Plan)

### Phase 1 (quick wins, minimal risk)
1) ✅ Add Cache-Control headers on public Edge Functions (60s + SWR).
2) [ONLY IF NECESSARY] Increase UI polling intervals (hex map from 60s to 2–5 min; dashboards from 5 min to 10–15 min).
3) ✅ Add visibility gating for dashboard polling: pause auto-refresh while hidden, then resume and run one immediate refresh when visible again.
4) ✅ Reduce `uk_aq_latest` response fields to those actually used in UI.
5) 🎯 Move hex-map time-window filtering server-side (`uk_aq_latest`) instead of client-side `last_value_at` filtering.
6) ✅ Add visibility gating for map polling (UK and C&R tabs): poll only when the tab panel and document are visible; pause when hidden and refresh once on re-visibility.

### Phase 2 (medium effort)
1) ⏳ Add ETag/If-None-Match support for Edge Function responses.
2) ⏳ Add server-side downsampling / aggregation for timeseries.
3) ⏳ Introduce “since” incremental fetch for `uk_aq_latest` and `uk_aq_timeseries`.

### Phase 3 (structural)
1) ⏳ Materialized views for “latest per station/pollutant” and key aggregates.
2) ⏳ Cloudflare caching/proxy in front of public endpoints.

### Top 5 actions (order)
1) ✅ Cache-Control headers on public Edge Functions.
2) ✅ Add visibility gating for dashboard polling.
3) ✅ Add visibility gating for map polling (UK and C&R tabs).
4) ✅ Trim `uk_aq_latest` response fields.
5) 🎯 Move hex-map time-window filtering server-side (`uk_aq_latest`) instead of client-side filtering.

Decision note:
- Do not cap `uk_aq_timeseries` defaults for now. Keeping full-window chart data is preferred to preserve data fidelity/granularity.

**Why these yield biggest reduction**
- They reduce both the frequency and payload size of the highest-traffic endpoints without changing core data flow.

**What to measure**
- Response sizes per endpoint.
- Requests per endpoint per hour.
- Cache hit rate.
- Median page load time and error rates.

---

End of plan.
