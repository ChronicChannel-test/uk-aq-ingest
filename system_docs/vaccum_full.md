# VACUUM FULL via pg_cron (obs AQI DB)

Use this to run full-database `VACUUM FULL` daily at `05:00 UTC`.

## 1) Enable pg_cron

```sql
create extension if not exists pg_cron with schema extensions;
```

## 2) Create/replace scheduled job (05:00 UTC)

```sql
-- Remove legacy names, then schedule one shared 05:00 full vacuum job.
select cron.unschedule(jobid)
from cron.job
where jobname in (
  'uk_aq_history_observations_vacuum_full_0530_utc',
  'uk_aq_observs_observations_vacuum_full_0530_utc',
  'uk_aq_observs_vacuum_full_0500_utc',
  'uk_aq_aqilevels_vacuum_full_0500_utc',
  'uk_aq_obs_aqidb_vacuum_full_0500_utc'
);

select cron.schedule(
  'uk_aq_obs_aqidb_vacuum_full_0500_utc',
  '0 5 * * *',
  $$vacuum (full, analyze, verbose);$$
);
```

## 3) Verify job exists

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'uk_aq_obs_aqidb_vacuum_full_0500_utc';
```

## 4) Check run results

```sql
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'uk_aq_obs_aqidb_vacuum_full_0500_utc'
)
order by start_time desc
limit 20;
```

## 5) Stop/remove job

```sql
select cron.unschedule('uk_aq_obs_aqidb_vacuum_full_0500_utc');
```

## Notes

- `VACUUM FULL` takes an exclusive lock while it runs.
- Full-database vacuum can run for a long time and block writes during rewrite-heavy phases.
