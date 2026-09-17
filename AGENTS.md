# FINE-APIHUB（Web 面板）· Agent 记忆入口

`fine-apihub` 是**独立 git 仓库**里的自托管**中转站余额监控面板**（Next.js 全栈 + SQLite）。
fork 自 `lettimepassby/relay-monitor`，核心改造：MySQL → SQLite 单文件、安全加固、品牌独立（relay → fine-apihub）。

> ⚠️ **不要与 `fineapihub/` 混淆**：那是 **Tauri v2 + Rust 的 Windows 桌面应用**（另一个项目、另一套架构、另一个仓库）。两者只共享"Hub"这个名字。

## 1. 仓库 / 上游

| 项 | 值 |
|---|---|
| 自有仓库 | `origin` = `git@github.com:flowleaves/fine-apihub.git` |
| 上游 | `upstream` = `git@github.com:lettimepassby/relay-monitor.git` |
| 上游推送 | **已禁用**（`remote.upstream.pushurl = DISABLED`）——只用来合并上游修复 |
| 分支 | `main`（跟踪 `origin/main`） |
| 详细规范 | 本仓库 `spec/`（架构 / API / 数据模型 / 安全 / 预测 / Sub2API Key 用量） |

- 🔴 **推送红线**：任何 `git push` 必须先获用户明确同意；未获同意只做本地 commit。
- 改到本子项目时：**以本仓库 `spec/` 为准**，与工作区根 `spec/` 冲突时本仓库优先。

## 2. 模块边界

| 路径 | 职责 | 改动注意 |
|---|---|---|
| `app/(dashboard)/` | 面板页面：总览 / 中转站 / 我的站点 / 用量 / 经营分析 / 通知 / 设置 | 无全局状态库，页面侧自刷新 |
| `app/api/` | **25 个** Route Handler（REST） | 一律经 `lib/api.js::withAuth`，响应形状与 v1 一致 |
| `lib/providers.js` | 上游站点适配器（916 行，最重核心） | `QUOTA_PER_UNIT = 500000` 是**唯一**换算常量 |
| `lib/alerts.js` | 告警状态迁移 + 通知触发 | 靠**状态迁移**触发，不做定时轰炸 |
| `lib/forecast.js` | 消费预测（日级 / 小时级） | 四模型等权组合已回测定型，换模型须附 60 天回测数据（`spec/FORECAST.md` §8） |
| `lib/notify.js` / `lib/smtp.js` | 10 种通知渠道 | 新渠道先加 `CHANNEL_TYPES` |
| `lib/auth.js` / `lib/api.js` | scrypt 密码 + HMAC 会话 Cookie | scrypt 参数不可降 |
| `lib/runtime.js` | 运行时单例 `globalThis.__FA_RT` | 生产初始化失败必须 `process.exit(1)` |
| `db/pool.js` | 驱动抽象 + 方言翻译 + 建表 | 新 SQL 必须**同时兼容** SQLite + MySQL |
| `db/store.js` / `db/history.js` | 内存缓存 + 写透 | `save()` 必须串行化；`MAX_POINTS` / `MAX_AGE_MS` 不可随意改 |
| `server/refresh.js` | 后台刷新循环 | `refreshStation` 同站去重**必须保留** |
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
npm test            # node --test（非 jest/vitest）：45 项，约 7s，全绿
npm run dev         # 开发模式
npm run build       # → standalone 产物
npm run db:migrate  # 幂等；库非空即跳过
```

- **运行方式**：`next.config.mjs` 设了 `output: "standalone"`，所以 `npm start`（`next start`）会告警，**规范做法**是
  `node .next/standalone/server.js`（需先把 `.next/static` 与 `public` 拷进 `.next/standalone`，见 `Dockerfile`）。
- **数据库**：默认 SQLite `data/fine-apihub.db`（WAL 模式，`node:sqlite` 内置模块）；`DB_DRIVER=mysql` 切 MySQL。
  一致性备份用 `db/pool.js::backupTo()`，**不要**在 WAL 下直接复制 `.db`。
- **默认账号**：`admin` / `admin123`（首次登录 `isDefaultPassword: true`），对外暴露前必须改。
- 测试文件与被测模块同目录（`lib/providers.test.js` 等），新增核心逻辑请补 `node --test` 用例。

## 5. 已知待办 / 遗留（2026-09-17 通读发现）

- `.env.example` 仍只写 MySQL，未提 SQLite 默认值与 `DB_DRIVER` / `DB_PATH` / `REPORT_TIME_ZONE`。
- `deploy/docker-compose.yml` 镜像指向 `ghcr.io/lettimepassby/fine-apihub:latest`（上游命名空间），与本仓 `flowleaves` 不一致。
- `package.json` 版本 `2.3.0` 与 `CHANGELOG.md` 顶部 `[2.3.1]` 不一致。
- 通读结论见工作区 `.agents/MEMORY.md` §22。
