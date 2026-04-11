#!/usr/bin/env python3
"""Shadowbroker API 最小查询助手。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib import error, parse, request


DEFAULT_BASE_URL = os.environ.get("SHADOWBROKER_API_BASE", "http://127.0.0.1:6789")


def parse_key_value(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"无效的 key=value 参数：{item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"参数中的键不能为空：{item}")
        out[key] = value
    return out


def deep_get(value: Any, path: str) -> Any:
    cur: Any = value
    for token in [part for part in path.split(".") if part]:
        if isinstance(cur, list):
            try:
                idx = int(token)
            except ValueError as exc:
                raise KeyError(f"访问列表时必须提供整数索引：'{token}'") from exc
            cur = cur[idx]
            continue
        if isinstance(cur, dict):
            if token not in cur:
                raise KeyError(f"缺少字段：'{token}'")
            cur = cur[token]
            continue
        raise KeyError(f"无法继续向下提取：'{token}'")
    return cur


def build_url(base_url: str, endpoint: str, query: dict[str, str]) -> str:
    endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    base = base_url.rstrip("/")
    url = f"{base}{endpoint}"
    if query:
        url = f"{url}?{parse.urlencode(query)}"
    return url


def main() -> int:
    parser = argparse.ArgumentParser(description="查询 Shadowbroker API 端点。")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="ShadowBroker 接口基础地址（默认读取 SHADOWBROKER_API_BASE）",
    )
    parser.add_argument("--endpoint", required=True, help="端点路径，例如 /api/live-data/fast")
    parser.add_argument("--method", default="GET", choices=["GET", "POST"], help="HTTP 方法")
    parser.add_argument("--param", action="append", default=[], help="查询参数 key=value（可重复）")
    parser.add_argument("--header", action="append", default=[], help="请求头 key=value（可重复）")
    parser.add_argument("--json", dest="json_body", help="POST 使用的内联 JSON 请求体")
    parser.add_argument("--json-file", help="POST 使用的 JSON 文件路径")
    parser.add_argument("--extract", help="点路径提取，例如 commercial_flights 或 data.items.0")
    parser.add_argument("--limit", type=int, default=0, help="当结果为列表时，只保留前 N 条")
    parser.add_argument("--timeout", type=float, default=12.0, help="HTTP 超时时间（秒）")
    args = parser.parse_args()

    try:
        query_params = parse_key_value(args.param)
        headers = parse_key_value(args.header)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    body_bytes: bytes | None = None
    if args.method == "POST":
        body_obj: Any = None
        if args.json_body:
            body_obj = json.loads(args.json_body)
        elif args.json_file:
            body_obj = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
        if body_obj is not None:
            body_bytes = json.dumps(body_obj, ensure_ascii=False).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")

    url = build_url(args.base_url, args.endpoint, query_params)
    req = request.Request(url, method=args.method, data=body_bytes)
    for key, value in headers.items():
        req.add_header(key, value)

    try:
        with request.urlopen(req, timeout=args.timeout) as resp:
            status = resp.status
            raw = resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}：{detail}", file=sys.stderr)
        return 1
    except error.URLError as exc:
        print(f"请求失败：{exc}", file=sys.stderr)
        return 1

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(raw)
        return 0 if 200 <= status < 300 else 1

    if args.extract:
        try:
            data = deep_get(data, args.extract)
        except (KeyError, IndexError) as exc:
            print(f"提取失败：{exc}", file=sys.stderr)
            return 2

    if isinstance(data, list) and args.limit > 0:
        data = data[: args.limit]

    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
