# Changelog

All notable changes to this project are documented in this file.

## [2.3.1] - 2026-09-14 - 品牌标识符收尾

### Branding
- 清理代码内历史标识符（项目已更名为 `fine-apihub`，仓库 `flowleaves/fine-apihub`）：
  - 会话 Cookie 名 `rm_session` → `fa_session`
    - `lib/auth.js` 改为导出 `COOKIE_NAME`，`lib/api.js` 复用该常量，消除两处硬编码重复
  - 运行时单例 `globalThis.__RELAY_RT` → `globalThis.__FA_RT`（`lib/runtime.js`）
  - 通知渠道示例发件人标签统一为 `fine`（`lib/notify.js`，2 处）
- `package.json` 版本号 `2.2.0` → `2.3.1`（与 CHANGELOG 对齐）；`description` 补品牌前缀；新增 `author: "fine"`

### Chore
- **新增 `npm run db:backup`**（`db/backup.js`）：把 `db/pool.js::backupTo()` 的一致在线备份能力接出 CLI
  - 此前该 API 被 README / `spec/DATA-MODEL.md` 推荐为「WAL 模式下的正确备份方式」，但**没有任何入口能调用**（死代码）
  - 默认输出 `data/fine-apihub-backup-<UTC 时间戳>.db`，支持指定路径；`DB_DRIVER=mysql` 时拒绝执行（改用 `mysqldump`）
- **品牌统一为 `fine`**：界面标题 / 登录页 / 侧边栏 / 关于页 / 页面 metadata / PWA manifest / 日报邮件页脚 / 测试通知 / Bark 分组 / Webhook `source` / 启动横幅 / `package.json` description，全部由 `FINE-APIHUB` 改为 `fine`
  - 保留的技术标识符（非展示品牌，改动无收益且有副作用）：`data/fine-apihub.db`（库文件名）、`ghcr.io/flowleaves/fine-apihub`（镜像/仓库名）、`package.json.name`、Service Worker 缓存名、SMTP `EHLO`/`Message-ID` 域标签
- **`LICENSE` 版权归属改为 `Copyright (c) 2026 fine`**
- **文档路径修正**：`spec/ARCHITECTURE.md` 架构图把 `db/store.js`、`db/history.js` 误写为 `lib/`；站点类型数量 `4 种` 更正为 `5 种`（与 `STATION_TYPES` 一致）
- `README.md` 目录结构补齐 `deploy/`、`tools/`、`AGENTS.md`
- 删除空目录残留 `docs/`、`.github/`（Docker CI 移除后遗留，未被 git 跟踪）

### Security
- **修复构建产物泄露运行时凭证**（实测发现）：`next build` 会把 `data/` 连同真实凭证库拷进 `.next/standalone`，而 `Dockerfile` 正是 `COPY .next/standalone` → **镜像会带上站点 accessToken / JWT / 明文密码、面板密码哈希与会话密钥**
  - 根因：`next.config.mjs::outputFileTracingExcludes` 在 Next 16.2.10 下**未生效**——Turbopack（默认）无法静态解析 `path.join(process.cwd(), ...)`，会把整个项目目录拷进 `standalone`；`--webpack` 构建结构干净但仍会带入 `data/fine-apihub.db`
  - 新增 `tools/check-standalone.mjs`：构建后扫描产物，发现 `*.db*` / `.env*` / `data/` 即删除并告警；已接入 `npm run build`，另有 `npm run check:standalone`（`--strict`，CI 门禁用）
  - `Dockerfile` 运行阶段新增清理 + 断言：镜像内若存在任何数据库文件则**构建失败**
  - 新增 `npm run build:webpack`（产出更精简的 standalone，无 `spec/`/`deploy/` 等冗余目录）
  - 详见 `spec/SECURITY.md` §3.3

### Fixed
- **版本号三处不一致**修正：`package.json` 原为 `2.3.0`、`package-lock.json` 原为 `2.2.0`、CHANGELOG 顶部为 `2.3.1`
  - 三处统一为 `2.3.1`（`/api/meta` 的 `app.version` 取自 `package.json`，需重新构建后生效）
  - `spec/API.md` 的 `app.version` 示例同步更新
