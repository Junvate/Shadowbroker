const ZH_STATIC_DICTIONARY: Record<string, string> = {
  'WORLDVIEW // ORBITAL TRACKING': '全球态势 // 轨道追踪',
  'Advanced Geopolitical Risk Dashboard': '高级地缘风险仪表盘',
  'SYSTEM CONFIG': '系统配置',
  'SETTINGS & DATA SOURCES': '设置与数据源',
  'OPERATOR TOOLS': '操作员工具',
  LOCATE: '定位',
  'Enter coordinates (31.8, 34.8) or place name...': '输入坐标（31.8, 34.8）或地点名称...',
  Search: '搜索',
  Settings: '设置',
  Loading: '加载中',
  Close: '关闭',
  Save: '保存',
  Cancel: '取消',
  Apply: '应用',
  Reset: '重置',
  Open: '打开',
  News: '新闻',
  Markets: '市场',
  Predictions: '预测',
  Filter: '筛选',
  Map: '地图',
  Layers: '图层',
  'Data Layers': '数据图层',
  'Enable all layers': '开启全部图层',
  'Disable all layers': '关闭全部图层',
  Legend: '图例',
  Status: '状态',
  Refresh: '刷新',
  'Not Connected': '未连接',
  Connected: '已连接',
  Disconnect: '断开连接',
  Connect: '连接',
  'Live Data': '实时数据',
  'No data': '无数据',
  Dark: '深色',
  Light: '浅色',
  Theme: '主题',
  Language: '语言',
  Submit: '提交',
  Confirm: '确认',
  Back: '返回',
  Next: '下一步',
  Previous: '上一步',
  Welcome: '欢迎',
  'API Keys': 'API 密钥',
  'NEWS FEEDS': '新闻源',
  'Free Sources': '免费数据源',
  Minimize: '最小化',
  'Close (Esc)': '关闭（Esc）',
  'COMMAND LINE': '命令行',
  'MESH / RADIO': '网状网络 / 无线电',
  'GATES / COMMONS': '网关 / 公共域',
  'OPS / DOSSIER': '行动 / 档案',
  'ENTER WORMHOLE': '进入虫洞',
  'GENERATE PRIVATE KEY': '生成私钥',
  Bootstrap: '引导状态',
  'Last peer': '最近节点',
  CHAIN: '链状态',
  PEERS: '对等节点',
  'SYNC LOOP': '同步循环',
  'COMMERCIAL AVIATION': '商业航空',
  'PRIVATE / UNKNOWN AVIATION': '私人 / 未知航空',
  'MILITARY AVIATION': '军事航空',
  'TRACKED AIRCRAFT (ALERT)': '重点飞机（告警）',
  'POTUS FLEET': '总统机队',
  SPACE: '太空',
  HAZARDS: '风险',
  SIGINT: '信号情报',
  SATELLITES: '卫星',
  MARITIME: '海事',
  GEOPHYSICAL: '地球物理',
  WILDFIRES: '野火',
  'INCIDENTS & INTELLIGENCE': '事件与情报',
  'NEWS & OSINT': '新闻与开源情报',
  'GPS JAMMING / INTERFERENCE': 'GPS 干扰 / 压制',
  INFRASTRUCTURE: '基础设施',
  'SURVEILLANCE / CCTV': '监控 / CCTV',
  'SELECTION HUD': '选择 HUD',
  'SIGINT GRID': '信号情报网格',
  'ORACLE SERVICE': '预言机服务',
  OVERLAYS: '叠加层',
  'Airliner (dim cyan — baseline)': '客机（暗青色，基准）',
  'Turboprop (dim cyan)': '涡桨机（暗青色）',
  'Helicopter (dim cyan)': '直升机（暗青色）',
  'Grounded / Parked (grey)': '落地 / 停放（灰色）',
  'Private Flight — Airliner (purple)': '私人航班—客机（紫色）',
  'Private Flight — Turboprop': '私人航班—涡桨机',
  'Private Jet — Bizjet': '私人喷气机—公务机',
  'Private / Unknown — Helicopter': '私人 / 未知—直升机',
  'Military — Standard (amber)': '军事—标准（琥珀色）',
  'Fighter / Interceptor (amber)': '战斗机 / 截击机（琥珀色）',
  'Military — Helicopter (amber)': '军事—直升机（琥珀色）',
  'UAV / Drone (live ADS-B)': '无人机（实时 ADS-B）',
  'VIP / Celebrity / Bizjet (hot pink)': 'VIP / 名人 / 公务机（亮粉）',
  'Dictator / Oligarch (red)': '独裁者 / 寡头（红色）',
  'Government / Police / Customs (blue)': '政府 / 警务 / 海关（蓝色）',
  'Medical / Fire / Rescue (lime)': '医疗 / 消防 / 救援（亮绿）',
  'Military / Intelligence (yellow)': '军事 / 情报（黄色）',
  'PIA — Privacy / Stealth (black)': 'PIA—隐私 / 隐匿（黑色）',
  'Private Flights / Joe Cool (orange)': '私人航班 / 其他（橙色）',
  'Climate Crisis (white)': '气候危机（白色）',
  'Private Jets / Historic / Other (purple)': '私人喷气机 / 历史 / 其他（紫色）',
  'Air Force One / Two (gold ring)': '空军一号 / 二号（金色环）',
  'Marine One (gold ring + heli)': '海军陆战队一号（金环+直升机）',
  'Military Recon / SAR (red)': '军事侦察 / SAR（红色）',
  'Synthetic Aperture Radar (cyan)': '合成孔径雷达（青色）',
  'Signals Intelligence / ELINT (white)': '信号情报 / ELINT（白色）',
  'Navigation — GPS / GLONASS / BeiDou (blue)': '导航—GPS / GLONASS / 北斗（蓝色）',
  'Early Warning — Missile Detection (magenta)': '早期预警—导弹探测（洋红）',
  'Commercial Imaging (green)': '商业成像（绿色）',
  'Space Station — ISS / Tiangong (gold)': '空间站—ISS / 天宫（金色）',
  'Unclassified / Other (grey)': '未分类 / 其他（灰色）',
  'Cargo / Tanker (red)': '货船 / 油轮（红色）',
  'Military Vessel (amber)': '军舰（琥珀色）',
  'Cruise / Passenger / Yacht (white)': '邮轮 / 客轮 / 游艇（白色）',
  'Tracked Yacht (pink)': '重点游艇（粉色）',
  'Civilian / Unknown (blue)': '民用 / 未知（蓝色）',
  'Aircraft Carrier (orange)': '航空母舰（橙色）',
  'Ship Cluster (count inside)': '船舶聚类（显示数量）',
  'Earthquake (yellow blob, size = magnitude)': '地震（黄色斑点，大小=震级）',
  'Active wildfire / hotspot': '活跃野火 / 热点',
  'Fire cluster (grouped hotspots)': '火点聚类（分组热点）',
  'GDELT / LiveUA event (yellow)': 'GDELT / LiveUA 事件（黄色）',
  'Violent / Kinetic event (red)': '暴力 / 动能事件（红色）',
  'Threat Alert (news cluster)': '威胁告警（新闻聚类）',
  'Geolocated news alert box': '地理定位新闻告警框',
  'High severity (>75% aircraft degraded)': '高严重度（>75% 航空器受影响）',
  'Medium severity (50-75% degraded)': '中严重度（50-75% 受影响）',
  'Low severity (25-50% degraded)': '低严重度（25-50% 受影响）',
  'Data Center': '数据中心',
  'Internet Outage Zone (grey)': '网络中断区域（灰色）',
  'Individual CCTV camera (green dot)': '单个 CCTV 摄像头（绿色点）',
  'Camera cluster (count inside)': '摄像头聚类（显示数量）',
  'CCTV icon (detail view)': 'CCTV 图标（详情视图）',
  'Predictive vector (~5 min ahead)': '预测矢量（约提前 5 分钟）',
  'Proximity rings (10 / 50 / 100nm)': '距离圈（10 / 50 / 100 海里）',
  'Flight trail (position history)': '飞行轨迹（位置历史）',
  'Active route (origin → dest)': '活动航线（起点 → 终点）',
  'APRS-IS station (green, isnād 0.7)': 'APRS-IS 站点（绿色，可信度 0.7）',
  'Meshtastic node (green triangle, isnād 0.5)': 'Meshtastic 节点（绿三角，可信度 0.5）',
  'JS8Call station (amber, isnād 0.9)': 'JS8Call 站点（琥珀色，可信度 0.9）',
  'Oracle score badge (weighted risk)': '预言机评分徽章（加权风险）',
  'Prediction market consensus': '预测市场共识',
  'Sentiment: ▲ positive / ▼ negative / — neutral': '情绪：▲ 正向 / ▼ 负向 / — 中性',
  'Day / Night terminator': '昼夜分界线',
  'Ukraine frontline': '乌克兰前线',
  'GLOBAL THREAT INTERCEPT': '全球威胁拦截',
  INTEL: '情报',
  COORDINATES: '坐标',
  LOCATION: '位置',
  STYLE: '样式',
  SOLAR: '太阳活动',
  'Hover over map...': '悬停地图查看...',
  'RESTORE UI': '恢复界面',
  'SENTINEL HUB IMAGERY': 'Sentinel Hub 卫星影像',
  'AVAILABLE LAYERS': '可用图层',
  'USAGE LIMITS (FREE TIER)': '使用限制（免费层）',
  'HOW IT WORKS': '工作原理',
  'GOT IT': '知道了',
  'True Color': '真彩色',
  'False Color IR': '伪彩红外',
  'Moisture Index': '湿度指数',
  'Monthly budget': '每月预算',
  'Cost per tile': '单瓦片成本',
  '~Viewport loads/month': '每月视口加载量',
  'Empty tiles': '空瓦片',
  'FREE (no data = no charge)': '免费（无数据不计费）',
  'DISPLAY CONFIG': '显示配置',
  BLOOM: '泛光',
  ON: '开',
  OFF: '关',
  SHARPEN: '锐化',
  HUD: 'HUD',
  LAYOUT: '布局',
  Tactical: '战术',
  'CLEAR UI (TACTICAL MODE)': '清空界面（战术模式）',
  'SCANNER TRACKER': '扫描追踪器',
  RELEASE: '释放',
  'UNKNOWN SYSTEM': '未知系统',
  'AUTO SCAN': '自动扫描',
  'MAP LEGEND': '地图图例',
  'ICON REFERENCE KEY': '图标说明索引',
  'BACKEND OFFLINE — Cannot reach backend server. Check that the backend container is running and BACKEND_URL is correct.':
    '后端离线——无法连接后端服务。请检查后端容器是否运行，以及 BACKEND_URL 是否正确。',
  'Sentinel-2 revisits every ~5 days — not every location has data every day':
    'Sentinel-2 约每 5 天重访一次，并非每天每个地点都有数据。',
  'The date slider picks the end of a time window; zoomed out uses wider windows':
    '日期滑块选择时间窗口的结束点；缩小地图时会使用更宽时间窗。',
  'Black patches = no satellite pass on that date range (normal)':
    '黑色区域表示该时段无卫星过境（正常现象）。',
  'Best results at zoom 8-14 — closer = sharper imagery (10m resolution)':
    '缩放 8-14 级效果最佳；放大越近影像越清晰（10 米分辨率）。',
  'Cloud filter auto-skips tiles with > 30% cloud cover':
    '云量过滤会自动跳过云覆盖超过 30% 的瓦片。',
};

