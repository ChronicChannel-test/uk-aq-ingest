# Phase 1 Hard-Cut Inventory Bundle

This bundle captures Phase 1 outputs for the cross-repo `obs_aqidb` refactor.

Files:
- `phase1_inventory.csv`: grouped dependency inventory (`repo+file+token`) with proposed target names.
- `phase1_naming_contract.md`: hard-cut naming contract (no legacy fallback).
- `phase1_migration_risks.md`: migration risks, inventory summaries, and gate checklist.

Generation notes:
- Source repos scanned: ingest, ops, schema.
- `archive/` paths excluded from matching.
- Inventory includes runtime, CI/config, tests, tooling/UI, and docs/plans references.
