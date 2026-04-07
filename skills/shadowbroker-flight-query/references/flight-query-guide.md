# 航班查询指南

## 相关航班字段

来自实时航班载荷（`/api/live-data/fast`）：

- `callsign`
- `type`
- `registration`
- `model`
- `lat`, `lng`, `alt`, `speed_knots`
- `origin_name`, `dest_name`
- `origin_loc`, `dest_loc`（格式：`[lon, lat]`）

## 通用过滤构件

1. 文本过滤：
   - `--match` 用于关键身份字段的文本匹配。
   - `--origin-keyword` 和 `--dest-keyword` 用于按航线语义过滤。
2. 标识过滤：
   - `--callsign-prefix`
   - `--icao24`
   - `--dest-iata`，从类似 `NRT: Narita International Airport` 的目的地标签中解析。
3. 地理围栏过滤：
   - `--position-bbox min_lon,max_lon,min_lat,max_lat` 作用于飞机当前位置。
   - `--dest-bbox min_lon,max_lon,min_lat,max_lat` 作用于目的地坐标。
4. 数据质量保护：
   - `--require-destination` 只保留存在目的地名称或坐标的记录。

## 置信度评分

- 分数按命中的过滤条件累加。
- 命中条件越多，排序越高。
- 同分时依次比较高度、速度、callsign。

优先按更高分排序，再看高度和速度。