const ZH_PHRASE_GLOSSARY: Record<string, string> = {
  'TYPE TO POST · / FOR COMMANDS · CLEAR KEEPS YOUR GATE OPEN': '输入即可发言 · / 查看命令 · CLEAR 清空但保留网关',
  'ENTER TO EXECUTE · TYPE CLEAR TO WIPE OUTPUT': '回车执行 · 输入 CLEAR 清空输出',
  'OpenSky Network': 'OpenSky 网络',
  'AIS Stream': 'AIS 流',
  'ADS-B Exchange': 'ADS-B 交换',
  'USGS Earthquakes': 'USGS 地震',
  'Global seismic data': '全球地震数据',
  'Weather radar overlay': '天气雷达叠加',
  'Global conflict events': '全球冲突事件',
  'Radio scanner feeds': '无线电扫描源',
  'Defense stocks & oil': '国防股票与原油',
  'RSS Feeds': 'RSS 源',
  'Welcome to ShadowBroker': '欢迎使用 ShadowBroker',
  'PRIVATE / STRONG': '私密 / 强',
  'PRIVATE / TRANSITIONAL': '私密 / 过渡',
  'PUBLIC / DEGRADED': '公开 / 降级',
  'COMMAND LINE': '命令行',
  'MESH / RADIO': '网状网络 / 无线电',
  'MESH CHAT': '网状通信',
  INFONET: '内网',
  MESH: '网状',
  'DEAD DROP': '死信箱',
  CHANNEL: '频道',
  INBOX: '收件箱',
  'GATES / COMMONS': '网关 / 公共域',
  'OPS / DOSSIER': '行动 / 档案',
  'NEWS': '新闻',
  'FINANCE': '金融',
  'CONFLICT': '冲突',
  'POLITICS': '政治',
  'GLOBAL THREAT INTERCEPT': '全球威胁拦截',
  'MAP LEGEND': '地图图例',
  'ICON REFERENCE KEY': '图标说明索引',
  'DISPLAY CONFIG': '显示配置',
  'CLEAR UI (TACTICAL MODE)': '清空界面（战术模式）',
  'RESTORE UI': '恢复界面',
  'SCANNER TRACKER': '扫描追踪器',
  'BACKEND OFFLINE': '后端离线',
  'Cannot reach backend server': '无法连接后端服务',
  'Check that the backend container is running': '请检查后端容器是否运行',
  'SENTINEL HUB IMAGERY': 'Sentinel Hub 卫星影像',
  'AVAILABLE LAYERS': '可用图层',
  'USAGE LIMITS (FREE TIER)': '使用限制（免费层）',
  'HOW IT WORKS': '工作原理',
};

