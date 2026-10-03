# sologsb-1127 城市无障碍设施核验地图（gbaccessmap）

面向无障碍督导员与轮椅使用者代表，把坡道、盲道、无障碍电梯的点位、核验数据与通行路线集中到一张图上。

新增**离线核验交接**：老城区督导队分组进楼前认领区域（同一区域只能一人接管，其余排队并看到接管人）；现场断网改动保存在本机，网络恢复后按点位编号合并；同一字段两边都改过则两份都保留并标出来源，裁决前不进总览和地图；没有区域编号的旧数据照常展示。

## 一键启动（Docker）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：<http://localhost:21827>（前端 nginx 把 `/api` 反代到交接服务 `server:4021`，该服务不对外暴露端口）

停止服务（镜像保留）：

```bash
docker compose down
```

## 本地开发

```bash
# 终端 1：交接服务端（端口 4021，数据写在 server/data/db.json）
npm install --prefix server && npm run dev --prefix server

# 终端 2：前端（端口 21827，vite 已把 /api 代理到 4021）
npm install --prefix frontend && npm run dev --prefix frontend
```

## 测试

```bash
npm test --prefix server          # 服务端：并发认领 / 三路合并 / 冲突裁决 / 旧数据兼容
npm run test:sync --prefix frontend  # 前端同步引擎冒烟（需先启动服务端）
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
| 交接服务端 | Node 20 + Express 4，内存态 + JSON 文件原子写穿（`DATA_FILE`） |
| 托管 | nginx:alpine（多阶段构建，反代 `/api`） |

## 核心功能

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 核验总览：按行政区与设施类型汇总点位数、合格率、待整改数，点击统计块下钻清单；未裁决冲突点位不进入统计 | AccessPoint / Inspection / RectifyPlan |
| `/points/new` | 点位登记：地图打点或手填经纬度，可同时录入首次核验实测值；区域编号选填（旧数据可不分区） | AccessPoint / Inspection |
| `/points/:id` | 点位详情：地图定位与属性（含区域编号）、核验历史、就地新增核验、整改跟踪；待裁决点位有标识 | 四个模型 |
| `/routes` | 通行路线编制：选点自动串联路段，逐段填障碍数/台阶数/路缘高差，输出全线判定 | RouteSegment / AccessPoint |
| `/map` | 设施地图：按设施类型着色渲染点位，点选弹出核验摘要；未裁决冲突点位不上图 | AccessPoint / Inspection |
| `/rectify` | 整改清单：按状态与期限分组、逾期置顶，登记复检结果 | RectifyPlan / AccessPoint |
| `/handover` | 离线核验交接：区域认领（接管人/排队）、离线同步（待同步计数/一键合并）、冲突裁决（双份值标来源） | Region / ConflictRecord / SyncChange |

## 离线核验交接设计

### 区域认领（并发安全）

- 服务端内存态保存每个区域的 `holder` 与 `queue`，认领的「检查占位 → 写入」在同一段同步代码内完成，Node 单线程保证两人并发认领同一区域**只有一人成功**；
- 未抢到的人自动进入排队，响应与区域列表都返回当前**接管人**，排队者能看到自己排第几位；
- 接管人释放后，队首自动成为新接管人；排队者可随时退出排队。

### 断网改动留本机

- Dexie v4 新增 `syncBase`（最后一次从服务端拉到的实体快照）与 `syncDirty`（本机未同步改动 + 改动前的值 `base`）两张表；
- 点位/核验/整改的每次本机增改都会写脏标记，断网期间数据只留在本机 IndexedDB；
- 网络恢复（`online` 事件）或点「立即同步」时推送：脏数据按 `create`/`update` 上报，从未同步过的本地数据按 `bootstrap`（只补缺、不覆盖、不产生冲突）上报。

### 按点位编号三路合并

- 点位以**点位编号 code** 为合并键（各机内部 id 不一致时以服务端记录为准，本机 id 与引用自动改挂）；核验、整改按客户端唯一 id 合并；
- 字段级三路合并（`base` = 本机改动前最后一次见到的服务端值）：仅本机改过 → 采用本机值；仅服务端改过 → 保留服务端；两边都改成一样 → 无需处理；
- **同一字段两边都改过且不一致** → 生成冲突记录：服务端值与本机上报值**两份都保留**，各自标注来源（督导员 + 时间）。

### 裁决前不进总览和地图

- 有未裁决冲突的点位被标记 `conflictPending`，总览统计与设施地图（前端过滤 + 服务端 `/api/overview` 同样排除）都不包含它；
- 在 `/handover` 的「冲突裁决」页签选择「保留服务端」或「采用上报值」后，点位自动恢复进入总览和地图。

### 旧数据兼容

- `regionNo`（区域编号）全程可选：旧数据没有区域编号照常进总览、地图与合并；`''` 与缺失视为等同，不会误判冲突。

## 交接 API（`/api`，均走同源反代）

| 方法/路径 | 说明 |
| --- | --- |
| `GET /regions` | 区域列表（含接管人与排队） |
| `POST /regions/:regionNo/claim` | 认领：成功 `claimed`；已被接管则 `queued` 并返回接管人与排位 |
| `POST /regions/:regionNo/release` | 仅接管人可释放，队首自动接管 |
| `POST /regions/:regionNo/leave` | 退出排队 |
| `POST /sync/push` | 推送本机改动（`changes[]`，含 `base`/`data`），返回合并结果与冲突 |
| `GET /sync/pull` | 全量拉取合并后的点位/核验/整改/区域/冲突 |
| `GET /conflicts?status=pending` | 冲突列表 |
| `POST /conflicts/:id/resolve` | 裁决：`choice=server` 保留服务端，`choice=local` 采用上报值 |
| `GET /overview` | 合并后总览统计（排除未裁决冲突点位） |

## 数据模型（`src/types/` 独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| AccessPoint | `src/types/point.ts` | 点位编号、名称、设施类型、经纬度、行政区、所在道路或建筑、建成年代、养护单位、区域编号（可选）、conflictPending |
| Inspection | `src/types/inspection.ts` | 核验日期、核验人、坡度 %、净宽 cm、扶手、盲道连续性、占用情况、结论、问题描述 |
| RouteSegment | `src/types/route.ts` | 路线名称、起点/终点点位、长度、障碍数、台阶数、路缘高差、是否可轮椅通行 |
| RectifyPlan | `src/types/rectify.ts` | 点位 id、整改要求、责任单位、整改期限、复检日期、状态 |
| Region / ConflictRecord / SyncChange | `src/types/handover.ts` | 接管人、排队、冲突双份值与来源、三路合并改动 |

## 数据存储

- **IndexedDB（Dexie，库名 `gbaccessmap-db`）**：业务数据。含版本号与升级迁移：
  - `v1` 建 `points` / `inspections` 表；
  - `v2` 增加 `routes` 表与 `pointId` 相关索引；
  - `v3` 增加 `rectifies` 表，并为历史「不合格」核验补建整改条目；
  - `v4` 增加 `syncBase` / `syncDirty` 两张离线交接表。
- **localStorage**：点位登记表单草稿（`gbaccessmap-draft:point-new`）、UI 偏好（`gbaccessmap-ui`）、本机督导员身份（`gbaccessmap-user`）。
- **服务端**：内存态 + JSON 文件原子写穿（默认 `server/data/db.json`，容器内 `/app/data/db.json`）。容器无状态、不挂载命名卷，重建即重置合并数据；清空浏览器存储即可重置本机数据。
- 首次打开时自动写入一批示例数据，便于直接体验。

## 高德地图 key

`VITE_AMAP_KEY` 留空（默认）时：`useAmapLoader()` 检测到 key 为空会**立即**返回降级标记，**不会**请求 `webapi.amap.com`；页面渲染可点选、可查看详情的本地 SVG 网格视图（`MapPanel`）。配置了 key 时脚本加载失败或超时同样自动降级，因此构建与运行都不依赖该 key。

## 目录结构

```
sologsb-1127/
├── docker-compose.yml          # 顶层 name: gbaccessmap，server + frontend 两服务
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── README.md
├── server/
│   ├── Dockerfile              # node:20-alpine，端口 4021
│   ├── package.json
│   ├── src/{index,app,store,merge}.js   # 认领 / 合并 / 裁决 API + 三路合并引擎
│   └── test/handover.test.js            # node:test：并发认领、冲突、裁决、旧数据
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files + gzip + /api 反代 server:4021
    ├── index.html
    ├── package.json
    ├── vite.config.ts          # dev 代理 /api → localhost:4021
    ├── tsconfig*.json
    ├── public/favicon.svg
    ├── scripts/sync-smoke.ts   # 同步引擎冒烟（fake-indexeddb + 真实服务端）
    └── src/
        ├── types/{point,inspection,route,rectify,handover}.ts
        ├── api/client.ts                     # 同源 /api 封装
        ├── db/index.ts                       # Dexie 封装 + 版本迁移 + 示例数据 + markDirty
        ├── sync/engine.ts                    # 离线同步引擎（bootstrap/三路合并推送/拉回）
        ├── stores/{pointStore,routeStore,uiStore,handoverStore}.ts
        ├── components/common/{MapPanel,StatusBadge,FacilityIcon,MeasureInput,EmptyState}.tsx
        ├── hooks/{useAmapLoader,useInspectionFilter,useLocalDraft}.ts
        ├── pages/{Overview,PointNew,PointDetail,Routes,MapView,Rectify,Handover}.tsx
        ├── layouts/AppLayout.tsx
        ├── router/index.tsx
        └── utils/{routeCheck,geo,format}.ts
```

## 判定阈值（`src/utils/routeCheck.ts`）

- 坡度：≤ 5% 合格，> 5% 限期整改，> 8% 不合格；
- 净宽：≥ 120cm 合格，< 120cm 限期整改，< 90cm 不合格；
- 路缘高差：≤ 3cm 可轮椅通行，> 6cm 判定不可通行；存在台阶需绕行或增设坡道。
