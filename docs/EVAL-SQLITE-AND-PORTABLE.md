# 技术评估：SQLite 改造 & Windows 本地运行 / 便携化

> 评估对象：`relay-monitor` v2.2.0（当前的 MySQL 版）
> 评估日期：2026-09-14
> 结论性质：可行性 + 复杂度评估，**未做任何代码改动**

---

## 一、先给结论

| 需求 | 可行性 | 复杂度 | 建议 |
|---|---|---|---|
| 改 SQLite（`.db` 文件随项目本地） | **高度可行** | 中（约 3–5 天） | 推荐，但要挑对驱动、并正视一个真难点 |
| Windows 本地运行 | **完全可行** | 低（半天） | 推荐，两种路径见 §4 |
| 打包便携版（可复制数据库文件） | **可行，但不是「单文件 exe」** | 中 | 用「免安装 Node + 目录」而非 pkg/SEA，见 §5 |

**一句话**：这个项目改 SQLite 的技术障碍比想象中小得多——因为它的持久层写得非常克制（全局只有 18 条 SQL，集中在 5 个文件，且核心设计是「内存缓存 + 写透」）。真正的难点只有 **一处**：经营分析页用了 MySQL 的 `LAG()` 窗口函数，SQLite 要在 Node 侧重写这段逻辑。

---

## 二、现状盘点：持久层到底耦合多深

改造可行性取决于「SQL 散落程度」，所以我做了一次全量扫描，而不是抽样。

### 2.1 数据库访问点全清单

| 文件 | 行数 | SQL 条数 | 主要操作 |
|---|---|---|---|
| `db/pool.js` | 45 | 3 | 建表（`stations` / `meta` / `history_points`） |
| `db/store.js` | 401 | 5 | 站点文档 + 元数据读写、事务、upsert |
| `db/history.js` | 202 | 4 | 历史点批量插入、裁剪、删除 |
| `db/migrate.js` | 88 | 5 | v1 JSON 一次性导入 |
| `lib/runtime.js` | 74 | 2 | 会话密钥读写 |
| `app/api/analytics/route.js` | 145 | 2 | **经营分析聚合（唯一复杂 SQL）** |
| **合计** | **955** | **约 18** | |

**这 18 条 SQL 就是全部**。`server/` 目录（刷新循环、日报、演示站）**完全不含 SQL**——它们只调用 `rt.store` / `rt.history` 的方法。这是迁移成本低的关键原因。

### 2.2 一个决定性的好设计

`db/store.js` 的注释写得很清楚：

> 内存缓存 `this.data` 保持 v1 数据形状，所有读走内存（同步 getter 不变），所有写通过 `save()` 串行化写透 MySQL——消费方（26 个端点/告警/日报）零改动。

这意味着**上层业务逻辑完全不认识数据库**。换成 SQLite，改的是「怎么写透」，不是「业务怎么跑」。这是 v2 作者为「存储可替换」留下的最佳伏笔。

同理 `db/history.js` 的 `usedSince` / `burnRate` / `predict` **全部读内存**，只有 `load` / `scheduleSave` 碰数据库。

---

## 三、SQLite 改造：逐项拆解

### 3.1 驱动选型（关键决策，直接影响复杂度）

| 方案 | 原生编译 | 打包便携性 | 评价 |
|---|---|---|---|
| **`node:sqlite`（Node 内置）** | 不需要 | 极佳 | **本项目首选**。Node 22.10+ 内置，零依赖 |
| `better-sqlite3` | 需要（prebuild 可省） | 中（native 模块随平台绑定） | 生态成熟，但便携分发要处理 node-gyp |
| `node-sqlite3-wasm` | 不需要 | 佳 | 无依赖纯 WASM，但性能与 API 完整度稍逊 |
| `sql.js` | 不需要 | 佳 | 整库载入内存，**不适合本项目**（有持续写入） |

**已实地验证**：本机 Node v22.22.2 上 `require("node:sqlite")` 返回 `DatabaseSync, StatementSync, constants, backup` —— 完整可用，且 **`backup` API 存在**，可以直接实现「一键备份/复制数据库文件」。唯一代价是启动时有一条 `ExperimentalWarning`（可静默，见 §3.5）。

