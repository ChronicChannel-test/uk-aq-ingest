# VACUUM FULL via pg_cron (ingest DB + obs AQI DB)

Use this to run full-database `VACUUM FULL` daily at `05:00 UTC`.

## 1) Enable pg_cron

```sql
create extension if not exists pg_cron with schema extensions;
```

## 2) Create/replace ingestdb scheduled job (05:00 UTC)

```sql
-- Remove legacy ingest vacuum names and old observations-only command at 05:00 UTC.
select cron.unschedule(jobid)
from cron.job
where jobname in (
  'uk_aq_ingest_observations_vacuum_full_0500_utc',
  'uk_aq_ingestdb_observations_vacuum_full_0500_utc',
  'uk_aq_ingestdb_vacuum_full_0500_utc'
)
or (
  schedule = '0 5 * * *'
  and lower(command) like '%vacuum (full, analyze, verbose)%uk_aq_core.observations%'
);

select cron.schedule(
  'uk_aq_ingestdb_vacuum_full_0500_utc',
  '0 5 * * *',
  $$vacuum (full, analyze, verbose);$$
);
```

## 3) Create/replace obs_aqidb scheduled job (05:00 UTC)

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

## 4) Verify jobs exist

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname in (
  'uk_aq_ingestdb_vacuum_full_0500_utc',
  'uk_aq_obs_aqidb_vacuum_full_0500_utc'
)
order by jobname;
```

## 5) Check run results

```sql
select
  j.jobname,
  d.jobid,
  d.status,
  d.start_time,
  d.end_time,
  d.return_message
from cron.job_run_details
join cron.job j on j.jobid = d.jobid
where j.jobname in (
  'uk_aq_ingestdb_vacuum_full_0500_utc',
  'uk_aq_obs_aqidb_vacuum_full_0500_utc'
)
order by d.start_time desc
limit 40;
```

## 6) Stop/remove jobs

```sql
select cron.unschedule('uk_aq_ingestdb_vacuum_full_0500_utc');
select cron.unschedule('uk_aq_obs_aqidb_vacuum_full_0500_utc');
```

## Notes

- `VACUUM FULL` takes an exclusive lock while it runs.
- Full-database vacuum can run for a long time and block writes during rewrite-heavy phases.
