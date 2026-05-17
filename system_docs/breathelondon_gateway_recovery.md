# Breathe London — Gateway Recovery Playbook

Operational playbook for recovering Breathe London ingest after an upstream outage.

See also: [breathelondon.md](breathelondon.md).

> **Status: not yet written.**
>
> This is a placeholder. Fill in from real incident experience when one occurs. Breathe London uses a key-protected Communities API, so failure modes include both upstream outages and credential issues.

## What likely differs from SOS

| Aspect | SOS | Breathe London |
|---|---|---|
| Upstream "gateway" | DEFRA SOS REST API (open) | `api.breathelondon-communities.org` (API-key gated) |
| Outage type 1 | SOS gateway 5xx | API 5xx / timeout |
| Outage type 2 | (rare) catalog returns partial | `ListSensors` response missing previously-listed sites |
| Outage type 3 | n/a | **API key invalid / revoked / rotated** — symptom looks like a 4xx storm not a 5xx |
| Catalog reconciler with auto-end-date | Yes (`UK_AIR_TIMESERIES_END_MISSING_RUNS = 2`) | **Verify** — believed not to use the same lifecycle |
| Identity model | DEFRA station IDs | `SiteCode` (community-supplied, can churn) |
| Backfill path | None | **Verify** — depends on whether the BL API exposes historical sensor data |

## Until this is written, when a Breathe London outage happens

1. **Distinguish gateway-down from auth failure first.** Try the keyed endpoint with curl:

   ```bash
   curl -fsS "https://api.breathelondon-communities.org/api/ListSensors?key=$BREATHELONDON_API_KEY" | head -c 200
   ```

   A 401/403 means the key (in Supabase secrets or your local `.env`) needs attention — NOT a recovery scenario.
2. If genuinely a 5xx outage:
   - Note which env was paused vs polling
   - Check the `error_logs` for the BreatheLondon connector for the symptom pattern
3. Compare against the SOS playbook ([`uk_air_sos_gateway_recovery.md`](uk_air_sos_gateway_recovery.md)) for structurally-equivalent steps (freshness verification, post-recovery noise cleanup) — but **do not** copy SOS-specific SQLs verbatim until the BL lifecycle behaviour is verified
4. Document the actual recovery here

## Known constraints to be aware of

- API key is per-request; key rotation in Supabase secrets requires worker redeploy or restart, depending on how the key is read
- BreatheLondon community sites can be added/removed by site operators; some churn is expected in steady state
