# 船舶查询指南

## 相关字段

来自实时船舶载荷（`/api/live-data/fast` 的 `ships` 字段）：

- `name`
- `type`
- `mmsi`, `imo`, `callsign`
- `destination`, `country`
- `lat`, `lng`, `heading`, `sog`, `cog`
- `estimated`, `source`, `source_url`, `wiki`, `desc`, `last_osint_update`
- `carrier_hull`（skill 侧从航母名称/描述中提取）
- `plan_name`, `plan_class`, `plan_force`, `plan_hull`, `plan_wiki`

## 数据异构性

`ships` 桶混合三类对象：

1. AIS 实时船只
   - 通常带 `mmsi`
   - 常见字段：`callsign`, `imo`, `destination`
   - 典型 `type`：`cargo`, `tanker`, `passenger`, `yacht`, `military_vessel`, `other`, `unknown`
2. OSINT 估计位置对象
   - 典型是 `carrier`
   - 通常带 `estimated=true`
   - 常见字段：`source`, `source_url`, `wiki`, `desc`, `last_osint_update`
3. AIS + PLAN/CCG 增强对象
   - 仍然是 AIS 船，只是被 `plan_vessel_alert.py` 按 MMSI 命中后补上 `plan_*`
   - 常见字段：`plan_name`, `plan_class`, `plan_force`, `plan_hull`, `plan_wiki`

分离这几类对象时：

- 用 `--estimated-only` 看估计位置对象
- 用 `--live-only` 排除估计位置对象
- 用 `--require-mmsi` 强制只看带 MMSI 的 AIS 对象
- 用 `--carrier-only` 只看航母 tracker 对象
- 用 `--plan-only` 只看带中国海军 / 海警增强的对象

## 专项来源映射

### 航母打击群 tracker

- 后端来源：`backend/services/carrier_tracker.py`
- 进入 `ships` 的方式：`fetchers/geo.py` 调 `get_carrier_positions()` 后并入 `ships`
- 数据特征：
  - `type=carrier`
  - `estimated=true`
  - `source` 常见为 `GDELT News API` 或 `USNI News Fleet & Marine Tracker`
  - `name` 一般带 `CVN-xx`

推荐过滤器：

- `--carrier-only`
- `--carrier-hull CVN-78`
- `--source-keyword gdelt`
- `--sort update`

### 中国海军 / 海警舰艇增强

- 后端来源：`backend/services/fetchers/plan_vessel_alert.py`
- 底库文件：`backend/data/plan_ccg_vessels.json`
- 进入 `ships` 的方式：`fetchers/geo.py` 对每条船执行 `enrich_with_plan_vessel(ship)`
- 数据特征：
  - 通常仍有 MMSI / 船位 / 航速等 AIS 字段
  - 命中底库后附加 `plan_name`, `plan_class`, `plan_force`, `plan_hull`, `plan_wiki`

推荐过滤器：

- `--plan-only`
- `--plan-force PLAN`
- `--plan-force CCG`
- `--plan-class "Type 055"`
- `--plan-hull 101`
- `--plan-name liaoning`

## 通用过滤构件

1. 文本过滤
   - `--match` 用于跨字段文本匹配（船名、类型、callsign、目的地、国家、说明、来源、PLAN 增强字段）
   - `--name-keyword` 用于船名关键词
   - `--dest-keyword` 用于目的地关键词
   - `--source-keyword` 用于来源 / 来源 URL 关键词
2. 标识过滤
   - `--mmsi`
   - `--imo`
   - `--callsign`
   - `--callsign-prefix`
   - `--carrier-hull`
   - `--plan-hull`
3. 分类过滤
   - `--ship-type`
   - `--country`
   - `--carrier-only`
   - `--plan-only`
   - `--plan-name`
   - `--plan-class`
   - `--plan-force`
4. 地理与运动过滤
   - `--bbox min_lon,max_lon,min_lat,max_lat` 作用于船当前位置
   - `--min-sog` / `--max-sog` 限制对地航速
5. 数据质量保护
   - `--require-destination`
   - `--require-mmsi`

## 排序规则

- `match`：优先匹配分，再看速度和船名
- `speed`：优先更快的船
- `update`：优先最近 OSINT 更新时间，适合航母 tracker
- `name` / `type` / `country`：适合做清单式浏览

默认优先按命中过滤条件的数量排序。
