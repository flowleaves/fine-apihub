# Changelog

All notable changes from the upstream `lettimepassby/relay-monitor` project are documented in this file.

## [2.3.1] - 2026-09-14 - 品牌标识符收尾

### Branding
- 清理代码内残留的 relay 系标识符（项目已更名为 `fine-apihub`，仓库 `flowleaves/fine-apihub`）：
  - 会话 Cookie 名 `rm_session` → `fa_session`
    - `lib/auth.js` 改为导出 `COOKIE_NAME`，`lib/api.js` 复用该常量，消除两处硬编码重复
  - 运行时单例 `globalThis.__RELAY_RT` → `globalThis.__FA_RT`（`lib/runtime.js`）
  - 通知渠道示例发件人 `Relay Monitor` → `FINE-APIHUB`（`lib/notify.js`，2 处）
- `package.json` 版本号 `2.2.0` → `2.3.0`（与 CHANGELOG 对齐）；`description` 补品牌前缀

### Breaking
- **Cookie 名变更会使既有登录会话失效**：升级后需重新登录一次（旧 `rm_session` Cookie 不再被识别）。

---

## [2.3.0] - 2026-09-14 - FINE-APIHUB Fork

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
- Renamed project from `relay-monitor` to `FINE-APIHUB`
  - Package name, manifest, titles, logs, SMTP EHLO, report footers
  - Default database path: `data/fine-apihub.db`
  - Service Worker cache name: `fine-apihub-shell-v2`
- Updated all user-facing strings and documentation

### Infrastructure
- **Removed Docker CI workflow** (`.github/workflows/docker.yml`)
  - Project now targets local SQLite deployment by default
  - Docker Compose config updated for SQLite mode
- **Renamed git remote**: `origin` → `upstream` to prevent accidental pushes to upstream repository

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

## [2.2.0] - 2026-08-23 - Upstream Release (lettimepassby)

Last upstream release before fork. See upstream repository for full changelog.

### Key Features
- Added log audit (cache token accounting)
- Added group/channel breakdown with period-over-period comparison
- Flow data analytics (`/api/data/flow`)

---

## Fork Information

- **Upstream**: `github.com/lettimepassby/relay-monitor` (MIT License)
- **Fork Date**: 2026-09-14
- **Fork Reason**: SQLite local-first deployment, security hardening, independent branding
- **Compatibility**: API surface unchanged, data models compatible with upstream v2.x
