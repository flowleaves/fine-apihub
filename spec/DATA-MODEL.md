# 数据模型

> SQLite 表结构、内存缓存形状、数据流规则与迁移约定。

## 1. SQLite 表结构

### `stations` — 中转站文档表

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `id` | `TEXT` | PRIMARY KEY | 站点唯一标识（如 `st_xxxxxx`） |
| `pos` | `INTEGER` | NOT NULL DEFAULT 0 | 数组插入顺序（前端排序用） |
| `doc` | `TEXT` | NOT NULL | 站点完整文档 JSON 字符串 |
| `created_at` | `TEXT` | DEFAULT CURRENT_TIMESTAMP | 创建时间（ISO 8601） |

**设计说明**：
- 整站文档以 JSON 形式存储，保持与 v1 数据形状 1:1，降低回归风险。
- `pos` 列保证 `ORDER BY pos, created_at` 的排序稳定性（纯 `created_at` 在批量迁移时同秒排序不确定）。
- 更新方式：`DELETE + INSERT`（事务内），或 `ON CONFLICT DO UPDATE SET`。

### `meta` — 键值元数据表

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `k` | `TEXT` | PRIMARY KEY | 键：`settings`、`auth`、`notifications`、`session_secret` |
| `v` | `TEXT` | NOT NULL | 值 JSON 字符串 |
| `updated_at` | `TEXT` | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

**设计说明**：
- SQLite 没有原生 JSON 列，以 TEXT 存储；读取时 `JSON.parse()`。
- `session_secret` 的值可能被 SQLite 以 JSON 字符串形式存储（带引号），读取时需做一次 `typeof v === "string" && v.startsWith('"') ? JSON.parse(v) : v` 的兼容处理。

### `usage_points` — 每日用量关系行（2026-09-17 新增）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `station_id` | `TEXT` | NOT NULL, PK(1) | 站点 id |
| `date` | `TEXT` | NOT NULL, PK(2) | 自然日 `YYYY-MM-DD`（按 `REPORT_TIME_ZONE` 切日） |
| `cost_usd` | `REAL` | NOT NULL DEFAULT 0 | 当天花费（美元，上游口径） |
| `tokens` | `REAL` | NOT NULL DEFAULT 0 | 当天 tokens |
| `requests` | `REAL` | NOT NULL DEFAULT 0 | 当天请求数 |
| `source` | `TEXT` | NOT NULL DEFAULT '' | 口径来源（如 `exact` / `hour` / `30d-or-provider-default`） |
| `updated_at` | `TEXT` | NOT NULL DEFAULT '' | 最近一次采样时间（ISO 8601） |

**设计说明**：
- **为什么落库**：上游用量接口保留期很短（实测 new-api 约 20 天、Sub2API 约 23~30 天），且 Sub2API 只返回「有数据」的日期；落库后历史不再受上游窗口限制，上游故障也能回看。
- **写入**：`server/refresh.js::sampleUsageIfDue()` 在每轮余额刷新后调用，**每站每小时最多 1 次**上游请求，只写「当天」这一行；`(station_id, date)` 复合主键 + upsert 保证幂等（当天累计值增长时覆盖）。
- **缺失语义**：某天没有行 = **未采样**（面板没开/上游查询失败），**不等于花费为 0**。响应里的 `note` 会如实说明。
- **保留**：`db/usage.js::USAGE_MAX_AGE_DAYS = 400` 天，每天最多裁剪一次。
- 索引：`idx_usage_date (date)`，供按区间读取。

### `history_points` — 余额历史关系行

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `station_id` | `TEXT` | NOT NULL, PK(1) | 站点 id |
| `t` | `INTEGER` | NOT NULL, PK(2) | 时间戳（毫秒） |
| `remaining` | `REAL` | NOT NULL | 剩余余额 |
| `used` | `REAL` | NOT NULL DEFAULT 0 | 已用余额 |

**设计说明**：
- 复合主键 `(station_id, t)` 天然提供「同站同秒不重复」的幂等性，等价于 MySQL 版的 `INSERT IGNORE`。
- 保留 30 天窗口：`DELETE FROM history_points WHERE t < ?`。
- 索引：`idx_history_t (t)`，供经营分析按时间范围聚合。