> 选 `node:sqlite` 的最大好处：**便携版不用带任何原生模块**，`.db` 文件即全部状态。

### 3.2 需要改的 SQL 方言（约 18 条，实际改动量小）

| 现状（MySQL） | SQLite 写法 | 出现位置 |
|---|---|---|
| `?` 占位符 | 同 `?` | 全部——**无需改** |
| `INSERT ... VALUES ?`（批量） | 逐行 prepared statement 或 `INSERT ... VALUES (?,?),...` | store / history / migrate |
| `ON DUPLICATE KEY UPDATE` | `ON CONFLICT(...) DO UPDATE SET` | store.js:160, 172 |
| `INSERT IGNORE` | `INSERT OR IGNORE` | history.js:53, migrate.js:61 |
| `DELETE ... WHERE id NOT IN (?)` | `WHERE id NOT IN (${占位符})` | store.js:157 |
| `JSON` 列类型 | `TEXT`（本就在 Node 侧 `JSON.stringify`/`parse`） | pool.js |
| `DOUBLE` | `REAL` | pool.js |
| `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` | 去掉（SQLite 无此概念） | pool.js |
| `pool.getConnection()` + 事务 | `db.exec("BEGIN")` / `COMMIT` / `ROLLBACK` | store.js:152, migrate.js:24 |
| `pool.end()` | `db.close()` | migrate.js:87 |
| `[rows]` 解构（mysql2 返回 `[rows, fields]`） | `stmt.all()` / `stmt.get()` 直接返回数组 | 全部读取点 |

**占位符不用改**——mysql2 和 `node:sqlite` 都用 `?`。这是省下来的大头。

### 3.3 ⚠️ 唯一真难点：`LAG()` 窗口函数

`app/api/analytics/route.js` 的两条查询用了 `LAG(remaining) OVER (PARTITION BY station_id ORDER BY t)`，用来取「同站上一快照余额」，再算 `prev - remaining` 得到扣费。

- **SQLite 3.25+（2018 年起）也支持窗口函数**，所以 `LAG` 语法本身大概率能直接跑。
- 但有两个连带问题：
  1. **`FROM_UNIXTIME` / `DATE_FORMAT` / `WEEKDAY` / `HOUR` 是 MySQL 专有函数**，SQLite 没有。要换成 `strftime('%Y-%m-%d', t/1000, 'unixepoch', 'localtime')` 这类写法。
  2. **时区语义变了**。现在 SQL 走的是 MySQL 会话时区（`FROM_UNIXTIME` 解释为服务器本地时区），注释里明说「与面板同机部署时即本地时区」。SQLite 的 `'localtime'` 修饰符读的是**进程的 TZ**，行为类似但边界不同，需要重新验证。

**建议做法（而不是硬啃 SQL）**：这两条查询的数据源是 `history_points` 全表（30 天内每站最多 5000 点，量级很小），而 `history.js` **已经把全量数据加载在内存里了**。所以最干净的方案是——**把 `LAG` + 分桶聚合搬到 Node 侧**，用已有的内存数组算，顺带彻底消除时区函数差异：

```js
// 伪代码：替代 DROPS_SQL + GROUP BY DATE_FORMAT
for (const [stationId, points] of Object.entries(history.data)) {
  for (let i = 1; i < points.length; i++) {
    const drop = points[i-1][1] - points[i][1];
    if (drop > 0) dailyBucket(dayKeyInTz(points[i][0]), stationId).add(drop);
  }
}
```

- **优点**：一次解决窗口函数 + 时区 + 方言三个问题；口径与 `History.usedSince` 天然一致（现在这两处是「手工保持一致」，容易漂移）；顺带干掉两条 SQL。
- **代价**：失去「SQL 聚合」这个原本的卖点（README 提到「供经营分析 SQL 聚合」）。但 5000 点 × 站点数的量级，Node 侧遍历是微秒级，**性能根本不是问题**。
- **风险**：必须写测试锁死新旧口径一致，否则经营分析页的数字会悄悄变。

