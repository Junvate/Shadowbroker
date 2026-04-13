"""Tests for AIS vessel ingestion, snapshot shaping, and feed endpoint."""

import asyncio
import time

import pytest
from httpx import ASGITransport, AsyncClient

from services import ais_stream


@pytest.fixture(autouse=True)
def clear_ais_state(tmp_path, monkeypatch):
    """Keep the in-memory AIS store isolated per test."""
    monkeypatch.setattr(ais_stream, "CACHE_FILE", tmp_path / "ais_cache.json")
    with ais_stream._vessels_lock:
        ais_stream._vessels.clear()
        ais_stream._ws_running = False
        ais_stream._ws_thread = None
        ais_stream._proxy_process = None
    yield
    with ais_stream._vessels_lock:
        ais_stream._vessels.clear()
        ais_stream._ws_running = False
        ais_stream._ws_thread = None
        ais_stream._proxy_process = None


def test_ingest_ais_catcher_merges_position_and_static_messages():
    messages = [
        {
            "mmsi": 538090091,
            "type": 1,
            "lat": 37.7749,
            "lon": -122.4194,
            "speed": 12.3,
            "course": 85.1,
            "heading": 84,
            "shipname": "TEST SHIP",
        },
        {
            "mmsi": 538090091,
            "type": 5,
            "shipname": "TEST SHIP",
            "callsign": "TEST1",
            "imo": 1234567,
            "destination": "SFO",
            "shiptype": 70,
        },
    ]

    ingested = ais_stream.ingest_ais_catcher(messages)
    vessels = ais_stream.get_ais_vessels()

    assert ingested == 1
    assert vessels == [
        {
            "mmsi": 538090091,
            "name": "TEST SHIP",
            "type": "cargo",
            "lat": 37.7749,
            "lng": -122.4194,
            "heading": 84,
            "sog": 12.3,
            "cog": 85.1,
            "callsign": "TEST1",
            "destination": "SFO",
            "imo": 1234567,
            "country": "Marshall Islands",
        }
    ]


def test_get_ais_vessels_prunes_stale_entries_and_sanitizes_speed():
    now = time.time()
    with ais_stream._vessels_lock:
        ais_stream._vessels[111111111] = {
            "mmsi": 111111111,
            "name": "STALE",
            "lat": 10.0,
            "lng": 20.0,
            "_updated": now - 901,
        }
        ais_stream._vessels[222222222] = {
            "mmsi": 222222222,
            "name": "FAST SHIP",
            "type": "unknown",
            "lat": 12.34567,
            "lng": 45.67891,
            "heading": 270,
            "sog": 102.3,
            "cog": 180.0,
            "callsign": "FAST2",
            "destination": "",
            "imo": 7654321,
            "_updated": now,
        }
        ais_stream._vessels[333333333] = {
            "mmsi": 333333333,
            "name": "NO POSITION",
            "_updated": now,
        }

    vessels = ais_stream.get_ais_vessels()

    assert 111111111 not in ais_stream._vessels
    assert vessels == [
        {
            "mmsi": 222222222,
            "name": "FAST SHIP",
            "type": "unknown",
            "lat": 12.34567,
            "lng": 45.67891,
            "heading": 270,
            "sog": 0,
            "cog": 180.0,
            "callsign": "FAST2",
            "destination": "UNKNOWN",
            "imo": 7654321,
            "country": "UNKNOWN",
        }
    ]


def test_ais_feed_accepts_decoded_messages():
    import main

    payload = {
        "msgs": [
            {
                "mmsi": 316123456,
                "type": 18,
                "lat": 49.2827,
                "lon": -123.1207,
                "speed": 6.4,
                "course": 44.8,
                "heading": 45,
                "shipname": "HARBOR RUNNER",
            },
            {
                "mmsi": 316123456,
                "type": 24,
                "shipname": "HARBOR RUNNER",
                "callsign": "C6TEST",
                "destination": "VANCOUVER",
                "shiptype": 60,
            },
        ]
    }

    async def _exercise():
        transport = ASGITransport(app=main.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            return await ac.post("/api/ais/feed", json=payload)

    response = asyncio.run(_exercise())
    vessels = ais_stream.get_ais_vessels()

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "ingested": 1,
        "received": payload["msgs"],
        "vessels": vessels,
    }
    assert vessels[0]["name"] == "HARBOR RUNNER"
    assert vessels[0]["type"] == "passenger"
    assert vessels[0]["callsign"] == "C6TEST"
    assert vessels[0]["destination"] == "VANCOUVER"
    assert vessels[0]["country"] == "Canada"


def test_ais_feed_rejects_invalid_json_body():
    import main

    async def _exercise():
        transport = ASGITransport(app=main.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            return await ac.post(
                "/api/ais/feed",
                content=b"{not-json",
                headers={"Content-Type": "application/json"},
            )

    response = asyncio.run(_exercise())

    assert response.status_code == 422
    assert response.json() == {"ok": False, "detail": "invalid JSON body"}
