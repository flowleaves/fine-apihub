# fine（Web 面板）· Agent 记忆入口

`fine-apihub` 是**独立 git 仓库**里的自托管**中转站余额监控面板**（Next.js 全栈 + SQLite）。
技术特性：SQLite 单文件持久化、安全加固、独立品牌。

> ⚠️ **不要与 `fineapihub/` 混淆**：那是 **Tauri v2 + Rust 的 Windows 桌面应用**（另一个项目、另一套架构、另一个仓库）。两者只共享"Hub"这个名字。

## 1. 仓库

| 项 | 值 |
|---|---|
| 仓库 | `origin` = `git@github.com:flowleaves/fine-apihub.git` |
| 分支 | `main`（跟踪 `origin/main`） |
| 详细规范 | 本仓库 `spec/`（架构 / API / 数据模型 / 安全 / 预测 / Sub2API Key 用量） |

- 🔴 **推送红线**：任何 `git push` 必须先获用户明确同意；未获同意只做本地 commit。
- 改到本子项目时：**以本仓库 `spec/` 为准**，与工作区根 `spec/` 冲突时本仓库优先。

## 2. 模块边界

| 路径 | 职责 | 改动注意 |
|---|---|---|
| `app/(dashboard)/` | 面板页面：总览 / 中转站 / 我的站点 / 用量 / 经营分析 / 通知 / 设置 | 无全局状态库，页面侧自刷新 |
| `app/api/` | **26 个** Route Handler（REST） | 一律经 `lib/api.js::withAuth`，响应形状与 v1 一致 |
| `lib/providers.js` | 上游站点适配器（994 行，最重核心） | `QUOTA_PER_UNIT = 500000` 是**唯一**换算常量；上游实测约束见 `spec/ARCHITECTURE.md` §4.1 |
| `lib/alerts.js` | 告警状态迁移 + 通知触发 | 靠**状态迁移**触发，不做定时轰炸 |
| `lib/forecast.js` | 消费预测（日级 / 小时级） | 四模型等权组合已回测定型，换模型须附 60 天回测数据（`spec/FORECAST.md` §8） |
| `lib/notify.js` / `lib/smtp.js` | 10 种通知渠道 | 新渠道先加 `CHANNEL_TYPES` |
| `lib/auth.js` / `lib/api.js` | scrypt 密码 + HMAC 会话 Cookie | scrypt 参数不可降 |
| `lib/runtime.js` | 运行时单例 `globalThis.__FA_RT` | 生产初始化失败必须 `process.exit(1)` |
| `db/pool.js` | 驱动抽象 + 方言翻译 + 建表 | 新 SQL 必须**同时兼容** SQLite + MySQL |
| `db/store.js` / `db/history.js` | 内存缓存 + 写透 | `save()` 必须串行化；`MAX_POINTS` / `MAX_AGE_MS` 不可随意改 |
| `db/usage.js` | 每日用量落库（`usage_points`） | upsert 保留 MySQL 写法（由 `pool.js` 转写）；缺失=未采样，禁止写 0 冒充 |
| `server/refresh.js` | 刷新调度：分档（others/own）+ 用量采样 | `refreshStation` 同站去重**必须保留**；节流不得被手动刷新绕过 |
| `server/report.js` | 每日日报调度 | 按 `REPORT_TIME_ZONE`（默认北京时间） |
| `server/stations.js` | `redact()` 统一脱敏 | 所有下发前必过 |
| `instrumentation.ts` | 启动钩子 | → `lib/runtime.js::getRuntime()` |

## 3. 硬性红线

1. **凭证绝不外传**：API 响应必须经 `server/stations.js::redact()`；不下发 `accessToken` / `apiKey` / `password` / `s2Tokens` 原文。
2. **凭证不进日志、不进构建产物**：`next.config.mjs` 已用 `outputFileTracingExcludes` 排除 `data/**` / `*.db*`，不要移除。
3. **`data/` 绝不入库**：含站点凭证、面板密码哈希、会话密钥、余额历史（`*.db` / `*.db-wal` / `*.db-shm`）。
4. **迁移不在启动链中**：`db/migrate.js` 引用 `stations.json` 字面量会被 Next 构建追踪，把真实凭证拷进 standalone 产物——只由部署入口显式执行。
5. **不破坏 Cookie 属性**：`fa_session` 的 `HttpOnly` / `SameSite=Lax` 不可关。
6. 删除/重建 `data/*.db`、直接改余额或站点凭证，均需明确授权。

## 4. 开发约定

```bash
npm test            # node --test（非 jest/vitest）：59 项，约 7s，全绿
npm run dev         # 开发模式
npm run build       # → standalone 产物（末尾自动跑 check-standalone 守卫）
npm run build:webpack          # 同上，但用 webpack 构建（standalone 更精简）
npm run check:standalone       # 守卫 strict 模式：产物含 *.db/.env 即失败（CI 门禁）
npm run db:migrate  # 幂等；库非空即跳过
npm run db:backup   # 一致性在线备份（WAL 下别直接 cp .db）→ data/fine-apihub-backup-<时间戳>.db
```

