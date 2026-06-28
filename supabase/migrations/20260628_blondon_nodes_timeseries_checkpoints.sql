create table if not exists uk_aq_raw.blondon_nodes_timeseries_checkpoints (
  station_id bigint not null references uk_aq_core.stations(id) on delete cascade,
  species text not null,
  timeseries_id bigint references uk_aq_core.timeseries(id) on delete set null,
  last_observed_at timestamptz,
  last_polled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (station_id, species)
);

create index if not exists blondon_nodes_timeseries_checkpoints_timeseries_id_idx
  on uk_aq_raw.blondon_nodes_timeseries_checkpoints(timeseries_id);

create index if not exists blondon_nodes_timeseries_checkpoints_last_observed_at_idx
  on uk_aq_raw.blondon_nodes_timeseries_checkpoints(last_observed_at desc);
