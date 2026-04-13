---
name: shadowbroker-ship-query
description: 使用可复用条件（船名、MMSI、IMO、callsign、船型、国家、目的地、地理围栏、速度阈值，以及 carrier tracker / PLAN-CCG 专用字段）查询并过滤 Shadowbroker 实时船舶数据，然后返回简洁且带排序理由的证据。适用于通用船舶发现问题、航母打击群追踪和中国海军/海警舰艇筛查；不要写死单一港口或一次性情境逻辑。
---

# Shadowbroker 船舶查询

使用这个 skill，对实时 `ships` 数据执行通用查询，并显式覆盖两个专项来源：

- `carrier_tracker.py`：美国航母打击群 OSINT 估计位置
- `plan_vessel_alert.py`：中国海军 / 海警舰艇 MMSI 增强

## 执行流程

1. 通过 `SHADOWBROKER_API_BASE` 指向的 ShadowBroker 接口拉取最新的 fast 数据快照。
2. 读取 `ships` 桶并保留船舶对象。
3. 根据问题类型选择过滤模式：
   - 通用 AIS 船舶：MMSI / IMO / callsign / 目的地 / bbox / 航速
   - 航母打击群：`--carrier-only`、`--carrier-hull`、`--source-keyword`、`--sort update`
   - 中国海军 / 海警：`--plan-only`、`--plan-name`、`--plan-class`、`--plan-force`、`--plan-hull`
4. 按匹配原因排序并返回紧凑证据。

## 运行前提

- 优先依赖环境变量 `SHADOWBROKER_API_BASE`，不要在命令里硬编码 `localhost` / `127.0.0.1` 之类的私网地址。
- `SHADOWBROKER_API_BASE` 应该指向 ShadowBroker 前端接口根，例如 `http://host.docker.internal:6789` 或你的公开入口。
- 使用 nanobot 的 `exec` 工具时，必须把 `working_dir` 设为 `skills/shadowbroker-ship-query`，否则 `python scripts/query_ships.py` 会在错误目录下执行。
- 当问题是在问端点可用性、原始载荷结构或后端文件来源时，优先改用 `$shadowbroker-osint-query`；当前 skill 专注于船舶结果过滤。

## 主命令

```bash
python scripts/query_ships.py \
  --limit 50
```

对应的 `exec` 调用应类似：

```json
{
  "command": "python scripts/query_ships.py --limit 50",
  "working_dir": "skills/shadowbroker-ship-query"
}
```

## 常见示例

```bash
# 按目的地关键词找船
python scripts/query_ships.py --dest-keyword SINGAPORE --limit 20

# 精确查某条船
python scripts/query_ships.py --mmsi 538090091 --json

# 查某类船 + 国家
python scripts/query_ships.py --ship-type cargo --country panama --limit 30

# 查当前位置在某个海域内且正在移动的船
python scripts/query_ships.py --bbox 103,106,1,4 --min-sog 5 --limit 25

# 只看航母打击群 tracker 对象
python scripts/query_ships.py --carrier-only --sort update --json

# 精确看某艘美军航母
python scripts/query_ships.py --carrier-only --carrier-hull CVN-78 --json

# 查中国海军 055 大驱
python scripts/query_ships.py --plan-only --plan-force PLAN --plan-class "Type 055" --limit 20

# 查中国海警船
python scripts/query_ships.py --plan-only --plan-force CCG --bbox 118,126,20,32 --json
```

更详细的字段说明和过滤构件见 [references/ship-query-guide.md](references/ship-query-guide.md)。

## 输出字段

- `name`, `type`, `mmsi`, `imo`, `callsign`
- `destination`, `country`
- `lat`, `lng`, `heading`, `sog`, `cog`
- `estimated`, `source`, `source_url`, `wiki`, `desc`, `last_osint_update`, `carrier_hull`
- `plan_name`, `plan_class`, `plan_force`, `plan_hull`, `plan_wiki`
- `match_reasons`, `match_score`

## 决策规则

- 优先使用显式过滤条件，不要靠猜测。
- 如果某个过滤条件因字段缺失而无法判断，就按不匹配处理。
- `ships` 桶混合了 AIS 船只和 OSINT 估计位置对象。要分离二者时，优先使用 `--estimated-only`、`--live-only`、`--require-mmsi`。
- 当用户明确在问“航母打击群”时，优先从 `--carrier-only` 开始，不要在普通 AIS 船里盲搜 `carrier` 关键词。
- 当用户明确在问“中国海军 / 海警 / PLAN / CCG”时，优先使用 `--plan-only` 和 `plan_*` 过滤器，而不是只靠 `country=china`。
- 始终报告每条匹配结果是由哪些条件命中的。
