---
name: shadowbroker-flight-query
description: 使用可复用条件（目的地、出发地、callsign、IATA、文本匹配、地理围栏）查询并过滤 Shadowbroker 实时航班数据，然后返回简洁且带排序的证据。适用于通用航班发现问题，不要写死国家特定逻辑。
---

# Shadowbroker 航班查询

使用这个 skill，对实时航班流执行通用查询。

## 执行流程

1. 通过 `SHADOWBROKER_API_BASE` 指向的 ShadowBroker 接口拉取最新的 fast 数据快照。
2. 合并全部航班桶（`commercial_flights`、`private_jets`、`private_flights`、`tracked_flights`）。
3. 应用可复用过滤条件（关键词、callsign 前缀、出发地/目的地、IATA、地理围栏）。
4. 按匹配原因排序并返回紧凑证据。

## 运行前提

- 优先依赖环境变量 `SHADOWBROKER_API_BASE`，不要在命令里硬编码 `localhost` / `127.0.0.1` 之类的私网地址。
- `SHADOWBROKER_API_BASE` 应该指向 ShadowBroker 前端接口根，例如 `http://host.docker.internal:6789` 或你的公开入口。
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
# 当前 fast feed 里目的地名称经常缺失，优先用当前位置围栏找东京附近航班
python scripts/query_flights.py --position-bbox 138,140,35,36 --limit 20

# callsign 前缀 + 必须存在有效目的地信息（非占位名称或有效坐标）
python scripts/query_flights.py --callsign-prefix ana --require-destination --json

# 目的地地理围栏（min_lon,max_lon,min_lat,max_lat）
python scripts/query_flights.py --dest-bbox 122,154,24,46 --limit 30

# 当 fast feed 里确实带有目的地名称时，再用关键词过滤
python scripts/query_flights.py --dest-keyword tokyo --limit 20
```

## 输出字段

- `callsign`, `type`, `registration`, `model`
- `lat`, `lng`, `alt`, `speed_knots`
- `origin_name`, `dest_name`, `dest_loc`
- `source_bucket`, `match_reasons`, `match_score`
- 文本输出里如果 `dest_name` 缺失或只是 `UNKNOWN` 这类占位值，但 `dest_loc` 有效，会回退显示目的地坐标。

## 决策规则

- 优先使用显式过滤条件，不要靠猜测。
- 如果某个过滤条件因字段缺失而无法判断，就按不匹配处理。
- 当前 fast feed 里 `origin_name` / `dest_name` 可能大量缺失；查城市或机场时，优先尝试 `--position-bbox`、`--dest-bbox`、`--dest-iata`。
- 始终报告每条匹配结果是由哪些条件命中的。
