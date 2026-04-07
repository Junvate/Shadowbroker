# Shadowbroker 技术逻辑总结

## 1. 项目是什么

Shadowbroker 本质上是一个“多源 OSINT 情报聚合与可视化平台”。

它做的不是单点查询，而是把飞机、船舶、卫星、新闻、冲突、无线电、CCTV、互联网设备、空气质量、天气、火灾、地震、Mesh 节点等公开数据，统一拉到一个地图和控制台界面里，形成一个实时态势面板。

从仓库实现看，它不是只有前端页面，而是一个完整系统，主要由下面几层组成：

1. 前端可视化层：`Next.js 16 + React 19 + MapLibre GL`
2. 后端聚合层：`FastAPI + Python`
3. 实时数据编排层：定时任务 + Web/API 拉取 + 局部流式数据
4. Mesh / Wormhole 通信层：用于 InfoNet、Gate、DM、匿名模式和本地私有控制
5. 隐私核心层：`Rust privacy-core`，通过 FFI 给 Python 提供加密与会话能力
6. 容器/部署层：`docker-compose`、Helm、桌面壳/Tauri 脚手架

一句话概括：

> Shadowbroker 是一个把公开世界信号集中采集、统一缓存、关联分析、再投射到地图和终端上的情报可视化平台。

---

## 2. 整体技术架构

### 2.1 前端

前端在 `frontend/`，核心技术是：

- Next.js 16
- React 19
- MapLibre GL
- Framer Motion
- TypeScript

前端首页在 `frontend/src/app/page.tsx`，可以看出它是一个“大屏式地图工作台”，核心 UI 包括：

- 地图主画布
- 左侧世界态势面板
- 新闻流
- 市场/预测面板
- 筛选器
- 定位搜索
- Shodan 面板
- Mesh Chat / Mesh Terminal / Infonet Terminal
- 设置面板

前端并不直接写死后端地址，而是通过 `frontend/src/app/api/[...path]/route.ts` 做统一代理：

- 浏览器只访问前端自己的 `/api/*`
- Next.js 服务端再把请求转发到 `BACKEND_URL`
- 这样可以避免把后端地址编译进前端 bundle
- 也方便 Docker 内部网络和权限隔离

### 2.2 后端

后端入口是 `backend/main.py`，核心技术是：

- FastAPI
- APScheduler
- 多线程并发抓取
- 内存缓存 + 局部持久化
- 一组非常大的 API 集合

后端职责不是“做重业务逻辑”，而是：

1. 管理数据源配置和密钥
2. 周期性抓取不同领域数据
3. 统一清洗成前端可消费的结构
4. 提供快慢两层 API
5. 承担 Mesh / Wormhole / DM / Oracle / Gate 等能力
6. 输出健康状态、设置状态、更新控制、权限控制

### 2.3 部署

默认部署是 Docker：

- `frontend` 容器跑前端
- `backend` 容器跑 FastAPI
- 前端通过 `BACKEND_URL=http://backend:8000` 访问后端

`docker-compose.yml` 也说明了几个关键点：

- 后端暴露 `8000`
- 前端暴露 `3000`
- 后端有 `backend_data` 卷用于保存数据
- 后端可以接收很多 API Key 和 Mesh/Wormhole 参数

---

## 3. 技术逻辑是怎么跑起来的

如果从“系统运行链路”看，Shadowbroker 的核心逻辑可以拆成 6 步。

### 3.1 第一步：后端启动并加载配置

`backend/main.py` 启动时会：

- 读取环境变量和 Docker Secret
- 初始化 FastAPI
- 配置 CORS、GZip、安全头、无缓存头
- 初始化管理员认证逻辑
- 启动数据调度器
- 启动 AIS、Carrier Tracker、Wormhole 等附属服务

这一步决定了系统的基础运行条件，例如：

- 是否启用管理员密钥
- 是否启用 Wormhole / Mesh
- 是否启用 Shodan / Finnhub / OpenSky 等外部服务

### 3.2 第二步：调度器按快慢分层抓数据

真正的数据编排核心在 `backend/services/data_fetcher.py`。

这个文件很重要，因为它说明 Shadowbroker 不是“一次性拉全量数据”，而是分层调度：

#### 快速层 fast-tier

更新频率高，主要是移动目标和高时效数据：

- 航班
- 军机
- 船舶
- 卫星
- SIGINT
- 列车
- TinyGS

#### 慢速层 slow-tier

更新频率相对低，主要是背景态势和上下文数据：

