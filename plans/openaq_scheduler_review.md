# OpenAQ Scheduler Review

Date: 2026-02-16 (UTC)
Scope: OpenAQ Cloud Run self-scheduling in ingest/ops repo.

## Current behaviour (with code refs)

### Key code paths
- Station eligibility / candidate selection for a run:
  - `workers/uk_aq_openaq_cloud_run/run_job.ts:315` (`loadStationRefs` calling `uk_aq_rpc_openaq_select_station_refs`)
  - SQL tiering/due rules in `supabase/uk_aq_polling_helpers.sql:548` to `supabase/uk_aq_polling_helpers.sql:606`
- `next_due_at` computation for checkpoints (inside ingest logic):
  - Station checkpoints: `supabase/functions/ingest_openaq/index.ts:3371` to `supabase/functions/ingest_openaq/index.ts:3509`
  - Timeseries checkpoints: `supabase/functions/ingest_openaq/index.ts:3610` to `supabase/functions/ingest_openaq/index.ts:3659`
- Next execution enqueue (Cloud Tasks):
  - Earliest due lookup: `workers/uk_aq_openaq_cloud_run/run_job.ts:355` to `workers/uk_aq_openaq_cloud_run/run_job.ts:401`
  - Next time compute: `workers/uk_aq_openaq_cloud_run/run_job.ts:851` to `workers/uk_aq_openaq_cloud_run/run_job.ts:876`
  - Cloud Tasks create: `workers/uk_aq_openaq_cloud_run/run_job.ts:882` to `workers/uk_aq_openaq_cloud_run/run_job.ts:952`
  - Scheduling call sites: `workers/uk_aq_openaq_cloud_run/run_job.ts:1080` and `workers/uk_aq_openaq_cloud_run/run_job.ts:1198`

### Decision tree (current)

```text
Start run
  -> eligibility check (poll_enabled, scheduler_backend, in_flight)
     -> not eligible: log skipped, return (no self-schedule; safety cron only)
  -> dispatch claim
     -> claim not acquired: log skipped, return (no self-schedule)
  -> load due station refs
     -> zero refs: record skipped(no_station_refs), schedule next task, return
  -> run ingest_openaq once
     -> derive run status: succeeded | skipped | partial | failed
     -> always schedule next task in finally (except early returns above)
        schedule_at = max(
          now + OPENAQ_NEXT_CHECK_MIN_SECONDS,
          rate_limit_reset_at (if rate-limit stop),
          earliest_next_due_at (from checkpoints)
        )
        if failure => now + OPENAQ_FAILURE_RETRY_SECONDS
```

## 1) Is Option C already implemented?

Yes.

Option C (time-to-next-due scheduling) is implemented in the Cloud Run wrapper:
- `loadEarliestNextDueAt` reads the earliest checkpoint due time (`order=next_due_at.asc`, `limit=1`): `workers/uk_aq_openaq_cloud_run/run_job.ts:355`.
- `computeNextCheckTime` uses earliest due and enforces a minimum delay floor (`OPENAQ_NEXT_CHECK_MIN_SECONDS`): `workers/uk_aq_openaq_cloud_run/run_job.ts:851`.

So scheduling is **not** purely fixed-interval; it is due-time-aware with a floor.

## 2) Outcome handling today: skipped / partial / full

### Outcomes exist today
- `skipped` is emitted by ingest when station thresholds are insufficient:
  - `supabase/functions/ingest_openaq/index.ts:2725`
- Wrapper recognizes explicit `run_status=skipped`:
  - `workers/uk_aq_openaq_cloud_run/run_job.ts:458`
- `partial` is inferred when any of these are present:
  - `partial=true`, stopped reason, rate-limit stop, request-budget limitation:
  - `workers/uk_aq_openaq_cloud_run/run_job.ts:467` to `workers/uk_aq_openaq_cloud_run/run_job.ts:503`

### How outcomes influence scheduling today
- Full success, skipped, partial all currently share the same minimum-delay floor (`OPENAQ_NEXT_CHECK_MIN_SECONDS`) unless rate-limit reset pushes later.
- Failure uses `OPENAQ_FAILURE_RETRY_SECONDS` directly (`workers/uk_aq_openaq_cloud_run/run_job.ts:857`).
- Rate-limit reset is only applied when `rate_limit_stop`/`remaining_low`/`rate_limit_429` is detected (`workers/uk_aq_openaq_cloud_run/run_job.ts:982`).
- Request-budget partials (for example `request_budget_limited`) can still reschedule at the normal short floor when no explicit reset is present.

## 3) Analysis of `next_due_at` logic and min(lag)

### Current formula (checkpoint side)