const ZH_WORD_GLOSSARY: Record<string, string> = {
  AIRCRAFT: '飞机',
  AVIATION: '航空',
  COMMERCIAL: '商业',
  PRIVATE: '私人',
  UNKNOWN: '未知',
  MILITARY: '军事',
  TRACKED: '重点跟踪',
  ALERT: '告警',
  SATELLITES: '卫星',
  MARITIME: '海事',
  GEOPHYSICAL: '地球物理',
  WILDFIRES: '野火',
  INCIDENTS: '事件',
  INTELLIGENCE: '情报',
  INFRASTRUCTURE: '基础设施',
  SURVEILLANCE: '监控',
  CCTV: '监控摄像',
  OVERLAYS: '叠加层',
  GRID: '网格',
  SERVICE: '服务',
  STATUS: '状态',
  PROFILE: '配置',
  SETTINGS: '设置',
  FILTER: '筛选',
  LAYERS: '图层',
  LEGEND: '图例',
  PREDICTIONS: '预测',
  MARKET: '市场',
  MARKETS: '市场',
  NEWS: '新闻',
  CONNECTED: '已连接',
  DISCONNECTED: '未连接',
  CONNECT: '连接',
  DISCONNECT: '断开',
  GLOBAL: '全球',
  THREAT: '威胁',
  INTERCEPT: '拦截',
  COORDINATES: '坐标',
  LOCATION: '位置',
  STYLE: '样式',
  SOLAR: '太阳活动',
  DISPLAY: '显示',
  CONFIG: '配置',
  BLOOM: '泛光',
  SHARPEN: '锐化',
  LAYOUT: '布局',
  TACTICAL: '战术',
  MODE: '模式',
  CLEAR: '清空',
  UI: '界面',
  RESTORE: '恢复',
  ICON: '图标',
  REFERENCE: '参考',
  KEY: '密钥',
  TRACKER: '追踪器',
  LIVE: '实时',
  RELEASE: '释放',
  SYSTEM: '系统',
  AVAILABLE: '可用',
  MONTHLY: '每月',
  BUDGET: '预算',
  COST: '成本',
  FREE: '免费',
  CLOUD: '云层',
  CAMERA: '摄像头',
  CLUSTER: '聚类',
  AIRPORT: '机场',
  DEPARTURE: '起飞',
  ARRIVAL: '到达',
  CATEGORY: '类别',
  COUNTRY: '国家',
  SEARCH: '搜索',
  REFRESH: '刷新',
  ENABLE: '启用',
  DISABLE: '禁用',
  ERROR: '错误',
  NETWORK: '网络',
  FETCHING: '获取中',
  LOADING: '加载中',
  CONNECTING: '连接中',
  FAILED: '失败',
  EXPIRED: '已过期',
  ADMIN: '管理员',
  SESSION: '会话',
  REQUIRED: '必需',
  INVALID: '无效',
  LOCAL: '本地',
  AGENT: '代理',
  STARTING: '启动中',
  ACTIVE: '活跃',
  IDLE: '空闲',
  CREDENTIALS: '凭据',
  SAVE: '保存',
  COPY: '复制',
  ENTER: '输入',
  HIDE: '隐藏',
  SHOW: '显示',
  MAP: '地图',
};

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function applyPhraseGlossary(input: string): string {
  let out = input;
  const entries = Object.entries(ZH_PHRASE_GLOSSARY).sort((a, b) => b[0].length - a[0].length);
  for (const [en, zh] of entries) {
    const re = new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, zh);
  }
  return out;
}