### 3.4 事务与并发

- `node:sqlite` 的 `DatabaseSync` 是**同步 API**，天然串行，省掉了 mysql2 的连接池与 `getConnection()`/`release()` 配对。
- 但**要开 WAL 模式**：`PRAGMA journal_mode = WAL;` + `PRAGMA busy_timeout = 5000;`。原因：后台刷新循环（60s 一拍）与 API 请求会并发写同一个库文件，WAL 才能读写不互斥。
- `Store.save()` 的现有串行化链（`this._saveChain`）可以原样保留，逻辑不变。
- **不需要连接池**——这是简化，不是损失。

### 3.5 其他注意点

| 事项 | 说明 |
|---|---|
| `ExperimentalWarning` | `node:sqlite` 会打印实验性警告。可用 `--no-warnings` 或 `NODE_OPTIONS` 静默。**长期风险：API 在 Node 主版本间可能微调** |
| `db/migrate.js` 独立运行 | 现在靠 `process.loadEnvFile`，SQLite 版可以简化：库文件路径从常量/环境变量取 |
| 文件追踪排除 | `next.config.mjs` 要新增 `outputFileTracingExcludes` 排除 `*.db`，否则**凭证数据库会进构建产物**（沿用现在排除 `data/**` 的思路） |
| `.gitignore` | 新增 `*.db` / `*.db-wal` / `*.db-shm` |
| `serverExternalPackages` | 若用 `node:sqlite` 则**无需**加（内置模块）；若用 `better-sqlite3` 则必须加 |
| Dockerfile | 可大幅简化（不需要外部 MySQL），但 `node:alpine` 对 `node:sqlite` 的支持需验证 |

### 3.6 测试改造

现有 4 个测试文件，其中 **只有 `db/store.test.js` 依赖数据库抽象**，它用的是 `fakePool`（内存假对象），断言的是「SQL 以某字符串开头」：

```js
if (sql.startsWith("SELECT id, doc FROM stations")) { ... }
```

- 改成 SQLite 后，这段 fake 要重写。**好消息**：用 `node:sqlite` 的 `:memory:` 库可以直接做**真数据库测试**，比 fakePool 更可靠。
- 其余 3 个测试（alerts / providers / own-helpers）**纯逻辑，零改动**。
- 建议补的测试：
  - 新旧口径一致性（§3.3 的内存聚合 vs 原 SQL）
  - 写透链路：`append()` → `scheduleSave()` → 重开 `load()` 数据一致
  - WAL 并发：刷新的同时读

### 3.7 改造工作量估算

| 模块 | 改动 | 风险 |
|---|---|---|
| 新增 `db/pool.js`（SQLite 版） | 全重写，约 60–80 行 | 低 |
| `db/store.js` | 方言改写 + 去掉连接池，约 40 行 | 低 |
| `db/history.js` | 方言改写，约 25 行 | 低 |
| `db/migrate.js` | 简化，约 30 行 | 低 |
| `lib/runtime.js` | 会话密钥两行，约 3 行 | 极低 |
| `app/api/analytics/route.js` | **逻辑重写**，约 85 行 | **中高** |
| 测试 | `store.test.js` 重写 + 补 2–3 个 | 中 |
| 构建/打包配置 | next.config / gitignore / Dockerfile | 低 |

**合计约 250–300 行改动，3–5 个工作日**（含验证）。其中 §3.3 的 analytics 占一半风险。

### 3.8 是否保留 MySQL 双后端？

值得考虑，但**不建议一上来就做**：

- **好处**：老部署（Docker + MySQL）不用迁移；用户可选。
- **代价**：`Store` / `History` 要抽象出一个接口层，方言分叉，**测试矩阵翻倍**（每种场景跑两遍）。而这个项目现在的测试覆盖本来就不算厚。
- **建议**：先做纯 SQLite 版（可用 `DB_DRIVER=sqlite|mysql` 做最小分叉，只分叉 `db/pool.js` 的驱动层，SQL 用一套兼容子集）。跑稳一个发布周期后，再决定要不要把 MySQL 捡回来。

