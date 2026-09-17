# 系统架构

> fine 分层架构与数据流说明。修改架构前请先更新本文档。

## 1. 总体分层

```
┌─────────────────────────────────────────────────────────────┐
│                        前端层 (Browser)                       │
│  Next.js App Router 页面 + React 19 + Ant Design Pro 6       │
│  Service Worker (public/sw.js) — 离线壳缓存                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      路由层 (Next.js API)                     │
│  App Router Route Handlers — 12 组端点（见 API.md）           │
│  认证中间件 withAuth → 会话 Cookie 校验 → 注入 rt              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     运行时单例 (Runtime)                      │
│  globalThis.__FA_RT = { pool, store, history, sessions,   │
│                            refreshAll, restartPolling }      │
│  初始化：instrumentation.ts → lib/runtime.js::getRuntime()   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│   Store (内存)   │ │  History (内存)  │ │   SessionManager    │
│  db/store.js     │ │  db/history.js   │ │   lib/auth.js       │
│  站点/设置/通知  │ │  余额历史快照    │ │   scrypt+HMAC Cookie│
│  写透 SQLite    │ │  攒批写透 SQLite │ │   登录限流          │
└─────────────────┘ └─────────────────┘ └─────────────────────┘
              │               │
              └───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    数据层 (SQLite / MySQL)                    │
│  db/pool.js — 驱动层：方言翻译 + 连接兼容                    │
│  默认 SQLite (node:sqlite)，可选 MySQL (mysql2)              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    上游适配层 (Providers)                     │
│  lib/providers.js — 5 种站点类型适配器                        │
│  newapi / newapi-key / sub2api / sub2api-password / fixed    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     上游中转站 API                             │
│  sub2api / new-api / one-api 家族部署实例                     │
└─────────────────────────────────────────────────────────────┘
```

## 2. 运行时生命周期

```
进程启动
  │
  ▼
instrumentation.ts (Next.js 显式注册)
  │
  ▼
lib/runtime.js::getRuntime()
  │
  ├──► 首次调用 → init()
  │      │
  │      ├──► db/pool.js::getPool() → 打开 SQLite (WAL) 或 MySQL 连接池
  │      │
  │      ├──► db/pool.js::ensureSchema() → 建表（幂等）
  │      │      stations  ── 站点文档（JSON）
  │      │      meta      ── 设置 / 认证 / 通知渠道（JSON）
  │      │      history_points ── 余额历史关系行
  │      │
  │      ├──► new Store(pool).load() → 载入 stations + meta → 内存缓存
  │      │      数据迁移（v1 JSON 文件 → SQLite）由 db/migrate.js 显式执行，
  │      │      不在启动链中（避免 Next.js 构建追踪把凭证拷入 standalone）
  │      │
  │      ├──► new History(pool).load() → 载入 30 天内 history_points → 内存缓存
  │      │
  │      ├──► loadSessionSecret() → 从 meta 读或生成 32B 随机 secret
  │      │
  │      ├──► 清理 stale demo 站（baseUrl 含 /mock）
  │      │
  │      ├──► import("../server/refresh.js") → refreshAll() + restartPolling()
  │      │
  │      └──► import("../server/report.js") → startReportScheduler()
  │
  └──► 后续调用 → 返回已缓存的 Promise/rt 对象
```

**关键设计**：
- `globalThis.__FA_RT` 缓存运行时，HMR/多次 import 不重复初始化。
- 初始化失败不缓存失败态 → 下次调用重试（如 MySQL 短暂不可用）。
- 生产环境初始化失败 → `process.exit(1)`，避免空状态覆盖凭证。

## 3. 刷新与告警流程

### 3.1 两档刷新（2026-09-17 起）

自有站（`isOwn`）是生产站，分析一次要打它 5+ 个接口，因此**按归属分档**：

| 档 | 范围 | 间隔 | 触发方式 |
|---|---|---|---|
| 常规轮询 | **其它站点**（`isOwn=false`） | `settings.refreshIntervalSec`（默认 60s，实配 600s） | `restartPolling` 定时器 → `refreshAll(rt, { scope: "others" })` |
| 自有站节流 | **我的站点**（`isOwn=true`） | `settings.ownRefreshIntervalSec`（默认 3600s；0 = 不节流） | `ensureOwnFresh(rt)`：由 `/api/own/analytics` 触发 —— 即「我的站点 / 经营分析」页面正在使用时 |
| 全量 | 全部 | — | 启动首刷（`lib/runtime.js`）、手动 `POST /api/refresh`、`PUT /api/settings`（均不受节流限制，并重置节流计时） |

- `stationsForScope(stations, "others" | "own" | "all")` 是唯一的筛选入口。
- 节流先占位 `rt._ownRefreshedAt` 再刷新，并发请求不会重复触发（`refreshStation` 的同站去重是第二层兜底）。
- ⚠️ **副作用**：自有站余额不再被后台常规轮询覆盖 → 它的**低余额/耗尽告警最长延迟一个节流周期**（默认 1 小时），且只有相关页面被打开时才会刷新。若需要自有站也参与常规告警，把 `ownRefreshIntervalSec` 设 0（并接受生产站负载），或改回把自有站并入常规档。

### 3.2 单站刷新流程

