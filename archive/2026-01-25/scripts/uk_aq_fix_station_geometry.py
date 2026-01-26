#!/usr/bin/env python3
"""
Fix swapped station geometry coordinates (lat/lon reversed) in Supabase.

Requires:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def main() -> int:
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 1

    client = create_client(supabase_url, service_role_key)
    response = client.rpc("uk_aq_fix_station_geometry_swapped").execute()
    updated = response.data if hasattr(response, "data") else None
    print(f"Updated station geometries: {updated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
