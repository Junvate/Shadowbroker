"""Tests for PLAN/CCG vessel enrichment."""

from services.fetchers.plan_vessel_alert import _PLAN_CCG_DB, enrich_with_plan_vessel


def test_plan_ccg_db_loads_on_import():
    assert _PLAN_CCG_DB
    assert "412000001" in _PLAN_CCG_DB


def test_enrich_with_plan_vessel_matches_known_mmsi():
    ship = {"mmsi": 412000001, "name": "UNKNOWN"}

    enriched = enrich_with_plan_vessel(ship)

    assert enriched["plan_name"] == "Nanchang"
    assert enriched["plan_class"] == "Type 055"
    assert enriched["plan_force"] == "PLAN"
    assert enriched["plan_hull"] == "101"
    assert "wikipedia.org" in enriched["plan_wiki"]


def test_enrich_with_plan_vessel_leaves_unknown_mmsi_untouched():
    ship = {"mmsi": 413170000, "name": "XIN ZHANG ZHOU"}

    enriched = enrich_with_plan_vessel(ship.copy())

    assert enriched == ship
