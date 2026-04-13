#!/usr/bin/env python3
"""从 Shadowbroker 实时 fast feed 中查询并过滤船舶。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = os.environ.get("SHADOWBROKER_API_BASE", "http://127.0.0.1:6789")
TEXT_MATCH_FIELDS = [
    "name",
    "type",
    "callsign",
    "destination",
    "country",
    "desc",
    "source",
    "source_url",
    "wiki",
    "plan_name",
    "plan_class",
    "plan_force",
    "plan_hull",
    "plan_wiki",
]


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_carrier_hull(value: Any) -> str:
    text = normalize_text(value).upper().replace(" ", "")
    if not text:
        return ""
    match = re.search(r"\bCVN-?(\d+)\b", text)
    if not match:
        return text
    return f"CVN-{match.group(1)}"


def extract_carrier_hull(ship: dict[str, Any]) -> str:
    text = " ".join(
        [
            normalize_text(ship.get("name")),
            normalize_text(ship.get("desc")),
            normalize_text(ship.get("wiki")),
        ]
    )
    match = re.search(r"\bCVN-?(\d+)\b", text.upper())
    if not match:
        return ""
    return f"CVN-{match.group(1)}"


def has_plan_metadata(ship: dict[str, Any]) -> bool:
    return any(
        normalize_text(ship.get(field))
        for field in ("plan_name", "plan_class", "plan_force", "plan_hull", "plan_wiki")
    )


def to_timestamp(value: Any, default: float = 0.0) -> float:
    text = normalize_text(value)
    if not text:
        return default
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
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


def contains_any_keyword(text: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    lowered = normalize_text(text).lower()
    return any(keyword in lowered for keyword in keywords)


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


def normalize_ships(payload: dict[str, Any]) -> list[dict[str, Any]]:
    ships = payload.get("ships")
    if not isinstance(ships, list):
        return []
    return [item for item in ships if isinstance(item, dict)]


def evaluate_ship(
    ship: dict[str, Any],
    args: argparse.Namespace,
    match_terms: list[str],
    name_terms: list[str],
    dest_terms: list[str],
    ship_types: set[str],
    countries: set[str],
    source_terms: list[str],
    plan_name_terms: list[str],
    plan_classes: set[str],
    plan_forces: set[str],
    bbox: tuple[float, float, float, float] | None,
) -> tuple[bool, int, list[str]]:
    reasons: list[str] = []
    score = 0

    name = normalize_text(ship.get("name"))
    ship_type = normalize_text(ship.get("type")).lower()
    callsign = normalize_text(ship.get("callsign")).upper()
    destination = normalize_text(ship.get("destination"))
    country = normalize_text(ship.get("country")).lower()
    mmsi = normalize_text(ship.get("mmsi"))
    imo = normalize_text(ship.get("imo"))
    estimated = bool(ship.get("estimated"))
    sog = to_float(ship.get("sog"), default=0.0)
    source = normalize_text(ship.get("source"))
    source_url = normalize_text(ship.get("source_url"))
    plan_name = normalize_text(ship.get("plan_name"))
    plan_class = normalize_text(ship.get("plan_class")).lower()
    plan_force = normalize_text(ship.get("plan_force")).lower()
    plan_hull = normalize_text(ship.get("plan_hull")).upper()
    carrier_hull = extract_carrier_hull(ship)

    if args.estimated_only and not estimated:
        return False, 0, []
    if args.live_only and estimated:
        return False, 0, []
    if args.require_mmsi and not mmsi:
        return False, 0, []
    if args.require_destination and not destination:
        return False, 0, []
    if args.carrier_only and ship_type != "carrier":
        return False, 0, []
    if args.plan_only and not has_plan_metadata(ship):
        return False, 0, []

    if match_terms:
        searchable = " ".join(str(ship.get(field, "")) for field in TEXT_MATCH_FIELDS)
        searchable = f"{searchable} {mmsi} {imo} {carrier_hull}".lower()
        if not any(term in searchable for term in match_terms):
            return False, 0, []
        reasons.append("match")
        score += 1

    if name_terms:
        if not contains_any_keyword(name, name_terms):
            return False, 0, []
        reasons.append("name_keyword")
        score += 1

    if dest_terms:
        if not contains_any_keyword(destination, dest_terms):
            return False, 0, []
        reasons.append("dest_keyword")
        score += 1

    if ship_types:
        if ship_type not in ship_types:
            return False, 0, []
        reasons.append("ship_type")
        score += 1

    if countries:
        if country not in countries:
            return False, 0, []
        reasons.append("country")
        score += 1

    if source_terms:
        searchable_source = f"{source} {source_url}".lower()
        if not any(term in searchable_source for term in source_terms):
            return False, 0, []
        reasons.append("source_keyword")
        score += 1

    if args.callsign:
        if callsign != normalize_text(args.callsign).upper():
            return False, 0, []
        reasons.append("callsign")
        score += 1

    if args.callsign_prefix:
        prefix = normalize_text(args.callsign_prefix).upper()
        if not callsign.startswith(prefix):
            return False, 0, []
        reasons.append("callsign_prefix")
        score += 1

    if args.mmsi:
        if mmsi != normalize_text(args.mmsi):
            return False, 0, []
        reasons.append("mmsi")
        score += 1

    if args.imo:
        if imo != normalize_text(args.imo):
            return False, 0, []
        reasons.append("imo")
        score += 1

    if args.carrier_hull:
        if carrier_hull != normalize_carrier_hull(args.carrier_hull):
            return False, 0, []
        reasons.append("carrier_hull")
        score += 1

    if plan_name_terms:
        if not contains_any_keyword(plan_name, plan_name_terms):
            return False, 0, []
        reasons.append("plan_name")
        score += 1

    if plan_classes:
        if plan_class not in plan_classes:
            return False, 0, []
        reasons.append("plan_class")
        score += 1

    if plan_forces:
        if plan_force not in plan_forces:
            return False, 0, []
        reasons.append("plan_force")
        score += 1

    if args.plan_hull:
        if plan_hull != normalize_text(args.plan_hull).upper():
            return False, 0, []
        reasons.append("plan_hull")
        score += 1

    if bbox is not None:
        if not point_in_bbox(ship.get("lng"), ship.get("lat"), bbox):
            return False, 0, []
        reasons.append("bbox")
        score += 1

    if args.min_sog is not None:
        if sog < args.min_sog:
            return False, 0, []
        reasons.append("min_sog")
        score += 1

    if args.max_sog is not None:
        if sog > args.max_sog:
            return False, 0, []
        reasons.append("max_sog")
        score += 1

    return True, score, reasons


def sort_key(sort_mode: str, row: dict[str, Any]) -> tuple[Any, ...]:
    if sort_mode == "speed":
        return (
            -to_float(row.get("sog")),
            -int(row.get("match_score", 0)),
            normalize_text(row.get("name")),
        )
    if sort_mode == "name":
        return (
            normalize_text(row.get("name")).lower(),
            normalize_text(row.get("type")).lower(),
            normalize_text(row.get("country")).lower(),
        )
    if sort_mode == "type":
        return (
            normalize_text(row.get("type")).lower(),
            normalize_text(row.get("name")).lower(),
            normalize_text(row.get("country")).lower(),
        )
    if sort_mode == "country":
        return (
            normalize_text(row.get("country")).lower(),
            normalize_text(row.get("type")).lower(),
            normalize_text(row.get("name")).lower(),
        )
    if sort_mode == "update":
        return (
            -to_timestamp(row.get("last_osint_update")),
            -int(row.get("match_score", 0)),
            normalize_text(row.get("name")).lower(),
        )
    return (
        -int(row.get("match_score", 0)),
        -to_float(row.get("sog")),
        normalize_text(row.get("name")).lower(),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="从 Shadowbroker fast feed 查询并过滤实时船舶。")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="ShadowBroker 接口基础地址（默认读取 SHADOWBROKER_API_BASE）",
    )
    parser.add_argument("--timeout", type=float, default=12.0, help="HTTP 超时时间（秒）")
    parser.add_argument("--limit", type=int, default=50, help="最多输出多少条结果")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--match", action="append", default=[], help="通用文本匹配词（可重复）")
    parser.add_argument("--name-keyword", action="append", default=[], help="船名关键词（可重复）")
    parser.add_argument("--dest-keyword", action="append", default=[], help="目的地关键词（可重复）")
    parser.add_argument("--ship-type", action="append", default=[], help="船型精确匹配（可重复）")
    parser.add_argument("--country", action="append", default=[], help="国家精确匹配（可重复）")
    parser.add_argument("--source-keyword", action="append", default=[], help="来源或来源 URL 关键词（可重复）")
    parser.add_argument("--mmsi", default="", help="精确匹配 MMSI")
    parser.add_argument("--imo", default="", help="精确匹配 IMO")
    parser.add_argument("--callsign", default="", help="精确匹配 callsign")
    parser.add_argument("--callsign-prefix", default="", help="Callsign 前缀")
    parser.add_argument("--carrier-only", action="store_true", help="只保留航母打击群 tracker 的 carrier 对象")
    parser.add_argument("--carrier-hull", default="", help="精确匹配航母舷号，例如 CVN-78")
    parser.add_argument("--plan-only", action="store_true", help="只保留带 PLAN/CCG 增强元数据的船舶")
    parser.add_argument("--plan-name", action="append", default=[], help="PLAN/CCG 舰名关键词（可重复）")
    parser.add_argument("--plan-class", action="append", default=[], help="PLAN/CCG 舰级精确匹配（可重复）")
    parser.add_argument("--plan-force", action="append", default=[], help="PLAN 或 CCG 精确匹配（可重复）")
    parser.add_argument("--plan-hull", default="", help="精确匹配 PLAN/CCG 舷号，例如 101")
    parser.add_argument("--bbox", default="", help="当前位置 bbox：min_lon,max_lon,min_lat,max_lat")
    parser.add_argument("--min-sog", type=float, default=None, help="最小对地航速（节）")
    parser.add_argument("--max-sog", type=float, default=None, help="最大对地航速（节）")
    parser.add_argument("--estimated-only", action="store_true", help="只保留 estimated=true 的对象")
    parser.add_argument("--live-only", action="store_true", help="排除 estimated=true 的对象")
    parser.add_argument("--require-mmsi", action="store_true", help="只保留带 MMSI 的对象")
    parser.add_argument("--require-destination", action="store_true", help="只保留存在目的地字段的对象")
    parser.add_argument(
        "--sort",
        choices=["match", "speed", "name", "type", "country", "update"],
        default="match",
        help="排序方式",
    )
    args = parser.parse_args()

    if args.estimated_only and args.live_only:
        print("--estimated-only 与 --live-only 不能同时使用", file=sys.stderr)
        return 2
    if args.min_sog is not None and args.max_sog is not None and args.min_sog > args.max_sog:
        print("min-sog 不能大于 max-sog", file=sys.stderr)
        return 2

    match_terms = [normalize_text(t).lower() for t in args.match if normalize_text(t)]
    name_terms = [normalize_text(t).lower() for t in args.name_keyword if normalize_text(t)]
    dest_terms = [normalize_text(t).lower() for t in args.dest_keyword if normalize_text(t)]
    ship_types = {normalize_text(t).lower() for t in args.ship_type if normalize_text(t)}
    countries = {normalize_text(t).lower() for t in args.country if normalize_text(t)}
    source_terms = [normalize_text(t).lower() for t in args.source_keyword if normalize_text(t)]
    plan_name_terms = [normalize_text(t).lower() for t in args.plan_name if normalize_text(t)]
    plan_classes = {normalize_text(t).lower() for t in args.plan_class if normalize_text(t)}
    plan_forces = {normalize_text(t).lower() for t in args.plan_force if normalize_text(t)}

    try:
        bbox = parse_bbox(args.bbox) if args.bbox else None
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        payload = fetch_fast_snapshot(args.base_url, args.timeout)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    ships = normalize_ships(payload)
    rows: list[dict[str, Any]] = []
    for ship in ships:
        ok, score, reasons = evaluate_ship(
            ship,
            args,
            match_terms,
            name_terms,
            dest_terms,
            ship_types,
            countries,
            source_terms,
            plan_name_terms,
            plan_classes,
            plan_forces,
            bbox,
        )
        if not ok:
            continue
        row = {
            "name": ship.get("name", "UNKNOWN"),
            "type": ship.get("type", ""),
            "mmsi": ship.get("mmsi"),
            "imo": ship.get("imo"),
            "callsign": ship.get("callsign", ""),
            "destination": ship.get("destination", "UNKNOWN"),
            "country": ship.get("country", "UNKNOWN"),
            "lat": ship.get("lat"),
            "lng": ship.get("lng"),
            "heading": ship.get("heading"),
            "sog": ship.get("sog"),
            "cog": ship.get("cog"),
            "estimated": bool(ship.get("estimated")),
            "source": ship.get("source", ""),
            "source_url": ship.get("source_url", ""),
            "wiki": ship.get("wiki", ""),
            "desc": ship.get("desc", ""),
            "last_osint_update": ship.get("last_osint_update", ""),
            "carrier_hull": extract_carrier_hull(ship),
            "plan_name": ship.get("plan_name", ""),
            "plan_class": ship.get("plan_class", ""),
            "plan_force": ship.get("plan_force", ""),
            "plan_hull": ship.get("plan_hull", ""),
            "plan_wiki": ship.get("plan_wiki", ""),
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

    print(f"匹配船舶数：{len(rows)}")
    if not rows:
        return 0

    for idx, row in enumerate(rows, start=1):
        name = normalize_text(row.get("name")) or "UNKNOWN"
        ship_type = normalize_text(row.get("type")) or "unknown"
        country = normalize_text(row.get("country")) or "UNKNOWN"
        destination = normalize_text(row.get("destination")) or "UNKNOWN"
        mmsi = normalize_text(row.get("mmsi")) or "-"
        callsign = normalize_text(row.get("callsign")) or "-"
        sog = row.get("sog")
        reasons = ",".join(row.get("match_reasons") or [])
        estimated = " estimated" if row.get("estimated") else ""
        carrier_hull = normalize_text(row.get("carrier_hull"))
        plan_force = normalize_text(row.get("plan_force"))
        plan_hull = normalize_text(row.get("plan_hull"))
        plan_class = normalize_text(row.get("plan_class"))
        tags = []
        if carrier_hull:
            tags.append(carrier_hull)
        if plan_force or plan_hull or plan_class:
            plan_bits = [bit for bit in (plan_force, plan_hull, plan_class) if bit]
            tags.append("/".join(plan_bits))
        extra = f" [{' ; '.join(tags)}]" if tags else ""
        print(
            f"{idx:02d}. {name} [{ship_type}{estimated}] "
            f"mmsi={mmsi} callsign={callsign} country={country} dest={destination} "
            f"sog={sog}{extra} | {reasons}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
