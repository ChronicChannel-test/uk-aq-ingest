-- OpenAQ eligible and non-eligibe station count
with connector as (
  select id as connector_id
  from uk_aq_core.connectors
  where connector_code = 'openaq'
  limit 1
),
latest_obs as (
  select
    t.station_id,
    max(t.last_value_at) as last_observed_at
  from uk_aq_core.timeseries t
  where t.connector_id = (select connector_id from connector)
    and t.service_ref = 'openaq'
  group by t.station_id
),
  candidates as (
    select
      stn.id as station_id,
      stn.station_ref,
      osc.next_due_at,
      osc.last_polled_at,
    nullif(
      greatest(
        coalesce(osc.last_observed_at, '-infinity'::timestamptz),
        coalesce(lo.last_observed_at, '-infinity'::timestamptz)
      ),
      '-infinity'::timestamptz
    ) as last_observed_at,
    coalesce(osc.next_due_at, now()) as due_at
  from uk_aq_core.stations stn
  left join uk_aq_raw.openaq_station_checkpoints osc
    on osc.station_id = stn.id
  left join latest_obs lo
    on lo.station_id = stn.id
  where stn.connector_id = (select connector_id from connector)
    and stn.service_ref = 'openaq'
    and stn.station_ref is not null
    and stn.removed_at is null
),

tier1_base as (
  select station_id, last_polled_at
  from candidates
  where due_at <= now()
    and due_at >= now() - interval '3 hours'
),
tier1_eligible as (
  select station_id
  from tier1_base
  where last_polled_at is null
     or last_polled_at <= now() - interval '5 minutes'
),
tier1_not_eligible as (
  select station_id
  from tier1_base
  where last_polled_at > now() - interval '5 minutes'
),

future_tier1 as (
  select station_id
  from candidates
  where due_at > now()
),

tier2_base as (
  select station_id, last_polled_at
  from candidates
  where due_at < now() - interval '3 hours'
    and due_at >= now() - interval '24 hours'
),
tier2_eligible as (
  select station_id
  from tier2_base
  where last_polled_at is null
     or last_polled_at <= now() - interval '1 hour'
),
tier2_not_eligible as (
  select station_id
  from tier2_base
  where last_polled_at > now() - interval '1 hour'
),

stale_base as (
  select station_id, last_polled_at
  from candidates
  where not exists (select 1 from tier1_base t where t.station_id = candidates.station_id)
    and not exists (select 1 from tier2_base t where t.station_id = candidates.station_id)
    and not exists (select 1 from future_tier1 f where f.station_id = candidates.station_id)
),
stale_eligible as (
  select station_id
  from stale_base
  where last_polled_at is null
     or last_polled_at <= now() - interval '12 hours'
),
stale_not_eligible as (
  select station_id
  from stale_base
  where last_polled_at > now() - interval '12 hours'
)

select 'tier1' as tier,
       (select count(*) from tier1_eligible)::int as eligible_count,
       (select count(*) from tier1_not_eligible)::int as not_eligible_count
union all
select 'future_tier1',
       (select count(*) from future_tier1)::int,
       null::int
union all
select 'tier2',
       (select count(*) from tier2_eligible)::int,
       (select count(*) from tier2_not_eligible)::int
union all
select 'stale',
       (select count(*) from stale_eligible)::int,
       (select count(*) from stale_not_eligible)::int
union all
select 'total_candidates',
       (select count(*) from candidates)::int,
       null::int;
