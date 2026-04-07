#!/usr/bin/env python3
"""快速盘点 backend/data 文件，供 skill 查询使用。"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


def size_mb(path: Path) -> float:
    return round(path.stat().st_size / (1024 * 1024), 3)


def inspect_json(path: Path, inspect_keys: bool) -> dict[str, Any]:
    info: dict[str, Any] = {"type": "json"}
    if not inspect_keys:
        return info
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"json-parse-failed: {exc}"
        return info

    if isinstance(data, list):
        info["shape"] = "list"
        info["count"] = len(data)
        if data and isinstance(data[0], dict):
            info["sample_keys"] = sorted(list(data[0].keys()))[:30]
    elif isinstance(data, dict):
        info["shape"] = "dict"
        info["top_level_keys"] = sorted(list(data.keys()))[:60]
    else:
        info["shape"] = type(data).__name__
    return info


def inspect_sqlite(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"type": "sqlite"}
    try:
        conn = sqlite3.connect(str(path))
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [row[0] for row in cur.fetchall()]
        info["tables"] = tables
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"sqlite-open-failed: {exc}"
    finally:
        try:
            conn.close()  # type: ignore[name-defined]
        except Exception:  # noqa: BLE001
            pass
    return info


def profile(data_dir: Path, inspect_keys: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(data_dir.iterdir()):
        if path.name.startswith("."):
            continue
        row: dict[str, Any] = {
            "name": path.name,
            "kind": "dir" if path.is_dir() else "file",
        }
        if path.is_file():
            row["size_mb"] = size_mb(path)
            suffix = path.suffix.lower()
            if suffix == ".json":
                row.update(inspect_json(path, inspect_keys))
            elif suffix in {".db", ".sqlite", ".sqlite3"}:
                row.update(inspect_sqlite(path))
            else:
                row["type"] = suffix.lstrip(".") or "unknown"
        rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="盘点 backend/data 目录")
    parser.add_argument("--data-dir", default="../../backend/data", help="backend/data 路径")
    parser.add_argument("--inspect-json-keys", action="store_true", help="解析 JSON 并输出结构及示例键")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve()
    if not data_dir.exists() or not data_dir.is_dir():
        raise SystemExit(f"未找到数据目录：{data_dir}")

    output = {
        "data_dir": str(data_dir),
        "files": profile(data_dir, args.inspect_json_keys),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
