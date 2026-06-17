-- Reusable guarded repair for ObsAQIDB observed_properties ID drift.
-- Apply on ObsAQIDB. The daily core sync calls this only when
-- OBS_AQIDB_REPAIR_OBSERVED_PROPERTY_IDS=1.

create or replace function uk_aq_public.uk_aq_rpc_repair_observed_property_id_drift(
  p_repairs jsonb
)
returns table (
  code text,
  source_id bigint,
  destination_id bigint,
  phenomena_rewired integer,
  stale_rows_deleted integer
)
language plpgsql
security definer
set search_path = uk_aq_public, uk_aq_core, public
as $$
declare
  item jsonb;
  src_row jsonb;
  v_code text;
  v_source_id bigint;
  v_destination_id bigint;
  v_target_code text;
  v_stale_code text;
  v_phenomena_rewired integer;
  v_stale_rows_deleted integer;
begin
  if p_repairs is null or jsonb_typeof(p_repairs) <> 'array' then
    raise exception 'p_repairs must be a JSON array';
  end if;

  for item in select * from jsonb_array_elements(p_repairs)
  loop
    v_code := nullif(btrim(item->>'code'), '');
    v_source_id := nullif(item->>'source_id', '')::bigint;
    v_destination_id := nullif(item->>'destination_id', '')::bigint;
    src_row := item->'source_row';

    if v_code is null or v_source_id is null or v_destination_id is null or src_row is null then
      raise exception 'Invalid observed_properties repair item: %', item;
    end if;
    if v_source_id = v_destination_id then
      raise exception 'Refusing no-op observed_properties repair for code=% id=%', v_code, v_source_id;
    end if;
    if nullif(btrim(src_row->>'code'), '') is distinct from v_code then
      raise exception 'Repair source_row code does not match repair code for %: %', v_code, src_row;
    end if;
    if nullif(src_row->>'id', '')::bigint is distinct from v_source_id then
      raise exception 'Repair source_row id does not match source_id for %: %', v_code, src_row;
    end if;

    select op.code into v_stale_code
    from uk_aq_core.observed_properties op
    where op.id = v_destination_id
    for update;

    if v_stale_code is distinct from v_code then
      raise exception 'Refusing observed_properties repair for code=%: destination id % has code %, expected %',
        v_code, v_destination_id, v_stale_code, v_code;
    end if;

    select op.code into v_target_code
    from uk_aq_core.observed_properties op
    where op.id = v_source_id
    for update;

    if v_target_code is not null and v_target_code <> v_code then
      raise exception 'Refusing observed_properties repair for code=%: source id % is already used by code %',
        v_code, v_source_id, v_target_code;
    end if;

    update uk_aq_core.observed_properties
    set code = v_code || '__stale_obs_aqidb_id_' || v_destination_id::text,
        updated_at = now()
    where id = v_destination_id
      and code = v_code;

    if v_target_code is null then
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
        v_source_id,
        v_code,
        src_row->>'display_name',
        src_row->>'domain',
        src_row->>'canonical_uom',
        nullif(src_row->>'created_at', '')::timestamptz,
        nullif(src_row->>'updated_at', '')::timestamptz
      );
    else
      update uk_aq_core.observed_properties
      set display_name = src_row->>'display_name',
          domain = src_row->>'domain',
          canonical_uom = src_row->>'canonical_uom',
          updated_at = coalesce(nullif(src_row->>'updated_at', '')::timestamptz, now())
      where id = v_source_id
        and code = v_code;
    end if;

    update uk_aq_core.phenomena
    set observed_property_id = v_source_id
    where observed_property_id = v_destination_id;
    get diagnostics v_phenomena_rewired = row_count;

    delete from uk_aq_core.observed_properties
    where id = v_destination_id
      and code = v_code || '__stale_obs_aqidb_id_' || v_destination_id::text;
    get diagnostics v_stale_rows_deleted = row_count;

    if exists (
      select 1
      from uk_aq_core.phenomena p
      where p.observed_property_id = v_destination_id
    ) then
      raise exception 'Refusing observed_properties repair for code=%: phenomena rows still reference stale id %',
        v_code, v_destination_id;
    end if;
    if not exists (
      select 1 from uk_aq_core.observed_properties op where op.id = v_source_id and op.code = v_code
    ) then
      raise exception 'Observed_properties repair failed for code=%: final source id % row not found',
        v_code, v_source_id;
    end if;
    if exists (
      select 1 from uk_aq_core.observed_properties op where op.id = v_destination_id
    ) then
      raise exception 'Observed_properties repair failed for code=%: stale destination id % still exists',
        v_code, v_destination_id;
    end if;

    code := v_code;
    source_id := v_source_id;
    destination_id := v_destination_id;
    phenomena_rewired := v_phenomena_rewired;
    stale_rows_deleted := v_stale_rows_deleted;
    return next;
  end loop;

  perform setval(
    pg_get_serial_sequence('uk_aq_core.observed_properties', 'id'),
    greatest(coalesce((select max(id) from uk_aq_core.observed_properties), 1), 1),
    true
  );
end;
$$;