function applyWordGlossary(input: string): string {
  let out = input;
  const entries = Object.entries(ZH_WORD_GLOSSARY).sort((a, b) => b[0].length - a[0].length);
  for (const [en, zh] of entries) {
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, zh);
  }
  return out;
}

const EN_STATIC_DICTIONARY: Record<string, string> = {};
for (const [en, zh] of Object.entries(ZH_STATIC_DICTIONARY)) {
  if (!EN_STATIC_DICTIONARY[zh]) {
    EN_STATIC_DICTIONARY[zh] = en;
  }
}

const EN_PHRASE_GLOSSARY: Record<string, string> = {};
for (const [en, zh] of Object.entries(ZH_PHRASE_GLOSSARY)) {
  if (!EN_PHRASE_GLOSSARY[zh]) {
    EN_PHRASE_GLOSSARY[zh] = en;
  }
}

const EN_WORD_GLOSSARY: Record<string, string> = {};
for (const [en, zh] of Object.entries(ZH_WORD_GLOSSARY)) {
  if (!EN_WORD_GLOSSARY[zh]) {
    EN_WORD_GLOSSARY[zh] = en;
  }
}

function applyEnPhraseGlossary(input: string): string {
  let out = input;
  const entries = Object.entries(EN_PHRASE_GLOSSARY).sort((a, b) => b[0].length - a[0].length);
  for (const [zh, en] of entries) {
    const re = new RegExp(zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, en);
  }
  return out;
}