- 新闻
- 预测市场
- 地震
- 火灾
- 天气 / 气象告警
- 互联网中断
- CCTV
- KiwiSDR
- SatNOGS
- 冲突前线
- 数据中心
- 军事基地
- 电厂
- 渔业活动
- 乌克兰空袭告警

#### 全量刷新

系统启动时会做一次并发全量预热，尽快把地图先填满，再进入定时更新节奏。

这套设计的意义是：

- 高频目标快速刷新，保证“动起来”
- 低速背景慢一点拉，降低系统负担
- 前端拿到的是后端已经聚合好的缓存，而不是每次都自己拼数据

### 3.3 第三步：后端把多源数据统一写入共享存储

`services/fetchers/_store.py` 是共享状态中心，`data_fetcher.py` 中所有抓取模块都会往 `latest_data` 里写。

可以理解为：

- 每个数据抓取器负责自己的域
- 所有域最终汇总到一个统一的数据快照
- 后端 API 再从这个快照里切片返回给前端

这意味着 Shadowbroker 的后端更像一个“情报缓存与编排引擎”，而不是传统 CRUD 后台。

### 3.4 第四步：相关性引擎做跨层融合

`backend/services/correlation_engine.py` 是比较关键的价值层。

它不只是展示原始数据，还会做跨图层关联，比如：

- GPS 干扰 + 网络中断 = `rf_anomaly`
- 军机 + 军舰 + 冲突事件 = `military_buildup`
- 网络中断 + KiwiSDR 异常 = `infrastructure_cascade`

这说明 Shadowbroker 的逻辑不是单纯“数据地图”，而是在往“事件推断/态势融合”方向走。

也就是说，它试图回答的不是：

> 世界上现在有什么点位？

而是：

> 哪些点位同时出现了多种异常信号，值得优先关注？

### 3.5 第五步：前端分层轮询并增量渲染

前端数据更新的核心在：

- `frontend/src/hooks/useDataPolling.ts`
- `frontend/src/hooks/useDataStore.ts`

这里的逻辑也很清楚：

#### 前端不自己做复杂聚合

它从后端拿两类接口：

- `/api/live-data/fast`
- `/api/live-data/slow`

#### 使用 ETag 做增量拉取

如果数据没变化，后端返回 `304`，前端就不重新处理。

#### 使用细粒度状态订阅减少重渲染

`useDataStore.ts` 不是把所有数据塞进一个大对象后全量重渲染，而是：

- 按 key 订阅
- 哪个数据片段变了，只通知相关组件

这个设计对大屏地图系统很重要，因为地图实体很多，频繁全量重渲染会很卡。

### 3.6 第六步：地图层与终端层共同消费数据

前端并不是只有地图。

它有两种主要消费方式：

#### 地图消费

例如：

- 飞机、船、卫星、火灾、冲突点、CCTV、Shodan 点位等，直接渲染在地图上

#### 终端/面板消费

例如：

- 新闻流
- Mesh Chat
- Infonet Terminal
- 预测市场
- 区域档案
- 地理反查

因此，Shadowbroker 的交互模式是：

> 地图负责空间态势，终端和面板负责细节解释、通信和操作。

---

## 4. InfoNet / Wormhole / Mesh 的技术逻辑

这是 Shadowbroker 和一般 OSINT 地图区别最大的部分。

### 4.1 它不只是看数据，还尝试做“去中心化情报通信”

后端 API 中有大量 `/api/mesh/*`、`/api/wormhole/*` 路由，说明项目在做一个实验性通信层，主要能力包括：

- Mesh 发消息
- Gate 创建与发言
- Infonet 同步
- Oracle 预测与投票
- DM 注册、公钥、预密钥、发送、轮询
- 身份轮换与信誉系统

这部分说明 Shadowbroker 想把“地图情报”升级为“情报节点网络”。

### 4.2 Wormhole 是本地私有控制与传输层

从 `backend/wormhole_server.py` 和 `backend/services/wormhole_supervisor.py` 看：

- Wormhole 是一个本地代理/本地 agent
- 默认跑在 `127.0.0.1:8787`
- 可根据配置切换 direct / Tor / I2P / mixnet 等传输
- 配置变化时会自动重启自身
- supervisor 负责监控状态、拉起进程、判断传输级别

所以 Wormhole 的角色不是“主业务 API”，而是：

- 给高隐私/匿名模式提供本地受控入口
- 让敏感的 Mesh/DM 请求尽量不直接走普通浏览器通道

### 4.3 privacy-core 是未来隐私能力的核心承载

`privacy-core/` 是 Rust crate，`backend/services/privacy_core_client.py` 通过 ctypes 调它。

这个设计非常关键，意味着项目在尝试把“私密协议状态”从 Python 移到 Rust：

