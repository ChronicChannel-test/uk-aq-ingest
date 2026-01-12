-- Drop all tables defined in supabase/uk_air_quality_schema.sql.
-- Run this before re-applying the schema.

drop table if exists observations cascade;
drop table if exists reference_values cascade;
drop table if exists timeseries cascade;
drop table if exists station_pcon_history cascade;
drop table if exists stations cascade;
drop table if exists la_boundaries cascade;
drop table if exists pcon_boundaries cascade;
drop table if exists pcon_current cascade;
drop table if exists pcon_legacy cascade;
drop table if exists gss_codes cascade;
drop table if exists uk_aq_region_names cascade;
drop table if exists procedures cascade;
drop table if exists features cascade;
drop table if exists offerings cascade;
drop table if exists phenomena cascade;
drop table if exists categories cascade;
drop table if exists pm25_amct_sites cascade;
drop table if exists pm25_population_exposure cascade;
drop table if exists connectors cascade;

-- Views + helper tables from supabase/uk_air_quality_views.sql
drop view if exists bristol_latest_pollutants cascade;
drop view if exists la_latest_pm25 cascade;
drop view if exists pcon_latest_pm25 cascade;
drop table if exists pollutant_thresholds cascade;
