# History DB Pub/Sub Model Plan (GCP)

Date: 2026-02-15  
Scope: Planning only (no infra rollout in this document).  
Goal: Reduce history-path egress and request churn while allowing lower history freshness (up to 1 hour lag).

## Decision Update (2026-02-15)

- History flush target remains `60 minutes`.
- Cutover preference updated to **direct cutover**, starting with **OpenAQ** first as the first production-like test path.
- No hybrid outbox+Pub/Sub period is planned for OpenAQ unless rollback is needed.

## Baseline Snapshot (from current metrics)

Source: `uk_aq_public.uk_aq_history_rpc_metrics_minute` (history DB)

- Last 1 hour:
  - Calls: `31`
  - Payload: `1.892 MB`
  - Rows input: `13,492`
  - Rows upserted: `10,148`
  - Upsert ratio: `75.2%`
- Last 24 hours:
  - Calls: `819`
  - Payload: `37.171 MB`
  - Rows input: `264,668`
  - Rows upserted: `162,485`
  - Upsert ratio: `61.4%`
- Dominant endpoint: `rpc/uk_aq_rpc_observs_observations_upsert` (effectively 100% of measured history payload).

Interpretation:
- Current cost is driven mostly by high request count + repeated rows, not many distinct endpoints.
- Batching frequency changes will cut request overhead a lot; payload bytes drop less unless we increase dedupe before upsert.

## Is 1-hour history interval acceptable?

Yes, if product expectations allow history to be up to 60 minutes behind live data.

- Operationally: this is usually fine for history analytics/backfill audiences.
- Not fine if history tables are used for near-real-time UX or alerting.
- Recommendation: adopt 1-hour target with guardrails (manual flush + failure fallback + DLQ).

## Options

### Option 1: Keep current model, change outbox flush cadence to hourly

Description:
- Keep `uk_aq_raw.history_observation_outbox` and current RPC flow.
- Run the history outbox Cloud Run flusher every 60 minutes instead of every 10 minutes.

Pros:
- Very low engineering risk.
- Large drop in request count to history DB (fewer runs).
- No new GCP components.
- Egress impact: medium reduction in request/protocol overhead.
- Database-size impact: neutral to negative (main outbox rows live longer between drains, temporary queue growth).

Cons:
- Payload MB/day likely similar unless dedupe window improves.
- Larger batch spikes each hour.
- Outbox growth and replay pressure can increase during failures.

### Option 2: GCP Pub/Sub buffer + hourly batch writer to history DB (recommended)

Description:
- Move history transport queueing into GCP Pub/Sub.
- Run an hourly Cloud Run job that drains subscription messages, dedupes by `(connector_id, timeseries_id, observed_at)`, and bulk-upserts history.
- Keep DLQ and retry policy in Pub/Sub.

Pros:
- Reduces request churn substantially (hourly controlled writes).
- Better queue durability/ops controls (DLQ, retry, retention) than DB outbox-only.
- Enables larger dedupe window before write, reducing redundant rows.
- Egress impact: medium-high reduction in call overhead; payload reduction is moderate with dedupe.
- Database-size impact: medium-high reduction in main DB queue footprint if DB outbox use is reduced/removed.

Cons:
- More infra complexity (topic/subscription/DLQ/job/service accounts/monitoring).
- Requires publisher path changes from ingest runtimes.
- Still pays history payload bytes for rows that are truly needed.

### Option 3: GCP Pub/Sub near-real-time consumer (streaming writes)

Description:
- Pub/Sub-driven subscriber writes to history continuously (or every few minutes) instead of hourly.

Pros:
- Low history lag.
- Simpler freshness behavior for downstream consumers.
- Egress impact: lower than today if dedupe is improved, but higher than hourly batching due to more frequent writes.
- Database-size impact: lower than DB outbox model if outbox is retired.

Cons:
- More write frequency than hourly model.
- Less egress savings than hourly batching.
- Higher operational sensitivity to bursts.

## Recommendation

Pick **Option 2 (Pub/Sub + hourly batch writer)**.

Why:
- You explicitly said history does not need frequent updates.
- It provides the best egress-to-complexity balance: large call-count reduction, moderate payload savings from batch dedupe, and meaningful main-DB size relief if outbox dependency is reduced.
- It keeps the model fully in GCP, matching your preferred operating boundary.