> 🔴 **不要移除构建守卫**：`next build` 会把 `data/`（真实凭证库）拷进 `.next/standalone`，而 Dockerfile 正是拷它。
> `outputFileTracingExcludes` 在 Next 16.2.10 下**无效**（Turbopack 会拷贝整个项目目录）。
> 兜底 = `tools/check-standalone.mjs`（构建后删库 + 告警）+ `Dockerfile` 的断言。详见 `spec/SECURITY.md` §3.3。

- **运行方式**：`next.config.mjs` 设了 `output: "standalone"`，所以 `npm start`（`next start`）会告警，**规范做法**是
  `node .next/standalone/server.js`（需先把 `.next/static` 与 `public` 拷进 `.next/standalone`，见 `Dockerfile`）。
- **刷新分档（改调度前必读）**：自有站（`isOwn`）是生产站，分析一次要打它 5+ 个接口，因此
  `server/refresh.js` 按归属分档——**其它站点**走定时轮询（`refreshIntervalSec`），**自有站**只在
  「我的站点 / 经营分析」页面使用时由 `ensureOwnFresh()` 按 `ownRefreshIntervalSec`（默认 1 小时）节流刷新；
  启动首刷 / 手动 `POST /api/refresh` / `PUT /api/settings` 始终是 `scope:"all"` 全量。详见 `spec/ARCHITECTURE.md` §3.1。
  ⚠️ 代价：自有站不参与常规轮询 → 它的余额告警最长延迟一个节流周期；要恢复把 `ownRefreshIntervalSec` 设 0。
- **数据库**：默认 SQLite `data/fine-apihub.db`（WAL 模式，`node:sqlite` 内置模块）；`DB_DRIVER=mysql` 切 MySQL。
  三张业务表：`stations` / `meta` / `history_points`（余额快照，每次刷新落库）+ `usage_points`（每日用量，**每站每小时采样一次**）。
  PostgreSQL 暂不引入（评估过：本量级 SQLite 完全够，且单文件即备份是设计取向）；驱动层已抽象为 `pool.query(sql, params)`，将来可加第三驱动。
  一致性备份用 `db/pool.js::backupTo()`，**不要**在 WAL 下直接复制 `.db`。
- **默认账号**：`admin` / `admin123`（首次登录 `isDefaultPassword: true`），对外暴露前必须改。
- 测试文件与被测模块同目录（`lib/providers.test.js` 等），新增核心逻辑请补 `node --test` 用例。

## 5. 演进记录 / 遗留

**2026-09-17 本轮已完成**：
- ✅ `.env.example` 重写为 SQLite 优先（`DB_PATH` / `DB_DRIVER` / `REPORT_TIME_ZONE` / `TZ` / `V1_DATA_DIR` / `APP_COMMIT`）。
- ✅ 版本号三处不一致（`package.json`=2.3.0、`package-lock.json`=2.2.0、CHANGELOG=2.3.1）→ 统一 **2.3.1**。
  ⚠️ `/api/meta` 的 `app.version` 读**构建时**的 `package.json`，改完必须重新 `npm run build`。
- ✅ `deploy/docker-compose.yml`：原镜像引用**不存在**（GHCR 实测 403）→ 改 `ghcr.io/flowleaves/fine-apihub:latest` + `build:` 段，watchtower 默认注释。
- ✅ **修复构建产物泄露凭证**：`next build` 会把 `data/`（真实凭证库）拷进 `.next/standalone`，而 Dockerfile 正是拷它 → 加 `tools/check-standalone.mjs` 守卫 + Dockerfile 断言。
- ✅ 品牌与作者统一为 `fine`；`LICENSE` 仅保留自有版权（站长确认已获原作者许可）；移除 `upstream` remote。
- ✅ 新增 `npm run db:backup`（把原本「文档推荐却无入口」的 `backupTo()` 接出 CLI）。
- ✅ 刷新分档调度 + 自有站节流（`spec/ARCHITECTURE.md` §3.1）；`/api/own/analytics` 的缓存窗口也绑到同一节流值。
- ✅ 每日用量落库 `usage_points` + `GET /api/usage/daily`（日粒度、每站每小时采样一次）。
- ✅ Claude 风设计 token（`app/theme.ts` + `--cl-*` CSS 变量，全站生效）。
- ✅ 删除「消耗月历」页面及其专用接口（`/api/calendar` 与 `queryDailyCost`/`chunkRange`）—— 无消费者的死代码；上游实测约束已固化到 `spec/ARCHITECTURE.md` §4.1。
- ✅ 新增 Windows 一键启动 `start.bat`（纯 ASCII，原因见 README）。

**遗留 / 待定**：
- 根 `.gitignore`「独立 git 仓库」段仍缺 `/new-api/`、`/SillyTavern/`（各带 `.git`，当前在根仓库显示为未跟踪）。
- `GET /api/stations/:id/keys/usage`（Sub2API 按 Key 用量）**后端已实现且有测试，但前端没有入口** —— 是「功能未接 UI」而非死代码，需要时在「用量」页加一个视图即可。
- `$`/`¥` 折算依赖各站 `cnyPerUsd`，未配置时按 1:1（会让 ¥ 列等于 $ 列，不是 bug）。
- 工作区侧记录见 `.agents/MEMORY.md` §22、根 `spec/fine-apihub/SPEC.md`。