```
定时轮询 (restartPolling) / ensureOwnFresh / 手动
  │  间隔：settings.refreshIntervalSec（默认 60 秒）
  ▼
refreshAll(rt, { scope })
  │  scope: others | own | all —— 由 stationsForScope 过滤
  ├──► 对每个站点调用 refreshStation(rt, station)
  │      │
  │      ├──► 去重检查：rt._inflightRefresh Map 保证同站同时只有一个刷新在途
  │      │      （防止定时器/手动刷新/保存后刷新并发导致重复告警 + refresh_token 作废）
  │      │
  │      ├──► lib/providers.js::queryStation(station)
  │      │      │
  │      │      ├──► 按 type 路由到对应适配器
  │      │      │      newapi        → GET /api/user/self
  │      │      │      newapi-key    → GET /dashboard/billing/subscription + usage
  │      │      │      sub2api       → GET /api/v1/auth/me（JWT 模式）
  │      │      │      sub2api-password → 自动登录/刷新 → GET /api/v1/auth/me
  │      │      │
  │      │      └──► 统一返回 { ok, remaining, used, total, currency, account, raw }
  │      │
  │      ├──► 更新 station.balance（内存 + 后续 save() 写透）
  │      │
  │      ├──► 成功时 rt.history.append(station.id, remaining, used)
  │      │      内存追加 + 攒批 1.5s 后写透 SQLite（→ history_points）
  │      │
  │      ├──► sampleUsageIfDue(rt, station) → 写透 usage_points
  │      │      每站**每小时最多 1 次**上游用量请求（自带节流），只写「当天」一行（幂等 upsert）；
  │      │      失败只记录不写 0 —— 缺失=未采样，不等于没花钱
  │      │
  │      ├──► lib/alerts.js::evaluateStation() → 状态迁移 + 通知触发
  │      │      │
  │      │      ├──► stateOf() → ok / warn / danger / error
  │      │      ├──► errorCount 连续失败阈值
  │      │      ├──► 状态变化或 renotifyHours 到期 → 发通知
  │      │      └──► 预测 ETA 过近 → 独立耗尽预警
  │      │
  │      ├──► rt.store.save() → balance / s2Tokens / alertState 一并落盘
  │      │
  │      └──► scheduleErrorRetry() → 失败且未达阈值 → errorRetrySec 后快速重试
  │
  └──► 全部完成（Promise.all，彼此独立）
```

## 4. 数据流：内存缓存 vs 持久化

| 数据 | 内存缓存 | 持久化 | 写策略 |
|------|---------|--------|--------|
| stations（站点列表） | `rt.store.data.stations` | `stations` 表 | 串行 save()，事务写透 |
| settings / auth / notifications | `rt.store.data.{settings,auth,notifications}` | `meta` 表 | 随 stations 一起 save() |
| history_points（余额历史） | `rt.history.data` | `history_points` 表 | 攒批 1.5s 后写透 |
| sessions | `rt.sessions`（Secret + failures Map） | `meta.session_secret` | Secret 启动时加载/生成 |

**读写规则**：
- **读**：全部走内存（同步 getter），零延迟。
- **写**：经 `save()` 串行化写透 SQLite，避免并发写冲突。
- **历史**：`append()` 先写内存 → `scheduleSave()` 攒批 → 1.5s 后 INSERT OR IGNORE。

## 5. 模块职责矩阵

| 模块 | 职责 | 不可触碰的红线 |
|------|------|-------------|
| `db/pool.js` | 驱动抽象、方言翻译、建表 | 新 SQL 必须兼容 MySQL 语法（SQLite 侧翻译），或反向翻译 |
| `db/store.js` | 站点/设置/通知的内存缓存 + 写透 | `save()` 必须串行化；`_writeNow()` 用事务 |
| `db/history.js` | 余额历史内存缓存 + 攒批写透 | `MAX_POINTS` / `MAX_AGE_MS` 不可随意改 |
| `db/usage.js` | 每日用量落库（`usage_points`） | upsert 用 MySQL 写法由 `db/pool.js` 转写，不要改成 SQLite 专有语法 |
| `lib/runtime.js` | 运行时单例初始化 | 生产失败必须 `process.exit(1)` |
| `lib/providers.js` | 上游站点适配器 | `QUOTA_PER_UNIT = 500000` 是唯一换算常量 |
| `lib/alerts.js` | 告警状态迁移 + 通知触发 | 不靠定时轰炸，靠状态迁移 |
| `lib/forecast.js` | 消费预测（日级/小时级） | 四模型等权组合已回测定型，换模型需附数据 |
| `lib/auth.js` | 密码哈希 + 会话签名 + 限流 | scrypt 参数不可降 |
| `server/refresh.js` | 后台刷新循环（分档调度：`stationsForScope` / `ensureOwnFresh`） | `refreshStation` 去重必须保留；自有站节流不得被手动刷新绕过（手动必须仍是 all） |
| `server/report.js` | 日报调度 | 定时按北京时间触发 |

## 6. 前端架构

- **框架**：Next.js 16 App Router + React 19
- **UI 库**：Ant Design 6 + Pro Components
- **样式**：CSS Modules + 全局 CSS 变量（`global.css`）
- **状态管理**：无全局状态库，API 数据通过 SWR 风格自刷新（页面聚焦 + 轮询）
- **PWA**：Service Worker 缓存静态壳（`public/sw.js`），API 请求不走缓存

## 7. 部署模式

### SQLite 本地模式（默认）
```bash
DB_PATH=./data/fine-apihub.db npm start
# 单文件即全部状态，复制 .db 即可备份/迁移
```

### MySQL 模式（可选，向后兼容）
```bash
DB_DRIVER=mysql DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=...
npm start
```

### Docker Compose（SQLite）
```yaml
# deploy/docker-compose.yml
# 面板 8787 + watchtower 自动更新
# MySQL 外部实例、容器无状态（v2.3 后改为 SQLite 内置）
```
