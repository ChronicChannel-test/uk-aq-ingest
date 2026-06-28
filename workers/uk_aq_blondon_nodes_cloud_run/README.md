# uk_aq Breathe London Nodes Cloud Run service

Runs `scripts/blondon_nodes/blondon_nodes_ingest.py` in Cloud Run.

Required secret:
- `BLONDON_NODES_API_KEY` (no sensible default; add to `.env`/GitHub secrets/Secret Manager).

Defaults that do not require `.env` rows:
- `BLONDON_NODES_BASE_URL=https://breathe-london-7x54d7qf.ew.gateway.dev`
- `BLONDON_NODES_SERVICE_REF=breathelondon`
- `GCP_OBSERVS_PUBSUB_TOPIC=uk-aq-observs-observations`
- `GCP_LATEST_SNAPSHOT_PUBSUB_TOPIC=uk-aq-latest-snapshot-requests`

Observation delivery follows the shared Communities modes:

- `pubsub_only` publishes observation rows (including `RatificationStatus` as
  `status`) and latest-snapshot requests.
- `direct` calls `uk_aq_rpc_observs_observations_upsert` on Obs AQI DB.
- `outbox_only` enqueues rows through the ingest DB observs outbox.

The HTTP wrapper accepts only `start_time`, `end_time`, `site_code`, `species`,
`max_stations`, `max_api_calls`, and `dry_run`; invalid values return HTTP 400
without starting the ingest subprocess.

Manual local dry run:

```bash
python3 scripts/blondon_nodes/blondon_nodes_ingest.py --dry-run --max-stations 1 --max-api-calls 4
```