In `supabase/functions/ingest_openaq/index.ts`:
- Lag samples are appended as `now - latest_observed`.
- Non-gap station due time (after warmup):
  - `next_due_at = latest_observed + min(observ_interval_samples, 1h) + min(ingest_lag_samples)`
  - refs: `supabase/functions/ingest_openaq/index.ts:3485` to `supabase/functions/ingest_openaq/index.ts:3493`
- Timeseries due time (after warmup):
  - `next_due_at = latest_observed + 1h + min(ingest_lag_samples)`
  - ref: `supabase/functions/ingest_openaq/index.ts:3639` to `supabase/functions/ingest_openaq/index.ts:3645`
- Gap stations use min-style interval rules too (`minStationIntervalSeconds`), with special recent-gap handling:
  - refs: `supabase/functions/ingest_openaq/index.ts:3426` and `supabase/functions/ingest_openaq/index.ts:3436`

Then scheduler picks the **earliest** station due globally (`order asc limit 1`), so an outlier station can govern global cadence.

### Why min is used currently
Min is freshness-biased: it reacts quickly to the fastest observed cadence and shortest lag, reducing late data risk.

### Observed downside
- Min can be dominated by one short-lag outlier sample, creating very short next-due times.
- Because wrapper also picks global earliest due, this can create run churn.
- On 2026-02-16 logs, most OpenAQ scheduled tasks are effectively at ~60s (p50 ~59.9s), indicating the current minimum-delay floor dominates and cadence remains very high.

## 4) Does Option A still add value if Option C exists?

Yes.

Even with Option C, outcome-specific floors still help because:
- Earliest due can remain very near-now (or overdue), so the run loop keeps hitting the minimum floor.
- Zero-candidate / threshold-skipped cases currently keep rescheduling quickly.
- Partial request-budget runs can also loop quickly if no rate-limit reset is present.

Outcome-specific floors reduce churn while preserving due-aware behavior.

## 5) Options

## A) Add outcome-based delay knobs (recommended first)

Proposed vars:
- `OPENAQ_NEXT_CHECK_MIN_SECONDS` (full success floor)
- `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS` (partial floor)
- `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS` (skipped floor)

Pros:
- Minimal change in wrapper only.
- High probability of reducing execution count quickly.
- Fully reversible by env vars.

Cons:
- Needs tuning to avoid freshness regression.

Risks:
- If skipped/full floors are too high, some data arrives later.

## B) Change lag statistic for checkpoint scheduling (min vs median vs percentile)

Proposed var:
- `OPENAQ_LAG_STAT = min|median|p25`

Interpretation:
- `min`: current behavior, freshness-first.
- `median`: robust to outliers, lower churn, highest stale-risk of the three.
- `p25`: compromise between freshness and robustness.

Pros:
- Addresses root cause of min-driven thrash in checkpoint due computation.

Cons:
- Affects due timestamps directly; needs A/B validation.

Risks:
- Over-smoothing can delay fast-updating stations.

## C) Hybrid (recommended target state)

- Keep earliest-due scheduling (Option C) but add:
  - outcome-based floors (A)
  - robust lag statistic flag (B)
  - optional jitter and due floor guardrails.

Proposed guardrail vars:
- `OPENAQ_SCHEDULER_JITTER_SECONDS`
- `OPENAQ_MIN_DUE_DELAY_SECONDS`

Pros:
- Keeps freshness model while reducing deterministic 60s loops.

Cons:
- Slightly more config complexity.

Risks:
- Requires good observability for tuning.

## Current vs proposed outcomes (expected impact)

| Outcome path | Current scheduling | Proposed scheduling | Expected execution impact | CPU-seconds proxy impact | Freshness impact |
|---|---|---|---|---|---|
| Full success | floor = `OPENAQ_NEXT_CHECK_MIN_SECONDS` (currently 60s) | floor = `OPENAQ_NEXT_CHECK_MIN_SECONDS` (recommended ops value 120s) | Medium reduction | Medium reduction | Low to medium |
| Partial (rate-limit / budget) | same 60s floor unless explicit reset pushes later | use `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS` (recommended 60s) + reset floor | Small reduction, safer recovery | Small reduction | Low |
| Skipped / no_station_refs | same 60s floor | `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS` (recommended 240s) | High reduction on no-op loops | High reduction on waste | Low if due-aware fallback retained |
| Checkpoint lag statistic | `min(lag)` | flaggable `median`/`p25` with fallback `min` | Medium reduction if enabled | Medium reduction | Medium (must validate) |

## Recommended staged rollout

1. Stage 1 (no behavior change): add schedule-decision logs and reason codes.
2. Stage 2: add Option A env vars + outcome-based floors behind envs.
3. Stage 3: add `OPENAQ_LAG_STAT` flag; run `min` vs `p25` (or `median`) comparison for 48h.
4. Stage 4: optional jitter + min-due floor guardrails if still thrashing.