- `.env.example` 重写为 **SQLite 优先**：原文只列 MySQL 且标注"必填"，与 README「SQLite 默认」自相矛盾
  - 补充实际支持的变量：`DB_PATH`、`DB_DRIVER`、`REPORT_TIME_ZONE`、`TZ`、`V1_DATA_DIR`、`APP_COMMIT`（均与 `db/pool.js` / `db/migrate.js` / `server/report.js` 的实现逐一对齐）
  - 全部改为可选并注明默认值（零配置即可运行）
- `deploy/docker-compose.yml` 镜像引用修正：原镜像引用**并不存在**（实测 GHCR 返回 403＝不存在，与对照组同码）
  - 改为 `ghcr.io/flowleaves/fine-apihub:latest` + **新增 `build:` 段**，使 `docker compose up -d --build` 可直接从源码构建（本仓无镜像 CI）
  - watchtower 段默认注释：仅在自有镜像发布到 GHCR 后才有意义（此前会拉取不存在的镜像）

### Breaking
- **Cookie 名变更会使既有登录会话失效**：升级后需重新登录一次（旧 `rm_session` Cookie 不再被识别）。

---

## [2.3.0] - 2026-09-14 - Fork：SQLite 迁移 + 安全加固 + 品牌独立

### Database
- **Replaced MySQL with SQLite** as the default and recommended database
  - Uses Node.js built-in `node:sqlite` module (zero external dependencies)
  - Single-file database: `data/fine-apihub.db`
  - WAL mode enabled for concurrent read/write safety
  - Copy `.db` file for easy backup and migration
  - MySQL mode retained as optional via `DB_DRIVER=mysql` (backward compatible)
- Added `backupTo()` API for consistent database snapshots (uses SQLite's native `backup()`)

### Security
- **Removed all `/mock/*` routes** and `server/demo.js` (13 route files deleted)
  - Auto-cleans stale demo stations on startup (`demo === true && baseUrl.includes("/mock")`)
  - Reduces attack surface by eliminating unauthenticated mock endpoints
- **Added Secure cookie flag**
  - Automatically enabled for HTTPS requests (detects via `X-Forwarded-Proto` header or request protocol)
  - Falls back to non-Secure for local HTTP development
- **Added security response headers** (global):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- **Added API cache control**: `Cache-Control: no-store, no-cache, must-revalidate` for all `/api/*` routes

### Branding
- Renamed project to `fine-apihub`
  - Package name, manifest, titles, logs, SMTP EHLO, report footers
  - Default database path: `data/fine-apihub.db`
  - Service Worker cache name: `fine-apihub-shell-v2`
- Updated all user-facing strings and documentation

### Infrastructure
- **Removed Docker CI workflow** (`.github/workflows/docker.yml`)
  - Project now targets local SQLite deployment by default
  - Docker Compose config updated for SQLite mode
- **Adjusted git remotes**: kept a single `origin` remote for this repository

### Testing
- Rewrote `db/store.test.js` to use real SQLite `:memory:` database instead of `fakePool`
  - Tests now validate actual dialect translation (ON CONFLICT, INSERT OR IGNORE, etc.)
  - Added round-trip persistence tests
- Added `db/history.test.js` (new file, 10 tests)
  - Covers append timing, batch persistence, removal, usedSince, burnRate, predict, sparkline
- Added `app/api/analytics/aggregate.test.js` (new file, 5 tests)
  - Validates Node-side aggregation matches original SQL semantics
  - Tests drop calculation, recharge handling, window boundary catch, weekday bucketing

### Documentation
- Added `docs/EVAL-SQLITE-AND-PORTABLE.md` - Technical feasibility assessment
- Added `docs/SECURITY-AUDIT.md` - Comprehensive security audit report (no backdoors found)

### Known Issues / Technical Debt
- **MySQL dialect is source-of-truth**, SQLite driver translates it
  - Risk: New code using SQLite-native syntax (e.g., `ON CONFLICT`) will silently fail in MySQL mode
  - Mitigation: `MysqlPool.query()` only reverse-translates `INSERT OR IGNORE` → `INSERT IGNORE`
  - Recommendation: Either fully commit to SQLite-only, or add comprehensive reverse translation
- `serverExternalPackages` no longer includes `"mysql2"`
  - If using MySQL mode, mysql2 may fail to load in standalone builds
  - Fix: Add `"mysql2"` back to `serverExternalPackages` if MySQL mode is needed

---

## [2.2.0] - 2026-08-23

### Key Features
- Added log audit (cache token accounting)
- Added group/channel breakdown with period-over-period comparison
- Flow data analytics (`/api/data/flow`)
