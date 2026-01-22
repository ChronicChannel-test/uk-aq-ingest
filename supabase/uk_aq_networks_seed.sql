-- Seed curated networks (run after connectors are present).
-- Safe to rerun; updates display_name/connector_code/is_active by network_code.

insert into uk_aq_networks (network_code, display_name, connector_code, is_active)
values
  ('breathelondon', 'Breathe London', 'breathelondon', true),
  ('gov_uk_aurn', 'GOV.UK AURN', 'uk_air_sos', true),
  ('laqn', 'London Air LAQN', 'erg_laqn', true),
  ('sensorcommunity', 'Sensor.Community', 'sensorcommunity', true)
on conflict (network_code) do update
set display_name = excluded.display_name,
    connector_code = excluded.connector_code,
    is_active = excluded.is_active;
