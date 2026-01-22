#!/usr/bin/env python3
"""
Ingest LAQN data via the UK-AIR SOS pipeline.

This is a thin wrapper around the UK-AIR SOS ingest script that defaults the
station type filter to LAQN.

Examples:
  python3 scripts/gov_uk_laqn/gov_uk_laqn_ingest.py --discover --backfill-2025
  python3 scripts/gov_uk_laqn/gov_uk_laqn_ingest.py --refresh-recent --hours 6
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.uk_air_sos import uk_air_sos_ingest


def _station_type_flag_present(args: list[str]) -> bool:
    for arg in args:
        if arg == "--station-type" or arg.startswith("--station-type="):
            return True
    return False


def main() -> int:
    argv = sys.argv[1:]
    if not _station_type_flag_present(argv):
        argv = ["--station-type", "LAQN", *argv]
    sys.argv = [sys.argv[0], *argv]
    uk_air_sos_ingest.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