- Python 负责 orchestration
- Rust 持有 opaque handle 和协议状态
- Python 尽量只看到句柄和序列化后的密文

当前实现可以看出它已经有：

- identity
- key package
- group
- commit
- DM session
- group encrypt / decrypt
- DM encrypt / decrypt

这代表 Shadowbroker 的方向不是简单聊天，而是在向更正式的加密通信协议演进。

### 4.4 但当前版本仍是实验态

README 和代码都反复强调：

- InfoNet 还是实验测试网
- 并不是成熟隐私通信系统
- 某些通道只是混淆，不是真正端到端隐私

所以技术定位应该理解为：

> 已经具备通信与隐私基础设施的雏形，但还没有到可以对外宣称“强隐私通信产品”的程度。

---

## 5. Shadowbroker 现在能做什么

从仓库实际模块看，它现在大致能做下面这些事。

### 5.1 全局态势监控

- 在一个地图界面里同时查看飞机、舰船、卫星、新闻、冲突、天气、火灾、地震等多种图层
- 做全球范围的空间态势浏览
- 对地区进行右键式区域档案查询和反地理编码

### 5.2 交通与军事目标跟踪

- 跟踪商业航班、军机、私人飞机
- 跟踪 AIS 船舶、渔船、航母相关目标
- 跟踪卫星与地面站
- 跟踪列车

### 5.3 信息与事件融合

- 聚合新闻、地缘政治、冲突前线
- 关联军事活动和事件热点
- 自动给出跨源关联异常

### 5.4 基础设施与开放信号观察

- 互联网中断
- 数据中心
- 电厂
- CCTV
- KiwiSDR
- OpenMHz / radio intercept
- Meshtastic / APRS / PSK Reporter 等无线电相关点位

### 5.5 地图上的调查辅助

- 地点搜索
- 逆地理编码
- 区域 dossier
- Sentinel 相关卫星影像搜索
- Shodan 结果叠加
- Unusual Whales / 预测市场类补充情报

### 5.6 节点式通信与实验性协作

- Mesh send / Gate message
- Infonet 同步
- Dead Drop / DM
- 身份轮换、信誉、投票、报告
- Oracle 市场预测与共识

也就是说，它既是：

- OSINT 态势地图

也是：

- 实验性的去中心化情报协作终端

---

## 6. 这个项目的核心价值点

如果从产品理解上总结，Shadowbroker 的价值不是“某一个数据源很强”，而是下面 4 点。

### 6.1 把分散的数据源变成统一态势

大多数 OSINT 工具只做一个领域，比如只看飞机、只看船、只看新闻。

Shadowbroker 的核心价值是把这些源整合成一个统一工作面。

### 6.2 强调空间化表达

它几乎所有能力都往地图上收敛。

也就是说，它不是“表格情报库”，而是“空间态势系统”。

### 6.3 强调实时性和多层次刷新

快数据和慢数据分层拉取，使得它适合做持续观察，而不是一次性检索。

### 6.4 在可视化之外加入通信层

InfoNet / Wormhole / Mesh / DM / Oracle 这些模块，说明它想把“观察世界”进一步变成“节点协作世界”。

这也是它和普通地图看板最大的不同。

---

## 7. 适合用来做什么

比较适合的场景：

- OSINT 研究
- 地缘政治监测
- 航空 / 海事 / 无线电观察
- 事件态势大屏
- 多源公开信号关联分析
- 实验性 Mesh 协作与匿名消息测试

不应该误解成的场景：

- 不是成熟的军用指挥系统
- 不是完备的隐私通信产品
- 不是取代专业情报数据库的全量平台
- 不是能保证匿名安全的生产级通信工具

---

## 8. 用一句更“技术负责人视角”的话总结

Shadowbroker 的技术逻辑可以概括为：

> 以 FastAPI 为中枢，把大量公开情报源按快慢分层抓取并汇总进统一缓存，再由 Next.js 地图前端进行高密度可视化，同时叠加相关性引擎、Mesh/Wormhole 通信层和 Rust 隐私核心，形成一个“情报采集 + 关联分析 + 地图展示 + 节点协作”的综合平台。

---

## 9. 对这个仓库的简短判断

这是一个“野心明显大于普通地图项目”的系统，重点不在页面，而在下面三件事：

1. 多源公开数据聚合
2. 跨域情报关联分析
3. 面向节点协作的实验性通信基础设施

如果后续要继续做，这个项目最值得关注的技术主线会是：

- 数据源稳定性和抓取质量
- 关联分析质量
- Mesh / Wormhole / privacy-core 的真正闭环
- 前端大地图在高密度数据下的性能控制

