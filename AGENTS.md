# Agent Notes

## Naming
- Prefer `uk_aq` in filenames, scripts, and docs (avoid `ukair`).
- `UK-AIR SOS` is a service name and must never be changed to `UK-AQ SOS`.
- AQ means Air Quality in this project.

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