## Suggested env vars and defaults

To satisfy minimal-risk rollout and explicit knobs:
- `OPENAQ_NEXT_CHECK_MIN_SECONDS`
  - recommended operational default: `120`
- `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS`
  - recommended operational default: `60`
- `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS`
  - recommended operational default: `240`
- `OPENAQ_LAG_STAT`
  - default: `min` (preserves current logic)
- `OPENAQ_SCHEDULER_JITTER_SECONDS`
  - optional recommended default: `15` (within 10-30)
- `OPENAQ_MIN_DUE_DELAY_SECONDS`
  - optional recommended default: `30` (within 30-60)

Note: For strict backward compatibility in code, new vars should be introduced with fallback behavior equal to current logic when unset.

## Patch plan (no implementation yet)

### Files/functions to change

1. `workers/uk_aq_openaq_cloud_run/run_job.ts`
- Add env parsing for:
  - `OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS`
  - `OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS`
  - `OPENAQ_SCHEDULER_JITTER_SECONDS`
  - `OPENAQ_MIN_DUE_DELAY_SECONDS`
- Extend `computeNextCheckTime(...)` to accept outcome/reason and choose floor by outcome.
- Apply jitter and due-floor guardrail before enqueue.
- Add structured schedule decision log before enqueue.

Pseudo-diff sketch:
```diff
+ const OPENAQ_NEXT_CHECK_PARTIAL_MIN_SECONDS = parsePositiveInt(...)
+ const OPENAQ_NEXT_CHECK_SKIPPED_MIN_SECONDS = parsePositiveInt(...)
+ const OPENAQ_SCHEDULER_JITTER_SECONDS = parseNonNegativeInt(...)
+ const OPENAQ_MIN_DUE_DELAY_SECONDS = parseNonNegativeInt(...)

- function computeNextCheckTime(now, earliestNextDueAt, rateLimitResetAt, failure)
+ function computeNextCheckTime(now, earliestNextDueAt, rateLimitResetAt, outcome, failure)
+   // floor by outcome: succeeded/partial/skipped
+   // clamp with min due delay
+   // optional jitter

+ logSummary("task_schedule_decision", {
+   reason, outcome, earliest_next_due_at, rate_limit_reset_at,
+   min_delay_seconds, min_due_delay_seconds, jitter_seconds, schedule_at
+ })
```

2. `supabase/functions/ingest_openaq/index.ts`
- Add lag statistic selector:
  - `OPENAQ_LAG_STAT` parse with allowed values `min|median|p25`.
- Add helper to select lag sample statistic.
- Replace `minSeconds(lagSamples)` at:
  - `supabase/functions/ingest_openaq/index.ts:3489`
  - `supabase/functions/ingest_openaq/index.ts:3639`
- Keep default as `min`.

Pseudo-diff sketch:
```diff
+ const OPENAQ_LAG_STAT = (Deno.env.get("OPENAQ_LAG_STAT") ?? "min").toLowerCase()
+ function lagStatSeconds(values, stat) { ... } // min/median/p25

- const lagSeconds = minSeconds(lagSamples) ?? 5 * 60;
+ const lagSeconds = lagStatSeconds(lagSamples, OPENAQ_LAG_STAT) ?? 5 * 60;
```

3. `.github/workflows/uk_aq_openaq_cloud_run_deploy.yml`
- Add workflow env wiring for new vars.
- Add `add_env` entries so Cloud Run job receives them.

4. `config/uk_aq_github_env_targets.csv`
- Add target mapping rows for new vars as `variable`.

5. `workers/uk_aq_openaq_cloud_run/README.md`
- Document new scheduler/lag vars and defaults.

## Logging/metrics validation plan

Log per run (structured):
- `message=task_schedule_decision`
- `run_status`, `run_message`, `reason`
- `earliest_next_due_at`, `rate_limit_reset_at`, `schedule_at`
- `delay_seconds_effective`
- `min_delay_seconds_applied`
- `lag_stat` (min/median/p25)
- `due_station_count` (if available from selection payload)
- `zero_candidate` boolean

Track over 48h before/after each stage:
- executions/day
- p50/p95 runtime
- failure rate
- `task_scheduled` count by reason
- scheduled delay distribution (p50/p95)
- skipped/no_station_refs frequency
- partial rate-limit frequency and recovery time

Recommendation summary:
- Option C is already implemented.
- Add Option A now (outcome floors) because Option C alone is not preventing short-loop churn.
- Add Option B as a flagged experiment (`OPENAQ_LAG_STAT`), start with `min` default and test `p25` first, then `median` if needed.