---

## 四、Windows 本地运行可行性

**完全可行。** 但先说明一个前置事实：当前仓库**没有 `node_modules` 也没有 `.next`**（未安装依赖、未构建），所以第一次跑需要先 `npm install`。

### 路径 1：保持 MySQL（改动为零）—— 推荐先走这条

1. 装 MySQL 8（或下载 MySQL 的 **ZIP noinstall 免安装版**，解压即用）
2. `cp .env.example .env.local`，填 `DB_*`
3. `npm install && npm run db:migrate && npm run build && npm start`
4. 打开 `http://127.0.0.1:3000`，`admin / admin123`

**优点**：零代码改动、零风险、当天可用。
**缺点**：目标机器要有 MySQL 进程。

### 路径 2：改 SQLite 后的本地运行

```
npm install
npm run db:migrate      # 建 .db 文件
npm run build && npm start
```

数据库就是项目目录下的 `relay-monitor.db`（甚至可以直接放 `data/` 里，与 v1 的约定一致）。

**Windows 特有注意事项**：

| 事项 | 说明 |
|---|---|
| 时区 | `TZ` 环境变量在 Windows 上**不生效**（Node 的 `Intl` 走系统时区）。日报的 `REPORT_TIME_ZONE` 是显式传入的，没问题；但 `analytics` 路由原本依赖 MySQL 会话时区，迁移时要改用显式时区计算 |
| 路径分隔符 | SQLite 文件路径用 `node:path` 拼接，避免手写 `\` |
| 长路径 | 项目路径已较深（`C:\Users\fine\Desktop\xingya\relay-monitor`），`next build` 一般没问题，但注意 Windows 260 字符限制 |
| 后台常驻 | 现在靠 `instrumentation.ts` 的 `register()` 启动刷新循环。**本地要「关掉窗口就停」，需确认 Next standalone 下这块确实跑起来了**——这是本项目最该实测的一环 |
| 开机自启 | 用「任务计划程序」或 `nssm` 注册成服务；不像 Docker 有 `restart: unless-stopped` |

> ⚠️ **务必实测的一条**：`instrumentation.ts` 只在 `NEXT_RUNTIME === "nodejs"` 时执行，且在 `next dev` 与 `node server.js`（standalone）两种模式下的加载时机不同。本地跑起来后，**要看日志确认「中转站余额监控面板 v2 已就绪」这行打印出来**，否则面板能打开但永远不刷新、不发告警。这类「编译通过但启动装配路径没跑」的问题，本项目在别的组件上已经吃过一次亏。

---

## 五、便携化打包：可行，但不是「单文件 exe」

### 5.1 为什么不要做单文件 exe

| 方案 | 问题 |
|---|---|
| `pkg` / `nexe` | 已停止维护或不支持 Node 22+；Next standalone 的动态 `import()` 与文件系统路径依赖会直接崩 |
| Node SEA（Single Executable） | 只支持 CJS 单入口；Next 的 server bundle 是 ESM + 动态 require，且要读 `.next/static` 真实文件 |
| Electron | 面板是 Web 应用，套壳纯属浪费（200MB+ 换一个本不需要的浏览器） |

**Next.js 应用的本质是「一个目录 + 一个 Node 进程」**，硬压成单文件是逆着框架设计走。

### 5.2 推荐的便携版形态：「绿色目录包」

```
relay-monitor-portable/
├── node/                    ← 官方 Node Windows 免安装 ZIP（约 30MB）
│   └── node.exe
├── app/                     ← next build 产物（.next/standalone + static + public）
├── data/
│   └── relay-monitor.db     ← 全部状态：凭证 + 历史 + 设置 + 会话密钥
├── 启动.bat                 ← set TZ 后 node app/server.js
├── 停止.bat
└── 备份.bat                 ← 复制 data/relay-monitor.db 到带时间戳的文件
```

**为什么这条路可行**：

- 选了 `node:sqlite` → **没有任何原生模块**，不需要 node-gyp、不需要按平台编译。
- 数据库是**单个文件** → 「复制数据库文件」就是字面意义的复制，直接满足需求。
- Node 官方提供 Windows ZIP 免安装包 → 目标机器不需要装 Node。
- 整个目录拷到 U 盘/另一台机器，双击 `启动.bat` 就能跑。

**工作量**：主要时间花在写 `.bat`、验证 `.next/standalone` 下 `instrumentation.ts` 生效、以及首次启动的库初始化。属于「打包脚本 + 实测」，不是架构改造。

### 5.3 备份/迁移能力（顺手可做）

`node:sqlite` 提供了 `backup()` API，可以在面板里加一个「立即备份」按钮，或写成定时任务：

```js
import { backup } from "node:sqlite";
await backup(db, `data/backup-${Date.now()}.db`);
```

比 `fs.copyFile` 更安全——**WAL 模式下直接拷 `.db` 文件可能拷到不完整状态**，`backup()` 保证一致性快照。这一点很重要，如果做「复制数据库文件」的功能，**务必用 `backup()` 而不是 `cp`**。

---

## 六、落地建议（如果决定做）

推荐分三步，每步都可独立验证、可回滚：

**第 1 步（半天）· 先让它在 Windows 上跑起来**
保持 MySQL，装个免安装版 MySQL，把 `npm install` / `build` / `start` 走通，确认刷新循环与日报真的在跑。这一步不碰代码，收益是**先建立可用的基线**——万一后面改造出问题，有个能对照的参照。

**第 2 步（3–5 天）· SQLite 改造**
- 用 `node:sqlite`，开 WAL
- 先改 `db/pool.js` + `store.js` + `history.js` + `migrate.js`（低风险，占 80% 的 SQL）
- 单独处理 `analytics` 路由：把 `LAG` + 分桶聚合搬到 Node 侧，**并写测试锁死新旧口径一致**
- 重写 `store.test.js`，改用 `:memory:` 真库
- 补 `.gitignore` / `next.config.mjs` 的 `.db` 排除

**第 3 步（1–2 天）· 便携包**
写 `.bat` 启动脚本、把 Node 免安装包和构建产物组装成目录、加一个基于 `backup()` 的备份按钮。

---

## 七、风险清单汇总

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| 1 | `analytics` 的口径漂移（SQL → Node 聚合） | **高** | 写一致性测试；对同一份数据跑新旧两版比对 |
| 2 | 时区语义变化（MySQL 会话时区 → SQLite `localtime`） | 中 | 改为显式时区计算，不依赖数据库函数 |
| 3 | `instrumentation.ts` 在 standalone 下未生效 | 中 | 每次改动后**必须看启动日志**，不能只看编译通过 |
| 4 | `node:sqlite` 标记为 experimental | 中 | 锁定 Node 版本；或封装驱动层，将来可切 `better-sqlite3` |
| 5 | WAL 模式下裸拷 `.db` 得到不完整备份 | 中 | 备份一律走 `backup()` API |
| 6 | 双后端维护成本 | 低（若不做双后端则无） | 初版只做 SQLite |
| 7 | 凭证数据库进构建产物 | 低 | `outputFileTracingExcludes` 加 `*.db` |

---

## 八、附：本次评估的实际核查记录

| 核查项 | 方法 | 结果 |
|---|---|---|
| SQL 总量 | `grep` 全仓 `pool.query` / `INSERT` / `SELECT` / `DELETE` | 18 条，集中 5 个文件 |
| `server/` 是否含 SQL | grep | **不含**，只调 store/history 方法 |
| `node:sqlite` 可用性 | 本机 `node -e "require('node:sqlite')"` | 可用，含 `backup` API |
| Node 版本 | `node -v` | v22.22.2（内置 sqlite 分支已启用） |
| 测试对 DB 的依赖 | 读 4 个测试文件 | 仅 `store.test.js`，用 fakePool |
| 构建状态 | 检查 `node_modules` / `.next` | **均不存在**，首次运行需 `npm install` |
| 官方打包工具痕迹 | grep `pkg` / `nexe` / `SEA` | 无 |
| CI | 读 `.github/workflows/docker.yml` | 仅构建推 GHCR 镜像，无测试步骤 |
