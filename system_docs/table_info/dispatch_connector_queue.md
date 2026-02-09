# uk_aq_raw.dispatch_connector_queue

Connector dispatch queue used by the two-stage dispatcher flow.

## Purpose
- Stores one queued dispatch job per connector (`connector_code` is unique).
- Decouples due-selection from ingest execution so scheduler calls stay fast.
- Supports lease-based claiming and retry with backoff.

## Columns
- `id` (bigint, PK): queue row id.
- `connector_code` (text, unique): connector to dispatch.
- `payload` (jsonb): optional queued payload metadata.
- `created_at` (timestamptz): first enqueue timestamp.
- `updated_at` (timestamptz): last enqueue/claim/resolve update.
- `next_attempt_at` (timestamptz): when job is eligible to claim.
- `attempts` (int): failed-attempt counter.
- `last_error` (text): last recorded failure.
- `lease_expires_at` (timestamptz): claim lease expiry (`null` means unclaimed).

## Access Pattern
- Enqueue: `uk_aq_core.uk_aq_dispatch_queue_enqueue(p_entries jsonb)`
- Claim: `uk_aq_core.uk_aq_dispatch_queue_claim(p_batch_limit int, p_lease_seconds int)`
- Resolve: `uk_aq_core.uk_aq_dispatch_queue_resolve(p_resolutions jsonb)`

## Notes
- Queue row is deleted on successful resolve.
- Failed resolve keeps row and schedules retry via `next_attempt_at`.
- Lease expiry allows recovery from interrupted runner calls.
