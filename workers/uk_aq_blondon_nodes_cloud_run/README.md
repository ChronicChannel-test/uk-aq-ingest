# uk_aq Breathe London Nodes Cloud Run service

Runs `scripts/blondon_nodes/blondon_nodes_ingest.py` in Cloud Run.

Required secret:
- `BLONDON_NODES_API_KEY` (no sensible default; add to `.env`/GitHub secrets/Secret Manager).

Defaults that do not require `.env` rows:
- `BLONDON_NODES_BASE_URL=https://breathe-london-7x54d7qf.ew.gateway.dev`
- `BLONDON_NODES_SERVICE_REF=breathelondon`
- `GCP_OBSERVS_PUBSUB_TOPIC=uk-aq-observs-observations`
- `GCP_LATEST_SNAPSHOT_PUBSUB_TOPIC=uk-aq-latest-snapshot-requests`

Manual local dry run:

```bash
python3 scripts/blondon_nodes/blondon_nodes_ingest.py --dry-run --max-stations 1 --max-api-calls 4
```
