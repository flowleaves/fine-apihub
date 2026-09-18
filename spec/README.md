# fine 规范文档

> 本项目规范体系入口。二创改造后的架构约定、接口契约与安全策略。

## 文档索引

| 文档 | 内容 |
|------|------|
| `README.md` | 本文件：规范体系总览与快速导航 |
| `ARCHITECTURE.md` | 系统架构：分层、数据流、关键模块职责 |
| `API.md` | 接口规范：26 个端点的请求/响应契约 |
| `DATA-MODEL.md` | 数据模型：SQLite 表结构、内存缓存形状、迁移规则 |
| `SECURITY.md` | 安全策略：认证、授权、凭据处理、响应头、审计日志 |
| `FORECAST.md` | 预测模型：四模型等权组合 + conformal 区间的实现细节与回测结论 |
| `SUB2API-KEY-USAGE.md` | Sub2API 按 Key 用量统计的口径、权限与安全约定 |

## 快速参考

### 项目定位
fine 是一个自托管的 **sub2api / new-api 中转站余额监控面板**。核心特性：SQLite 单文件、安全加固、独立品牌。

### 技术栈
- **前端**：Next.js 16 App Router + React 19 + Ant Design Pro（antd 6）
- **后端**：Next.js Route Handlers（全栈同构）
- **数据库**：SQLite（`node:sqlite` 内置模块，WAL 模式），可选 MySQL 双驱动
- **测试**：`node --test`（原生测试运行器，非 jest/vitest）
- **构建**：`next build` → standalone 产物

### 关键路径
```
用户 → Next.js App Router → API Route Handler → rt.store / rt.history
                                    ↓
                           lib/providers.js（站点适配器）
                                    ↓
                           上游中转站 API（sub2api / new-api）
```

### 运行时单例
```
globalThis.__FA_RT = { pool, store, history, sessions, refreshAll, restartPolling }
```
- 初始化入口：`instrumentation.ts` → `lib/runtime.js::getRuntime()`
- 生产环境初始化失败 → `process.exit(1)`（有意设计，避免空状态覆盖凭证）

### 数据库文件
- 默认：`data/fine-apihub.db`
- 自定义：`DB_PATH=/path/to/custom.db`
- WAL 文件：`*.db-wal`、`*.db-shm`（已在 `.gitignore` 中排除）

### 安全底线
1. **凭证绝不外传**：统一脱敏入口 `server/stations.js::redact()`
2. **Cookie Secure**：HTTPS 时自动启用（`X-Forwarded-Proto` 检测）
3. **响应头**：nosniff / DENY frame / strict referrer / permissions policy
4. **API 不缓存**：`Cache-Control: no-store`
5. **登录限流**：同 IP 10 次失败锁 5 分钟
6. **scrypt + HMAC**：密码哈希 + 会话签名

### 测试
```bash
npm test    # 59 项测试，约 7 秒
```

## 仓库 / API 表面

- `origin` = `github.com/flowleaves/fine-apihub`
- API 表面：26 个 REST 端点；其中 `GET /api/stations/:id/keys/usage`（Sub2API 按 Key 用量）与
  `GET /api/usage/daily`（本地落库的每日用量）为新增能力，其余端点为基线端点

---

*本文档随代码迭代同步更新。修改规范时请先更新本文档，再改代码。*