## 2. 内存缓存形状

### `rt.store.data`

```typescript
{
  stations: Station[],    // 见下方 Station 形状
  settings: Settings,     // 见下方 Settings 形状
  auth: Auth | null,      // 面板账号
  notifications: {
    channels: Channel[],
    rules: Rules,
  }
}
```

#### `Station`

```typescript
{
  id: string;              // st_ + 随机后缀
  name: string;
  type: "newapi" | "newapi-key" | "sub2api" | "sub2api-password" | "fixed";
  baseUrl: string;         // 站点地址
  accessToken: string;     // 访问令牌 / JWT
  userId: string;          // new-api 用户 ID
  apiKey: string;          // newapi-key 的 sk-xxx
  email: string;           // sub2api 邮箱
  password: string;        // sub2api 密码（明文存储！见安全说明）
  lowBalanceUsd: number | null;
  cnyPerUsd: number | null;     // 充值折算汇率
  costAliases: string[];        // 成本渠道别名
  includeInProfit: boolean;     // 默认 true
  isOwn: boolean;               // 是否「我的站点」（管理员分析用）
  noRenewal: boolean;           // 不再续费标记
  fixedPurchases: FixedPurchase[]; // 固定成本付费记录
  resoldAdminKeys: ResoldKey[];    // 转售管理员 Key
  createdAt: string;            // ISO 8601
  s2Tokens: S2Tokens | null;    // Sub2API 密码模式令牌缓存
  alertState: AlertState | null;
  balance: BalanceResult | null;
}
```

#### `Settings`

```typescript
{
  refreshIntervalSec: number;   // 默认 60；只用于「其它站点」（isOwn=false）的余额轮询
  ownRefreshIntervalSec: number; // 默认 3600；「我的站点」分析刷新节流（0 = 不节流）
  lowBalanceUsd: number;        // 默认 5
  dailyReport: {
    enabled: boolean;
    time: string;              // "HH:MM"
    channelIds: string[];
    lastSent: string | null;
  };
}
```

> `ownRefreshIntervalSec` 只影响 `ensureOwnFresh()`（由 `/api/own/*` 触发）的节流窗口；
> 后台定时轮询不再覆盖自有站，手动刷新与启动首刷始终是全量。

#### `Channel`

```typescript
{
  id: string;          // ch_ + 随机后缀
  type: string;        // "webhook" | "email" | "smtp" | ...
  name: string;
  enabled: boolean;
  config: Record<string, string>; // 渠道配置（含密钥）
  createdAt: string;
}
```

#### `Rules`

```typescript
{
  onLow: boolean;
  onExhaust: boolean;
  onError: boolean;
  onRecover: boolean;
  onEta: boolean;
  etaDays: number;          // 默认 3
  etaUnit: "days" | "hours";
  renotifyHours: number;    // 默认 24，0 = 只提醒一次
  errorThreshold: number;   // 默认 1
  errorRetrySec: number;    // 默认 30
  channelsFor: {            // 每类告警的推送渠道绑定
    low: string[];
    exhaust: string[];
    error: string[];
    recover: string[];
    eta: string[];
  };
}
```

### `rt.history.data`

```typescript
{
  [stationId: string]: [t: number, remaining: number, used: number][]
}
```

- 数组按 `t` 升序排列。
- 每站内存上限 `MAX_POINTS = 5000`（约 3.5 天 @ 60s 间隔）。
- 全局年龄上限 `MAX_AGE_MS = 30 天`。
- 相邻点最小间隔 `MIN_GAP_MS = 30 秒`。

## 3. 数据持久化规则

### Store 写透（`store.save()`）

