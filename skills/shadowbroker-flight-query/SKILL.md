---
name: shadowbroker-flight-query
description: 使用可复用条件（目的地、出发地、callsign、IATA、文本匹配、地理围栏）查询并过滤 Shadowbroker 实时航班数据，然后返回简洁且带排序的证据。适用于通用航班发现问题，不要写死国家特定逻辑。
---

# Shadowbroker 航班查询

使用这个 skill，对实时航班流执行通用查询。

## 执行流程

1. 拉取最新的 fast 数据快照。
2. 合并全部航班桶（`commercial_flights`、`private_jets`、`private_flights`、`tracked_flights`）。
3. 应用可复用过滤条件（关键词、callsign 前缀、出发地/目的地、IATA、地理围栏）。
4. 按匹配原因排序并返回紧凑证据。

## 运行前提

- 使用 nanobot 的 `exec` 工具时，必须把 `working_dir` 设为 `skills/shadowbroker-flight-query`，否则 `python scripts/query_flights.py` 会在错误目录下执行。

## 主命令

```bash
python scripts/query_flights.py \
  --limit 50
```

对应的 `exec` 调用应类似：

```json
{
  "command": "python scripts/query_flights.py --limit 50",
  "working_dir": "skills/shadowbroker-flight-query"
}
```

## 常见示例

```bash
# 目的地关键词
python scripts/query_flights.py --dest-keyword tokyo --limit 20

# callsign 前缀 + 必须存在目的地信息
python scripts/query_flights.py --callsign-prefix ana --require-destination --json

# 目的地地理围栏（min_lon,max_lon,min_lat,max_lat）
python scripts/query_flights.py --dest-bbox 122,154,24,46 --limit 30
```

## 输出字段

- `callsign`, `type`, `registration`, `model`
- `lat`, `lng`, `alt`, `speed_knots`
- `origin_name`, `dest_name`, `dest_loc`
- `source_bucket`, `match_reasons`, `match_score`

## 决策规则

- 优先使用显式过滤条件，不要靠猜测。
- 如果某个过滤条件因字段缺失而无法判断，就按不匹配处理。
- 始终报告每条匹配结果是由哪些条件命中的。
