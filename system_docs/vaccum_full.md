# VACUUM FULL via pg_cron (ingest DB)

Use this to run `VACUUM FULL` on `uk_aq_core.observations` daily at `05:00 UTC`.

## 1) Enable pg_cron

```sql
create extension if not exists pg_cron with schema extensions;
```

## 2) Create/replace the scheduled job

```sql
-- Remove existing job with this name (if present)
select cron.unschedule(jobid)
from cron.job
where jobname = 'uk_aq_observations_vacuum_full_0500_utc';

-- Schedule daily at 05:00 UTC
select cron.schedule(
  'uk_aq_observations_vacuum_full_0500_utc',
  '0 5 * * *',
  $$vacuum (full, analyze, verbose) uk_aq_core.observations;$$
);
```

## 3) Verify the job exists

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'uk_aq_observations_vacuum_full_0500_utc';
```

## 4) Check run results

```sql
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'uk_aq_observations_vacuum_full_0500_utc'
)
order by start_time desc
limit 20;
```

## 5) Stop/remove the job

```sql
select cron.unschedule('uk_aq_observations_vacuum_full_0500_utc');
```

## Notes

- `VACUUM FULL` takes an exclusive lock on the target table while it runs.
- This is intended for test/pre-live validation first.
- Schedule is set after prune to reduce overlap risk.
