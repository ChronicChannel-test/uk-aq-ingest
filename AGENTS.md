# Agent Notes

## Naming
- Prefer `uk_aq` in filenames, scripts, and docs (avoid `ukair`).
- `UK-AIR SOS` is a service name and must never be changed to `UK-AQ SOS`.
- AQ means Air Quality in this project.
- For SOS-derived UK networks, use `gov_uk_<network>_` prefixes (e.g., `gov_uk_aurn_`) and place them under `scripts/gov_uk_<network>/`.
- For non-SOS networks, use the network prefix (e.g., `sensorcommunity_`) and place them under a matching `scripts/<network>/` directory.
- Connectors represent data sources; SOS networks live in `uk_air_sos_networks` (use `network_display_name` for UI) and must not be added to `connectors`. Non-SOS connectors are 1:1 with their network.
- Terminology: `*_ref` = source identifier; `*_code` = internal unique code; `label` = raw source label string; `display_name` = UI-friendly name we curate.
- LAQN is sourced from ERG (London Air), not GOV.UK; use connector code `erg_laqn` with connector-facing prefixes `erg_laqn_` under `scripts/erg_laqn/`.
- For LAQN connectors, use `label` = `ERG London Air` and `display_name` = `London Air LAQN`.
- Use the `laqn_` prefix when referring to the network (not the connector).

## Runtime
- Use `python3` for all Python scripts and commands.

## Archive
- Files in `archive/` can be referenced for context but must never be modified once created. Adding new files/directories under `archive/` is allowed.

## Code removal
- Remove any legacy code if it is definitely redundant.
- This project was never completed, so assume all existing code is still relevant.

## Documentation
- Add a script note to `system_docs/uk_aq_scripts.md` when new scripts are added.
- Add a per-network doc in `system_docs/` (e.g., `uk_air_sos.md`) when a new network is introduced.
- When `supabase/uk_air_quality_schema.sql` changes, update `system_docs/schema-overview.md` to match.
- When new tables are added, add a matching doc in `system_docs/table_info/`.
- When new edge functions are added under `supabase/functions/`, update `.github/workflows/supabase_edge_deploy.yml` to deploy them.
- When edge functions are modified, update `system_docs/uk_aq_edge_functions.md`.
- When functions or logic change, update the relevant `system_docs/` pages accordingly.
- `system_docs/` is markdown-only; store data files under `network_info/` in the relevant network directory.
- Naming for any file/function: single-network uses the network name prefix; all SOS networks use `uk_air_sos_`; all networks use `uk_aq_`.

## Station Name Enrichment
- Keep enrichment logic centralized in `scripts/uk_aq_enrich_station_names.py` so report scripts stay in sync.

## Planning Requests
- When proposing plans, offer more than one option when possible, list pros/cons for each, and recommend which to pick with a brief rationale.
