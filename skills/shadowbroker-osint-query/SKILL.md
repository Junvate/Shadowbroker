---
name: shadowbroker-osint-query
description: "快速查询 Shadowbroker API 与后端数据文件，并基于证据回答行动情报问题。适用于将问题映射到正确端点或数据文件、拉取小而准的数据子集，并返回简洁结论（例如：当前航班、船舶、SIGINT、无线电、区域档案或数据集可用性检查）。"
---

# Shadowbroker OSINT 查询

使用这个 skill，可以在不扫描整个代码库的前提下快速回答数据类问题。

## 执行流程

1. 判断用户问题的类型。
2. 从 `references/api-endpoints.md` 或 `references/backend-data-catalog.md` 中选择端点或数据源。
3. 使用 `scripts/` 中的脚本拉取最小必要数据。
4. 按用户要求做精确过滤或聚合。
5. 返回证据，并注明端点或文件以及关键字段。

## 快速命令

```bash
# 1) 查询单个端点，并可选提取某个字段
python scripts/query_api.py \
  --base-url http://127.0.0.1:8000 \
  --endpoint /api/live-data/fast \
  --extract commercial_flights \
  --limit 20

# 2) 快速盘点 backend/data
python scripts/profile_backend_data.py \
  --data-dir ../../backend/data \
  --inspect-json-keys
```

## 选择数据源

- 实时运行状态：优先使用 `/api/live-data/fast`、`/api/live-data/slow`、`/api/health`。
- 地理档案或反向查询：使用 `/api/region-dossier`、`/api/geocode/*`。
- 运输类问题：优先检查 live-data 载荷中的 flights、ships、satellites（必要时配合 `$shadowbroker-flight-query`）。
- 历史或静态清单检查：直接读取 `backend/data` 下的文件。

## 输出规则

- 只返回问题真正需要的字段。
- 明确说明数据新鲜度：运行时 API 快照还是静态文件快照。
- 如果数据缺失，直接指出缺失字段，不要猜测。
