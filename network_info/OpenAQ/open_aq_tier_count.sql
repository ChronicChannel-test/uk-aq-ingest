with v_connector as (
  select id
  from uk_aq_core.connectors
  where connector_code = 'openaq'
  limit 1
),
latest_obs as (
  select
    t.station_id,
    max(t.last_value_at) as last_observed_at
  from uk_aq_core.timeseries t
  where t.connector_id = (select id from v_connector)
    and t.service_ref = 'openaq'
  group by t.station_id
),
candidates as (
  select
    stn.id as station_id,
    stn.station_ref,
    osc.next_due_at,
    osc.last_polled_at,
    coalesce(osc.last_observed_at, lo.last_observed_at) as last_observed_at,
    coalesce(osc.next_due_at, now()) as due_at
  from uk_aq_core.stations stn
  left join uk_aq_raw.openaq_station_checkpoints osc
    on osc.station_id = stn.id
  left join latest_obs lo
    on lo.station_id = stn.id
  where stn.connector_id = (select id from v_connector)
    and stn.service_ref = 'openaq'
    and stn.station_ref is not null
    and stn.removed_at is null
),
tier1 as (
  select station_id
  from candidates
  where due_at <= now()
    and due_at >= now() - interval '3 hours'
    and (last_polled_at is null or last_polled_at <= now() - interval '15 minutes')
),
tier2 as (
  select station_id
  from candidates
  where due_at < now() - interval '3 hours'
    and due_at >= now() - interval '24 hours'
    and (last_polled_at is null or last_polled_at <= now() - interval '1 hour')
),
stale as (
  select station_id
  from candidates c
  where (c.last_observed_at is null or c.last_observed_at <= now() - interval '24 hours')
    and (c.last_polled_at is null or c.last_polled_at <= now() - interval '12 hours')
    and not exists (
      select 1 from (select station_id from tier1 union select station_id from tier2) t
      where t.station_id = c.station_id
    )
)
select
  (select count(*) from candidates) as candidate_count,
  (select count(*) from tier1) as tier1_count,
  (select count(*) from tier2) as tier2_count,
  (select count(*) from stale) as stale_count;
