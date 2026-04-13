#!/usr/bin/env python3
"""从 Shadowbroker 实时 fast feed 中查询并过滤航班。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = os.environ.get("SHADOWBROKER_API_BASE", "http://127.0.0.1:6789")
FLIGHT_BUCKETS = ["commercial_flights", "private_jets", "private_flights", "tracked_flights"]
TEXT_MATCH_FIELDS = [
    "callsign",
    "icao24",
    "registration",
    "type",
    "model",
    "origin_name",
    "dest_name",
]
IATA_PATTERN = re.compile(r"^\s*([A-Z]{3})\s*:")
MISSING_TEXT_MARKERS = {"UNKNOWN", "N/A", "NULL", "NONE"}


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = [x.strip() for x in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox 必须是 min_lon,max_lon,min_lat,max_lat")
    min_lon, max_lon, min_lat, max_lat = [float(item) for item in parts]
    if min_lon > max_lon or min_lat > max_lat:
        raise ValueError("bbox 的最小值必须小于或等于最大值")
    return min_lon, max_lon, min_lat, max_lat


def point_in_bbox(lon: Any, lat: Any, bbox: tuple[float, float, float, float]) -> bool:
    try:
        lon_f = float(lon)
        lat_f = float(lat)
    except (TypeError, ValueError):
        return False
    min_lon, max_lon, min_lat, max_lat = bbox
    return min_lon <= lon_f <= max_lon and min_lat <= lat_f <= max_lat


def has_coordinate_pair(value: Any) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return False
    try:
        float(value[0])
        float(value[1])
    except (TypeError, ValueError):
        return False
    return True


def parse_iata(dest_name: str) -> str:
    match = IATA_PATTERN.match(dest_name or "")
    if not match:
        return ""
    return match.group(1).upper()


def contains_any_keyword(text: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    lowered = (text or "").lower()
    return any(keyword in lowered for keyword in keywords)


def has_meaningful_text(value: Any) -> bool:
    text = str(value or "").strip()
    return bool(text) and text.upper() not in MISSING_TEXT_MARKERS


def has_destination_data(flight: dict[str, Any]) -> bool:
    return has_meaningful_text(flight.get("dest_name")) or has_coordinate_pair(flight.get("dest_loc"))


def flight_dedupe_key(flight: dict[str, Any]) -> str:
    callsign = str(flight.get("callsign", "")).strip().upper()
    icao24 = str(flight.get("icao24", "")).strip().lower()
    registration = str(flight.get("registration", "")).strip().upper()
    if icao24 or callsign:
        return f"{icao24}|{callsign}"
    if registration:
        return f"reg|{registration}"
    return ""


def flight_quality_key(flight: dict[str, Any]) -> tuple[int, int, int, float, float]:
    populated_fields = sum(
        1
        for field in ("callsign", "icao24", "registration", "type", "model", "origin_name", "dest_name")
        if str(flight.get(field, "")).strip()
    )
    source_bucket = str(flight.get("source_bucket", ""))
    return (
        1 if has_destination_data(flight) else 0,
        populated_fields,
        1 if source_bucket == "tracked_flights" else 0,
        to_float(flight.get("alt")),
        to_float(flight.get("speed_knots")),
    )


def format_location_label(name: Any, coord: Any) -> str:
    if has_meaningful_text(name):
        return str(name).strip()
    if has_coordinate_pair(coord):
        return f"[{float(coord[0]):.4f},{float(coord[1]):.4f}]"
    return "UNKNOWN"


def fetch_fast_snapshot(base_url: str, timeout: float) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/api/live-data/fast"
    req = request.Request(url, method="GET")
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}：{detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"请求失败：{exc}") from exc

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("fast 返回载荷不是合法 JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("fast 返回载荷不是对象")
    return payload


def normalize_flights(payload: dict[str, Any]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_index: dict[str, int] = {}
    for bucket in FLIGHT_BUCKETS:
        entries = payload.get(bucket)
        if not isinstance(entries, list):
            continue
        for item in entries:
            if not isinstance(item, dict):
                continue
            row = dict(item)
            row.setdefault("source_bucket", bucket)
            unique = flight_dedupe_key(row)
            if unique:
                existing_idx = seen_index.get(unique)
                if existing_idx is not None:
                    if flight_quality_key(row) > flight_quality_key(merged[existing_idx]):
                        merged[existing_idx] = row
                    continue
                seen_index[unique] = len(merged)
            merged.append(row)
    return merged


def filter_match_fields(flight: dict[str, Any], keywords: list[str]) -> bool:
    if not keywords:
        return True
    searchable = " ".join(str(flight.get(field, "")) for field in TEXT_MATCH_FIELDS).lower()
    return any(keyword in searchable for keyword in keywords)


def evaluate_flight(
    flight: dict[str, Any],
    args: argparse.Namespace,
    match_terms: list[str],
    origin_terms: list[str],
    dest_terms: list[str],
    dest_iata: set[str],
    position_bbox: tuple[float, float, float, float] | None,
    dest_bbox: tuple[float, float, float, float] | None,
) -> tuple[bool, int, list[str]]:
    reasons: list[str] = []
    score = 0

    callsign = str(flight.get("callsign", "")).strip().upper()
    icao24 = str(flight.get("icao24", "")).strip().lower()
    origin_name = str(flight.get("origin_name", ""))
    dest_name = str(flight.get("dest_name", ""))
    dest_loc = flight.get("dest_loc")

    if args.require_destination and not has_destination_data(flight):
        return False, 0, []

    if match_terms:
        if not filter_match_fields(flight, match_terms):
            return False, 0, []
        reasons.append("match")
        score += 1

    if origin_terms:
        if not contains_any_keyword(origin_name, origin_terms):
            return False, 0, []
        reasons.append("origin_keyword")
        score += 1

    if dest_terms:
        if not contains_any_keyword(dest_name, dest_terms):
            return False, 0, []
        reasons.append("dest_keyword")
        score += 1

    if args.callsign_prefix:
        prefix = str(args.callsign_prefix).strip().upper()
        if not callsign.startswith(prefix):
            return False, 0, []
        reasons.append("callsign_prefix")
        score += 1

    if args.icao24:
        if icao24 != str(args.icao24).strip().lower():
            return False, 0, []
        reasons.append("icao24")
        score += 1

    if dest_iata:
        if parse_iata(dest_name) not in dest_iata:
            return False, 0, []
        reasons.append("dest_iata")
        score += 1

    if position_bbox is not None:
        if not point_in_bbox(flight.get("lng"), flight.get("lat"), position_bbox):
            return False, 0, []
        reasons.append("position_bbox")
        score += 1

    if dest_bbox is not None:
        if not has_coordinate_pair(dest_loc):
            return False, 0, []
        if not point_in_bbox(dest_loc[0], dest_loc[1], dest_bbox):
            return False, 0, []
        reasons.append("dest_bbox")
        score += 1

    return True, score, reasons


def sort_key(sort_mode: str, row: dict[str, Any]) -> tuple[Any, ...]:
    if sort_mode == "altitude":
        return (-to_float(row.get("alt")), -to_float(row.get("speed_knots")), str(row.get("callsign", "")))
    if sort_mode == "speed":
        return (-to_float(row.get("speed_knots")), -to_float(row.get("alt")), str(row.get("callsign", "")))
    if sort_mode == "callsign":
        return (str(row.get("callsign", "")),)
    return (
        -int(row.get("match_score", 0)),
        -to_float(row.get("alt")),
        -to_float(row.get("speed_knots")),
        str(row.get("callsign", "")),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="从 Shadowbroker fast feed 查询并过滤实时航班。")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="ShadowBroker 接口基础地址（默认读取 SHADOWBROKER_API_BASE）",
    )
    parser.add_argument("--timeout", type=float, default=12.0, help="HTTP 超时时间（秒）")
    parser.add_argument("--limit", type=int, default=50, help="最多输出多少条结果")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--match", action="append", default=[], help="通用文本匹配词（可重复）")
    parser.add_argument("--origin-keyword", action="append", default=[], help="出发地关键词（可重复）")
    parser.add_argument("--dest-keyword", action="append", default=[], help="目的地关键词（可重复）")
    parser.add_argument("--callsign-prefix", default="", help="Callsign 前缀，例如 ANA 或 DAL")
    parser.add_argument("--icao24", default="", help="精确匹配 ICAO24 十六进制值")
    parser.add_argument("--dest-iata", action="append", default=[], help="目的地 IATA 代码（可重复）")
    parser.add_argument("--position-bbox", default="", help="当前位置 bbox：min_lon,max_lon,min_lat,max_lat")
    parser.add_argument("--dest-bbox", default="", help="目的地 bbox：min_lon,max_lon,min_lat,max_lat")
    parser.add_argument("--require-destination", action="store_true", help="只保留存在目的地字段的航班")
    parser.add_argument(
        "--sort",
        choices=["match", "altitude", "speed", "callsign"],
        default="match",
        help="排序方式",
    )
    args = parser.parse_args()

    match_terms = [str(t).strip().lower() for t in args.match if str(t).strip()]
    origin_terms = [str(t).strip().lower() for t in args.origin_keyword if str(t).strip()]
    dest_terms = [str(t).strip().lower() for t in args.dest_keyword if str(t).strip()]
    dest_iata = {str(code).strip().upper() for code in args.dest_iata if str(code).strip()}

    try:
        position_bbox = parse_bbox(args.position_bbox) if args.position_bbox else None
        dest_bbox = parse_bbox(args.dest_bbox) if args.dest_bbox else None
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        payload = fetch_fast_snapshot(args.base_url, args.timeout)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    flights = normalize_flights(payload)
    rows: list[dict[str, Any]] = []
    for flight in flights:
        ok, score, reasons = evaluate_flight(
            flight,
            args,
            match_terms,
            origin_terms,
            dest_terms,
            dest_iata,
            position_bbox,
            dest_bbox,
        )
        if not ok:
            continue
        row = {
            "callsign": flight.get("callsign", ""),
            "icao24": flight.get("icao24", ""),
            "type": flight.get("type", ""),
            "registration": flight.get("registration", ""),
            "model": flight.get("model", ""),
            "lat": flight.get("lat"),
            "lng": flight.get("lng"),
            "alt": flight.get("alt"),
            "speed_knots": flight.get("speed_knots"),
            "origin_name": flight.get("origin_name", "UNKNOWN"),
            "dest_name": flight.get("dest_name", "UNKNOWN"),
            "dest_loc": flight.get("dest_loc"),
            "source_bucket": flight.get("source_bucket"),
            "match_reasons": reasons,
            "match_score": score,
        }
        rows.append(row)

    rows.sort(key=lambda row: sort_key(args.sort, row))
    if args.limit > 0:
        rows = rows[: args.limit]

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    print(f"匹配航班数：{len(rows)}")
    if not rows:
        return 0
    for idx, row in enumerate(rows, start=1):
        callsign = str(row.get("callsign") or "UNKNOWN")
        origin = str(row.get("origin_name") or "UNKNOWN")
        dest = format_location_label(row.get("dest_name"), row.get("dest_loc"))
        alt = row.get("alt")
        speed = row.get("speed_knots")
        reasons = ",".join(row.get("match_reasons") or [])
        print(f"{idx:02d}. {callsign:10} {origin} -> {dest} | alt={alt} speed={speed} | {reasons}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
