# sologsb-1127 城市无障碍设施核验地图（gbaccessmap）

面向无障碍督导员与轮椅使用者代表，把坡道、盲道、无障碍电梯的点位、核验数据与通行路线集中到一张图上。

## 离线核验交接（下一轮分组进楼）

在原有单机地图之上，新增**区域领取仲裁 + 断网本机保存 + 按点位编号合并 + 字段冲突裁决**的完整交接链路：

1. **并发领取，一人成功**：两名督导员同时领取同一核验片区，服务端串行化仲裁，只有第一人成为接管人，第二人自动进入 FIFO 队列，返回结果里直接显示接管人是谁；接管人释放（或 5 分钟心跳过期）后队首自动接管。
2. **断网继续核验**：现场断网时点位、核验、整改结果照常录入，全部先进本机 IndexedDB 出站队列（`outbox` 表），顶栏显示「断网本机保存 / 待合并 N」，不丢数据。
3. **恢复后按点位编号合并**：网络恢复（每 30 秒自动尝试或在「现场交接」页手动触发）后，以「上次同步基线 / 现场值 / 总库值」做字段级三方合并，按点位编号（如 `WZ-2024-001`）归并两台设备各自登记的同一点位。
4. **同字段两边都改 → 双留标源**：同一字段两边都改过且取值不一致时，两个值都保留，分别标注督导员与时间，进入「待裁决冲突」清单；**裁决前该点位不进入总览统计与设施地图**（整改等子记录冲突会连点位一起屏蔽），裁决后立即恢复。
5. **旧数据照常展示**：没有区域编号（`areaCode`）的历史点位不做任何限制，正常上图与统计；首次同步会把本机全量数据作为基线引导上报，空总库不会清掉历史数据。

### 服务与端口

| 组件 | 技术 | 端口 | 说明 |
| --- | --- | --- | --- |
| `hub` | 零依赖 Node 20（node:http） | 21828（容器内） | 领取仲裁、三方合并、冲突裁决；数据原子写 JSON 文件 |
| `frontend` | nginx:alpine 托管 Vite 产物 | 宿主机 21827 | `/api` 反代到 `hub:21828` |

## 一键启动（Docker）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：<http://localhost:21827>（先在「现场交接」页选择督导员身份）

停止服务（镜像保留）：

```bash
docker compose down
```

### 不用 Docker 的本地开发

```bash
# 终端 1：同步服务（数据默认落 server/data/state.json）
npm start                 # 即 node server/index.js，端口 21828

# 终端 2：前端（vite 已把 /api 代理到 21828）
cd frontend && npm install && npm run dev
```

### 测试

```bash
npm test    # node --test，21 项：字段三方合并、领取 FIFO、同步冲突、HTTP 并发领取
```

## 技术栈

| 分层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 + @ant-design/icons |
| 构建 | Vite 6（`tsc -b && vite build`，构建含类型检查） |
| 状态管理 | Zustand 5（业务数据 store + UI 偏好 persist 到 localStorage） |
| 路由 | React Router 6（BrowserRouter，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`，留空时自动降级为本地 SVG 网格视图） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbaccessmap-db`）+ localStorage（表单草稿、UI 偏好、督导员身份） |
| 离线交接 | 零依赖 Node 20 `hub` 服务：领取 FIFO 仲裁、按点位编号字段级三方合并、冲突裁决 |
| 托管 | nginx:alpine（多阶段构建，`/api` 反代 hub） |

## 核心功能

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 核验总览：按行政区与设施类型汇总点位数、合格率、待整改数，点击统计块下钻清单；未裁决冲突点位自动排除并提示 | AccessPoint / Inspection / RectifyPlan |
| `/points/new` | 点位登记：地图打点或手填经纬度，可同时录入首次核验实测值，可选核验片区 | AccessPoint / Inspection |
| `/points/:id` | 点位详情：地图定位与属性、核验历史、就地新增核验、整改跟踪；存在未裁决冲突时顶部提示 | 四个模型 |
| `/routes` | 通行路线编制：选点自动串联路段，逐段填障碍数/台阶数/路缘高差，输出全线判定 | RouteSegment / AccessPoint |
| `/map` | 设施地图：按设施类型着色渲染点位，点选弹出核验摘要；未裁决点位不上图 | AccessPoint / Inspection |
| `/rectify` | 整改清单：按状态与期限分组、逾期置顶，登记复检结果 | RectifyPlan / AccessPoint |
| `/handoff` | **现场交接**：选择督导员身份、领取/排队片区（可见接管人）、查看断网与待合并状态、手动同步、逐条裁决字段冲突 | sync 层全部模型 |