```
调用 save()
  │
  ├──► 串行链：this._saveChain = this._saveChain.then(() => _writeNow())
  │      保证并行刷新不会并发写库
  │
  └──► _writeNow()
         │
         ├──► BEGIN TRANSACTION
         │
         ├──► DELETE FROM stations WHERE id NOT IN (...现存 id...)
         │
         ├──► FOR each station:
         │      INSERT INTO stations (id, pos, doc) VALUES (?, ?, ?)
         │      ON CONFLICT DO UPDATE SET pos = excluded.pos, doc = excluded.doc
         │
         ├──► FOR each meta key (settings, auth, notifications):
         │      INSERT INTO meta (k, v) VALUES (?, ?)
         │      ON CONFLICT DO UPDATE SET v = excluded.v
         │
         ├──► COMMIT
         │
         └──► 失败时 ROLLBACK，抛错
```

### History 写透（`history.scheduleSave()`）

```
append() 触发
  │
  ├──► 内存追加 point
  │
  ├──► _pending.push([stationId, t, remaining, used])
  │
  └──► setTimeout(1500ms)
         │
         ├──► DELETE FROM history_points WHERE station_id IN (_removed)
         │
         ├──► FOR each pending point:
         │      INSERT OR IGNORE INTO history_points (station_id, t, remaining, used)
         │      VALUES (?, ?, ?, ?)
         │
         ├──► DELETE FROM history_points WHERE t < (now - 30 days)
         │
         └──► 失败 → pending 放回队列，等下次重试
```

## 4. 数据迁移

### v1 → v2 迁移（db/migrate.js）

- **不在启动链中执行**：由部署入口显式调用（Docker CMD 链式 `node db/migrate.js` 或本地 `npm run db:migrate`）。
- **幂等**：库非空即跳过。
- **凭证安全**：migrate.js 引用 `stations.json` 等字面量会被 Next.js 构建追踪连真实凭证一起拷入 standalone 产物；因此启动时不自动执行。

### 运行时数据归一化（store.load()）

每次启动加载时自动执行，无需手动迁移：

| 版本 | 迁移逻辑 |
|------|---------|
| v2.0 → v2.1 | `noRenewal` 默认 `false`；旧站缺失该字段时补 false |
| v2.1 → v2.2 | `channelsFor` 归一化为 5 个事件键齐全的新对象 |
| 历代 | `fixedMonthlyCny` / `fixedCostCny` + `fixedDays` + `fixedStartDate` → `fixedPurchases` 数组 |
| 历代 | `costAliases` 字符串/数组归一化为去重字符串数组 |

## 5. 备份与恢复

### 一致性备份（`db/pool.js::backupTo()`，CLI：`npm run db:backup`）

```bash
npm run db:backup                      # → data/fine-apihub-backup-<时间戳>.db
npm run db:backup -- /backup/fine-apihub-20260914.db   # 指定目标
```

等价的编程调用：

```javascript
import { backupTo } from "./db/pool.js";
await backupTo("/backup/fine-apihub-20260914.db");
```

- WAL 模式下直接复制 `.db` 文件可能拿到不完整状态，必须使用 SQLite 官方 online backup API。
- 备份时读写可正常进行，不阻塞业务。`DB_DRIVER=mysql` 时该命令会拒绝执行（MySQL 请用 `mysqldump`）。

### 手动备份（文件级）

```bash
# 停止应用后复制（确保 WAL 已 checkpoint）
cp data/fine-apihub.db data/fine-apihub-backup.db
cp data/fine-apihub.db-wal data/fine-apihub-backup.db-wal  # 如有
```

## 6. 数据库文件

| 文件 | 说明 |
|------|------|
| `data/fine-apihub.db` | 主数据库文件 |
| `data/fine-apihub.db-wal` | WAL 日志（写前日志） |
| `data/fine-apihub.db-shm` | WAL 共享内存索引 |

**WAL 模式配置**（`db/pool.js::getDb()`）：

```sql
PRAGMA journal_mode = WAL;          -- 读写并行
PRAGMA busy_timeout = 5000;         -- 写锁竞争等待 5s
PRAGMA foreign_keys = ON;           -- 外键约束
PRAGMA synchronous = NORMAL;        -- 崩溃安全，性能优于 FULL
```

**`.gitignore`** 已排除 `*.db`、`*.db-wal`、`*.db-shm`，防止凭证数据库意外提交。
