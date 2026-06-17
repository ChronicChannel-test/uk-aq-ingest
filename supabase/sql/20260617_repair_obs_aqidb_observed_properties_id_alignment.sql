-- Repair ObsAQIDB observed_properties rows whose natural key already exists
-- with a different surrogate ID than IngestDB.
--
-- Run this patch on ObsAQIDB before re-running the daily core sync. It preserves
-- the source/IngestDB ID for code = 'oc6h4ch32' and rewires core phenomena FKs
-- from the stale destination ID (16) to the source ID (17).

begin;

-- Fail fast unless the database is in the known bad state from the failed sync.
do $$
begin
  if not exists (
    select 1
    from uk_aq_core.observed_properties
    where id = 16 and code = 'oc6h4ch32'
  ) then
    raise exception 'Expected stale observed_properties row id=16 code=oc6h4ch32 was not found';
  end if;

  if exists (
    select 1
    from uk_aq_core.observed_properties
    where id = 17 and code <> 'oc6h4ch32'
  ) then
    raise exception 'Cannot repair oc6h4ch32: observed_properties id=17 is already used by another code';
  end if;
end $$;

-- Move the stale row out of the way so the source-ID row can use the canonical code.
update uk_aq_core.observed_properties
set code = 'oc6h4ch32__stale_obs_aqidb_id_16',
    updated_at = now()
where id = 16
  and code = 'oc6h4ch32';

-- Insert the source/IngestDB row if it is not already present.
insert into uk_aq_core.observed_properties (
  id,
  code,
  display_name,
  domain,
  canonical_uom,
  created_at,
  updated_at
)
values (
  17,
  'oc6h4ch32',
  'o-C6H4-(CH3)2',
  'aq',
  null,
  '2026-06-09 17:53:47.13964+00'::timestamptz,
  '2026-06-09 17:53:47.13964+00'::timestamptz
)
on conflict (id) do update
set code = excluded.code,
    display_name = excluded.display_name,
    domain = excluded.domain,
    canonical_uom = excluded.canonical_uom,
    updated_at = excluded.updated_at;

-- Rewire destination core FKs that pointed at the stale destination ID.
update uk_aq_core.phenomena
set observed_property_id = 17
where observed_property_id = 16;

-- Remove the stale duplicate natural-key row after dependencies are rewired.
delete from uk_aq_core.observed_properties
where id = 16
  and code = 'oc6h4ch32__stale_obs_aqidb_id_16';

-- Keep the identity sequence ahead of the repaired source ID for future inserts.
select setval(
  pg_get_serial_sequence('uk_aq_core.observed_properties', 'id'),
  greatest(
    coalesce((select max(id) from uk_aq_core.observed_properties), 1),
    17
  ),
  true
);

commit;