## Target architecture (recommended)

1. Publisher:
- Ingest runtimes publish history rows/messages to `uk-aq-observs-observations` topic.
- Include idempotency fields in each message:
  - `connector_id`
  - `timeseries_id`
  - `observed_at`
  - `value`
  - `status`

2. Buffering:
- Pub/Sub topic retention: e.g. 24-72h.
- Dead-letter topic for poison messages.

3. Hourly writer job:
- Cloud Run Job (or Cloud Run service + Cloud Scheduler every hour).
- Pull messages in batches, aggregate and dedupe in-memory by PK tuple.
- Upsert in chunks to history RPC (`uk_aq_rpc_observs_observations_upsert`).
- Ack only after successful upsert.

4. Fallback controls:
- Manual trigger endpoint/job for immediate flush.
- Alert on backlog age and unacked depth.

## Egress and DB-size expectations

Expected with hourly Pub/Sub batch model:
- History DB call count: **major reduction** (order-of-magnitude lower than per-run micro-batches).
- History payload bytes: **small-to-moderate reduction** (depends on dedupe effectiveness; not purely interval-driven).
- Main DB churn/size: **moderate-to-large reduction** if DB outbox table usage is reduced or retired.

## Rollout plan

Phase 0: Baseline and acceptance criteria
- Record 7-day baseline:
  - history calls/day
  - payload MB/day
  - rows_input vs rows_upserted ratio
  - outbox backlog size/age

Phase 1: Pub/Sub infra
- Provision topic, subscription, DLQ, IAM.
- Add monitoring dashboards and alert thresholds.

Phase 2: Writer job
- Implement hourly batch drain job with deterministic dedupe and chunked upsert.
- Add replay-safe behavior and partial-failure handling.

Phase 3: Publisher cutover
- Route one connector first (canary), validate metrics.
- Expand to remaining connectors.

Phase 4: Cleanup
- Reduce/retire main DB outbox path where safe.
- Keep compatibility fallback for rollback window.

## Open decisions

- Should any connector bypass hourly lag (for example keep 5-10 minute writes for selected sources)?
- Full outbox retirement vs hybrid fallback?
- Maximum acceptable history lag during retries/failures (for example 2h or 4h SLO)?

## Connector Scheduling Shape (hourly model)

Question: once four connectors are on Pub/Sub, should writer runs be split into 15-minute offsets (4 runs/hour), or run once/hour for all connectors together?

### Option A: Single hourly writer run for all connectors

Description:
- One hourly batch run drains messages for all connectors together and upserts in chunks.

Pros:
- Best egress efficiency (maximum batching, lowest call overhead).
- Simplest operations (one schedule, one worker, one run log stream).
- Database-size impact: best reduction in main DB queue dependency once outbox is retired.

Cons:
- Larger single-hour spike in compute and history upsert throughput.
- If a run fails, all connectors in that hour are delayed together.

Impact:
- Egress impact: highest reduction (best of compared options).
- Database-size impact: high positive (same as staggered once outbox is retired, but with simpler cleanup path).

### Option B: Per-connector hourly writers staggered every 15 minutes

Description:
- Four hourly schedules offset by 15 minutes (for example `:00`, `:15`, `:30`, `:45`), each writing one connector.

Pros:
- Smoother load profile across the hour (smaller spikes).
- Blast radius is smaller (one connector can fail without blocking others).

Cons:
- Slightly higher call overhead and protocol overhead vs one combined batch.
- More scheduler/job complexity and more moving parts to monitor.
- Cross-connector batching is lost.

Impact:
- Egress impact: medium-high reduction vs current, but slightly worse than Option A.
- Database-size impact: high positive once outbox is retired (similar end state to Option A).

Recommendation:
- If primary objective is **minimum egress**, choose **Option A**.
- If primary objective is **operational smoothing/risk isolation**, choose **Option B**.
- For current priorities (egress + quick OpenAQ validation), start OpenAQ with direct cutover now, then decide A vs B before onboarding connectors 2-4.

## Suggested initial defaults

- `history_flush_interval`: 60 minutes
- `history_writer_max_batch_messages`: 10,000 (tune by runtime/memory)
- `history_writer_upsert_chunk_size`: 5,000
- `history_backlog_alert_age_minutes`: 120
- `history_backlog_alert_count`: environment-specific