function applyEnWordGlossary(input: string): string {
  let out = input;
  const entries = Object.entries(EN_WORD_GLOSSARY).sort((a, b) => b[0].length - a[0].length);
  for (const [zh, en] of entries) {
    const re = new RegExp(zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, en);
  }
  return out;
}

export function lookupStaticEn(text: string): string | null {
  const key = normalizeSpaces(text);
  if (!key) return null;
  if (EN_STATIC_DICTIONARY[key]) return EN_STATIC_DICTIONARY[key];
  const phraseTranslated = applyEnPhraseGlossary(key);
  const wordTranslated = applyEnWordGlossary(phraseTranslated);
  if (wordTranslated !== key && /[A-Za-z]/.test(wordTranslated)) {
    return wordTranslated;
  }
  return null;
}

export function lookupStaticZh(text: string): string | null {
  const key = normalizeSpaces(text);
  if (!key) return null;
  if (ZH_STATIC_DICTIONARY[key]) return ZH_STATIC_DICTIONARY[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(ZH_STATIC_DICTIONARY)) {
    if (k.toLowerCase() === lower) return v;
  }
  const phraseTranslated = applyPhraseGlossary(key);
  const wordTranslated = applyWordGlossary(phraseTranslated);
  if (wordTranslated !== key && /[\u4e00-\u9fff]/.test(wordTranslated)) {
    return wordTranslated;
  }
  return null;
}

export function lookupStaticUiText(text: string, uiLanguage: 'zh' | 'en'): string | null {
  return uiLanguage === 'zh' ? lookupStaticZh(text) : lookupStaticEn(text);
}
