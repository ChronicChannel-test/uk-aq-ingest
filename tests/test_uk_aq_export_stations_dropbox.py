from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "uk_aq_export_stations_dropbox.py"
).read_text(encoding="utf-8")


def test_station_export_uses_canonical_network_identity() -> None:
    assert "join uk_aq_core.networks n on n.id = stn.network_id" in SCRIPT
    assert "stn.network_id" in SCRIPT
    assert "n.network_code" in SCRIPT
    assert "n.display_name as network_label" in SCRIPT

    for field in ("network_id", "network_code", "network_label"):
        assert f'"{field}": row.get("{field}")' in SCRIPT


def test_station_export_keeps_connector_provenance() -> None:
    assert '"connector_id": row.get("connector_id")' in SCRIPT
    assert '"connector_code": row.get("connector_code")' in SCRIPT


def test_station_export_has_no_legacy_network_model_references() -> None:
    forbidden = (
        "station_network_memberships",
        "network_memberships",
        "network_name",
        "uk_aq_networks",
    )
    for marker in forbidden:
        assert marker not in SCRIPT
