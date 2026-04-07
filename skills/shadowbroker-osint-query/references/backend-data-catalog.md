# backend/data 目录清单（运行导向）

默认目录：`backend/data`

## 高价值文件

- `plane_alert_db.json`：重点追踪航空器注册表及元数据。
- `tracked_names.json`：受监控的注册号或名称。
- `military_bases.json`：军事基地位置。
- `power_plants.json`：全球电厂点位。
- `datacenters.json`、`datacenters_geocoded.json`：数据中心清单。
- `plan_ccg_vessels.json`：船舶观察名单与计划中的 CCG 记录。
- `yacht_alert_db.json`：重点游艇追踪记录。
- `sat_gp_cache.json`、`sat_gp_cache_meta.json`、`tinygs_tle_cache.json`：轨道和 TLE 缓存。
- `meshtastic_nodes_cache.json`：Mesh 节点缓存。
- `geocode_cache.json`：地理编码结果缓存。
- `cctv.db`：CCTV 流水线的 SQLite 缓存。
- `infonet.json`、`peer_store.json`、`wormhole_status.json`、`gates/`：Mesh/Wormhole 运行时状态。

## 查询指引

- 遇到静态清单类问题，优先直接读取这些文件，而不是请求实时端点。
- 遇到“当前”类问题（实时航班、船舶、信号），优先使用运行时 API 端点。
- 将 `infonet.json`、`peer_store.json` 和 `wormhole_status.json` 视为可变的运行时状态，而不是静态事实。

## 快速盘点

```bash
python scripts/profile_backend_data.py --data-dir ../../backend/data --inspect-json-keys
```
