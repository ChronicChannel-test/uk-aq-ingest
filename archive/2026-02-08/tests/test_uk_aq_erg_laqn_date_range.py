from datetime import datetime, timedelta, timezone

from scripts.erg_laqn.erg_laqn_ingest import _build_erg_date_range


def test_erg_laqn_date_range_end_date_is_tomorrow_utc() -> None:
    now = datetime(2026, 1, 26, 8, 30, tzinfo=timezone.utc)
    start_date, end_date = _build_erg_date_range(now, None, None, 1)
    assert start_date == datetime(2026, 1, 26, tzinfo=timezone.utc)
    assert end_date == datetime(2026, 1, 27, tzinfo=timezone.utc)


def test_erg_laqn_date_range_uses_utc_boundaries() -> None:
    pacific = timezone(timedelta(hours=-8))
    now = datetime(2026, 1, 26, 0, 30, tzinfo=pacific)
    _, end_date = _build_erg_date_range(now, None, None, 1)
    assert end_date == datetime(2026, 1, 27, tzinfo=timezone.utc)
