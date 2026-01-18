# UK-AIR SOS Network Memberships

This document explains how SOS network memberships are derived, what data is stored, and what the edge functions return.

## Overview
- SOS stations can belong to multiple UK-AIR networks (AURN, LAQN, WAQN, etc.).
- Memberships are stored in `station_network_memberships` with `network_code` + `is_primary`.
- Source network metadata lives in `uk_air_sos_networks` (`network_ref`, `network_code`, `network_display_name`).
- Memberships are filtered by pollutant coverage using `uk_air_sos_network_pollutants`.

## Tables Involved
- `uk_air_sos_site_register`: authoritative snapshot of UK-AIR sites and their networks.
- `uk_air_sos_networks`: network lookup (source labels + our internal codes + UI names).
- `uk_air_sos_network_pollutants`: pollutant matching rules per network.
- `uk_air_sos_station_refs`: links SOS stations to UK-AIR IDs and match metadata.
- `station_network_memberships`: per-station network memberships.

## How Memberships Are Built
1) Load the UK-AIR register:
   - `scripts/uk_air_sos/uk_air_sos_site_register.py --load`
   - Populates `uk_air_sos_site_register`, `uk_air_sos_networks`, and `uk_air_sos_network_pollutants`.
2) Set `uk_air_sos_networks.network_code` for any network you want included in memberships.
3) Backfill memberships:
   - `scripts/uk_aq_backfill_station_memberships.py`
   - Matches SOS stations to the register (UK-AIR ID when available, otherwise name+distance).
   - Builds pollutant keys from station timeseries -> phenomena.
   - Filters network refs by pollutant rules.
   - Maps filtered network refs to `network_code` and writes `station_network_memberships`.

## Pollutant Filtering Logic
- `match_type` is `contains` or `exact`.
- Pollutant keys are normalized (lowercased, non-alphanumeric removed).
- A network is allowed if any rule matches a station's pollutant keys.
- Networks without rules are skipped.

## Membership Data Shape
`station_network_memberships` rows look like:
```
station_id, network_code, network_label, is_primary
```

Example (station is in AURN + LAQN):
```
12345, gov_uk_aurn, GOV.UK AURN, true
12345, laqn, LAQN, false
```

Notes:
- `network_code` is the internal identifier (from `uk_air_sos_networks.network_code`).
- `network_label` is populated from `uk_air_sos_networks.network_display_name` during backfill.
- `is_primary` is true when a station is single-network, or when `gov_uk_aurn` is present.

## Edge Function Outputs
`uk_aq_latest`:
- Returns `station_network_memberships` as provided (no filtering at query time).
- For SOS stations in multiple networks, the response includes all memberships.

`uk_aq_stations`:
- Returns station geometry plus `station_network_memberships` array.

In both functions the array is shaped as:
```
[
  { network_code, network_label, is_primary },
  ...
]
```

## Audit/Debug Report
Use `scripts/uk_air_sos/uk_air_sos_membership_report.py` to generate a CSV with:
- Station + register match details
- Pollutant keys
- Allowed/filtered network refs
- Expected vs actual memberships