## 数据模型（`src/types/` 独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| AccessPoint | `src/types/point.ts` | 点位编号、名称、设施类型、经纬度、行政区、所在道路或建筑、建成年代、养护单位 |
| Inspection | `src/types/inspection.ts` | 核验日期、核验人、坡度 %、净宽 cm、扶手、盲道连续性、占用情况、结论、问题描述 |
| RouteSegment | `src/types/route.ts` | 路线名称、起点/终点点位、长度、障碍数、台阶数、路缘高差、是否可轮椅通行 |
| RectifyPlan | `src/types/rectify.ts` | 点位 id、整改要求、责任单位、整改期限、复检日期、状态 |

## 数据存储

- **IndexedDB（Dexie，库名 `gbaccessmap-db`）**：业务数据。含版本号与升级迁移：
  - `v1` 建 `points` / `inspections` 表；
  - `v2` 增加 `routes` 表与 `pointId` 相关索引；
  - `v3` 增加 `rectifies` 表，并为历史「不合格」核验补建整改条目；
  - `v4` 离线交接：`points` 加 `areaCode` 索引，新增 `outbox`（本机出站队列）、`conflicts`（字段冲突）、`syncMeta`（clientId / 总库 rev / 上次同步时间 / 待上报裁决）、`shadows`（上次同步的影子基线，三方合并用）四张表。
- **同步服务总库（hub）**：`server/data/state.json`（docker 为 `hub-data` 命名卷），保存四类实体（含字段来源 `__mods`）、冲突、片区领取与队列；写入经单一 Promise 链串行化并原子落盘。
- **localStorage**：点位登记表单草稿（`gbaccessmap-draft:point-new`）、UI 偏好（`gbaccessmap-ui`）、当前督导员身份（`gbaccessmap-identity`）。
- 首次打开时自动写入一批示例数据，便于直接体验（其中两个点位带 `A-DC-01` 片区编号，其余留空）。
- 前端容器无状态；hub 的总库文件清空即重置演示（也可调 `POST /api/admin/reset`）。

## 高德地图 key

`VITE_AMAP_KEY` 留空（默认）时：`useAmapLoader()` 检测到 key 为空会**立即**返回降级标记，**不会**请求 `webapi.amap.com`；页面渲染可点选、可查看详情的本地 SVG 网格视图（`MapPanel`）。配置了 key 时脚本加载失败或超时同样自动降级，因此构建与运行都不依赖该 key。

## 目录结构

```
sologsb-1127/
├── docker-compose.yml          # hub（21828）+ frontend（宿主 21827）两个服务
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY / VITE_SYNC_BASE
├── package.json                # npm start / npm test（服务端零依赖）
├── README.md
├── shared/
│   ├── merge.js                # 字段级三方合并核心（服务端/测试共用，纯函数）
│   ├── merge.d.ts              # 合并层类型
│   └── areas.js                # 片区与督导员名册（服务端权威来源）
├── server/
│   ├── index.js                # node:http 入口（PORT / DATA_FILE 环境变量）
│   ├── http.js                 # 路由：/api/areas/* /api/sync /api/meta；同进程托管前端 dist
│   ├── claims.js               # 领取/排队/心跳/释放仲裁（FIFO + 5 分钟 TTL）
│   ├── sync.js                 # 按点位编号归并 + 字段三方合并 + 裁决落定
│   ├── store.js                # JSON 原子写持久化（写入串行化）
│   └── test/                   # node:test：合并 / 领取 / 同步 / HTTP 并发
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files + gzip + /api 反代 hub:21828
    ├── index.html
    ├── package.json
    ├── vite.config.ts          # /api 代理到 localhost:21828
    ├── tsconfig*.json
    ├── public/favicon.svg
    └── src/
        ├── types/{point,inspection,route,rectify,sync,areas}.ts
        ├── db/index.ts         # Dexie v4：业务表 + outbox/conflicts/syncMeta/shadows
        ├── sync/               # api / identity / outbox / engine / syncStore / labels
        ├── stores/{pointStore,routeStore,uiStore}.ts   # 写入同步入出站队列
        ├── hooks/{useConflictGate,useAmapLoader,useInspectionFilter,useLocalDraft}.ts
        ├── components/common/{MapPanel,StatusBadge,FacilityIcon,MeasureInput,EmptyState}.tsx
        ├── pages/{Overview,PointNew,PointDetail,Routes,MapView,Rectify,Handoff}.tsx
        ├── layouts/AppLayout.tsx
        ├── router/index.tsx
        └── utils/{routeCheck,geo,format}.ts
```

## 判定阈值（`src/utils/routeCheck.ts`）

- 坡度：≤ 5% 合格，> 5% 限期整改，> 8% 不合格；
- 净宽：≥ 120cm 合格，< 120cm 限期整改，< 90cm 不合格；
- 路缘高差：≤ 3cm 可轮椅通行，> 6cm 判定不可通行；存在台阶需绕行或增设坡道。
