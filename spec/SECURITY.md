# 安全策略

> fine 的认证、授权、凭据处理、响应头与审计约定。

## 1. 认证机制

### 密码哈希

- **算法**：scrypt（Node.js `crypto.scryptSync`）
- **参数**：salt = 16B 随机 hex，keylen = 32B，N/r/p 为 Node.js 默认值
- **比较**：`crypto.timingSafeEqual` 防时序攻击

```javascript
// lib/auth.js
function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}
```

### 会话 Cookie

- **格式**：`HMAC-SHA256(payload, secret)`，payload 为 base64url 编码的 JSON `{ u: username, exp: timestamp }`
- **有效期**：7 天（`SESSION_TTL_MS = 7 * 24 * 3600 * 1000`）
- **Cookie 属性**：
  - `HttpOnly` — 禁止 JS 读取
  - `SameSite=Lax` — 防 CSRF
  - `Path=/`
  - `Secure` — **HTTPS 时自动启用**（通过 `X-Forwarded-Proto` 或请求协议检测）

```javascript
// lib/auth.js
cookieHeader(token, secure = false) {
  const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  return `${COOKIE_NAME}=${token}; ${flags}${secure ? "; Secure" : ""}`;
}
```

### 登录限流

- **阈值**：同 IP 10 次失败锁 5 分钟
- **存储**：内存 Map（`SessionManager.failures`），进程重启清零
- **清除**：登录成功时清除该 IP 记录

```javascript
// lib/auth.js
recordFailure(ip) {
  const f = this.failures.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= 10) {
    f.lockedUntil = Date.now() + 5 * 60 * 1000;
    f.count = 0;
  }
}
```

## 2. 授权中间件

### `withAuth`（`lib/api.js`）

- 保护所有 `/api/*` 端点（除 `/api/auth/login`、`/api/auth/logout`）
- 校验流程：
  1. 从 Cookie 提取 `fa_session`
  2. `SessionManager.verify()` 校验 HMAC 签名 + 有效期
  3. 失败 → 401 `{ error: "未登录", code: "UNAUTHORIZED" }`
  4. 成功 → 注入 `rt`（运行时单例）到 handler

### `isSecureRequest`（`lib/api.js`）

```javascript
function isSecureRequest(request) {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto === "https";
  return new URL(request.url).protocol === "https:";
}
```

用于判断是否在 HTTPS 环境下设置 `Secure` Cookie 标志。

## 3. 凭据处理

### 脱敏规则（`server/stations.js::redact()`）

**所有 API 响应中的站点数据必须经过 `redact()` 处理**，禁止将原始凭证下发到前端。

| 字段 | 脱敏方式 |
|------|---------|
| `accessToken` | 保留前 6 位，其余替换为 `****` |
| `apiKey` | 保留前 6 位，其余替换为 `****` |
| `password` | 完全替换为 `"****"` |
| `email` | 保留前 2 位和 `@` 后域名，中间替换为 `****` |
| `s2Tokens` | 替换为 `{ accessToken: "****", refreshToken: "****", expiresAt }` |

### 凭据存储

- **位置**：`stations.doc` JSON 文档内（SQLite TEXT 列）
- **加密**：当前无额外加密，依赖文件系统权限（`.db` 文件仅应用进程可读写）
- **sub2api 密码**：明文存储（因需要自动登录，无法哈希）
- **改善方向**：可考虑用 OS keychain / DPAPI 加密 `password` 和 `apiKey`

### 构建产物隔离（2026-09-17 实测发现并修复）

> ⚠️ **曾经的漏洞**：`next build` 会把 `data/` 连同真实凭证库拷进 `.next/standalone`。

实测（Next.js 16.2.10，从零构建复现）`next.config.mjs::outputFileTracingExcludes` **并未生效**：

| 构建路径 | 行为 |
|---|---|
| **Turbopack**（默认） | 无法静态解析 `path.join(process.cwd(), ...)`，保守地把**整个项目目录**拷进 `standalone`：`data/`（含 WAL 与 `_legacy/` 旧库）、`spec/`、`deploy/`、`*.md` 全在内 |
| **webpack**（`next build --webpack`） | 结构干净得多，但仍会把 `db/pool.js::resolveDbPath()` 里字面量拼出的 `data/fine-apihub.db` 带进去 |

因为 `Dockerfile` 是 `COPY --from=builder /app/.next/standalone ./`，**镜像会带上站点 accessToken / JWT / 明文密码、面板密码哈希与会话密钥**；`.dockerignore` 的 `data` 只作用于构建上下文（`COPY . .`），拦不住 `next build` 自己写进去的那份。

**现有两层兜底（改任一处前先读这段）**：

1. **`tools/check-standalone.mjs`**（已接入 `npm run build`）：构建后扫描 `.next/standalone`，发现 `*.db` / `*.db-wal` / `*.db-shm` / `.env*` 或 `data/` 即**删除并大声告警**；
   `npm run check:standalone`（`--strict`）用于 CI / 发布前门禁，发现泄漏则以非零码失败。
2. **`Dockerfile` 运行阶段**：`rm -rf ./data ./spec ./deploy ./.env*` 后断言镜像内不存在任何数据库文件，否则构建失败（`FATAL: 镜像产物含数据库文件`）。

**验证方式**：`npm run build` 后执行 `Get-ChildItem .next/standalone -Recurse -Include *.db*`（应无输出），并确认项目根 `data/fine-apihub.db` 的大小/修改时间**未被改动**（守卫只动产物里的副本）。


## 4. 响应头安全

### 全局安全头（`next.config.mjs::headers()`）

| 头 | 值 | 作用 |
|---|-----|------|
| `X-Content-Type-Options` | `nosniff` | 禁止浏览器 MIME 嗅探 |
| `X-Frame-Options` | `DENY` | 禁止嵌入 iframe |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 控制 Referrer 泄露 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | 禁用敏感 API |

### API 缓存控制

所有 `/api/*` 路由返回：
```
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
```

防止浏览器/代理缓存敏感数据（余额、凭证摘要、用户列表等）。

## 5. 已移除的攻击面

| 移除项 | 原风险 | 当前状态 |
|--------|--------|---------|
| `/mock/*` 路由（13 个文件） | 未认证的模拟数据接口，可泄露内部数据结构 | 已删除，启动时自动清理 stale demo 站 |
| `server/demo.js` | 演示站种子数据，含硬编码凭证 | 已删除 |
| Docker CI workflow | 自动构建可能泄露 registry 凭证 | 已删除（`.github/workflows/docker.yml`） |

## 6. 安全红线

以下操作**未经明确授权一律禁止**：

1. 删除/重建 SQLite 数据库文件（`data/*.db`）
2. 直接修改用户余额或站点凭证（应通过正常 API 操作）
3. 修改生产环境的安全头配置
4. 关闭 `HttpOnly` 或 `SameSite` Cookie 属性
5. 将 `.db` 文件提交到版本控制
6. 在日志中输出完整 `accessToken` / `apiKey` / `password`
7. 暴露上游站点的内部 API 地址
8. 让构建产物/镜像包含数据库或 `.env`（`data/` 下是凭证）——**不得移除** `tools/check-standalone.mjs` 或 `Dockerfile` 里的清库与断言步骤

## 7. 审计日志

当前**无结构化审计日志表**。关键操作通过 `console.log` / `console.error` 输出到进程 stdout/stderr，由外部日志系统（如 Docker logs、systemd journal）收集。

建议后续补充的审计事件：
- 登录成功/失败（含 IP）
- 站点增删改
- 设置变更
- 通知渠道增删改
- 手动刷新触发
