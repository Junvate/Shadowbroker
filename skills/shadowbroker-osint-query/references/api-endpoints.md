# API 端点（查询导向）

使用本文件为问题挑选能够回答问题的最小端点。

## 1) 核心运行时快照

- `GET /api/health`：服务健康状态、运行时长、数据新鲜度摘要。
- `GET /api/live-data`：完整的合并快照。
- `GET /api/live-data/fast`：高频图层（航班、船舶、卫星、SIGINT、CCTV）。
- `GET /api/live-data/slow`：低频图层（新闻、天气、市场、基础设施集合）。

## 2) 地理与档案

- `GET /api/region-dossier?lat=<>&lng=<>`：国家级上下文档案。
- `GET /api/geocode/search?q=...&limit=...`：正向地理编码。
- `GET /api/geocode/reverse?lat=<>&lng=<>`：反向地理编码。
- `GET /api/route/{callsign}`：在可用时返回某个 callsign 的航线信息。

## 3) 无线电 / SIGINT 工具

- `GET /api/radio/top`
- `GET /api/radio/openmhz/systems`
- `GET /api/radio/openmhz/calls/{sys_name}`
- `GET /api/radio/nearest?lat=<>&lng=<>`
- `GET /api/radio/nearest-list?lat=<>&lng=<>`

## 4) Sentinel / 对地观测

- `GET /api/sentinel2/search?lat=<>&lng=<>&...`
- `POST /api/sentinel/token`
- `POST /api/sentinel/tile`

## 5) 访问范围说明

- 受管理员保护的端点使用 `Depends(require_admin)`。
- 受本地操作员保护的端点使用 `Depends(require_local_operator)`。
- 除非明确要求特权操作，公开只读查询应优先走 health、live-data、geocode、region、radio 相关端点。
