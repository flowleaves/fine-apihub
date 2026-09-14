# 接口规范

> 所有端点基于 Next.js App Router Route Handlers。认证采用 Cookie 会话（`fa_session`）。

## 通用约定

### 认证

- **登录接口**：`POST /api/auth/login` 无需会话，其余端点需有效会话 Cookie。
- **会话 Cookie**：`fa_session={payload}.{signature}`，`HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`（7 天），HTTPS 时自动附加 `Secure`。
- **认证失败**：返回 `401 { error: "未登录", code: "UNAUTHORIZED" }`。
- **限流**：登录接口同 IP 10 次失败锁 5 分钟，返回 `429`。

### 响应格式

- 成功：`200 { ...data }`（Content-Type: application/json）
- 客户端错误：`400/401/404/429 { error: string }`
- 服务端错误：`500 { error: string }`

### 缓存控制

所有 `/api/*` 响应附加：
```
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
```

---

## 1. 中转站管理

### `GET /api/stations`

获取所有中转站列表（已脱敏）及全局设置。

**响应**：
```json
{
  "stations": [
    {
      "id": "st_abc123",
      "name": "我的 NewAPI 站点",
      "type": "newapi",
      "baseUrl": "https://api.example.com",
      "accessToken": "sk-abc1****",
      "userId": "123",
      "apiKey": "",
      "email": "ab****@example.com",
      "password": "****",
      "lowBalanceUsd": 5,
      "cnyPerUsd": 7.2,
      "costAliases": ["api.example.com"],
      "includeInProfit": true,
      "isOwn": true,
      "noRenewal": false,
      "fixedPurchases": [],
      "resoldAdminKeys": [],
      "createdAt": "2026-01-15T08:30:00.000Z",
      "balance": {
        "ok": true,
        "checkedAt": "2026-09-14T06:50:00.000Z",
        "latencyMs": 1200,
        "remaining": 45.23,
        "used": 12.50,
        "total": 57.73,
        "currency": "USD",
        "account": "admin",
        "raw": { "quota": 22615000, "used_quota": 6250000 }
      }
    }
  ],
  "settings": {
    "refreshIntervalSec": 60,
    "lowBalanceUsd": 5,
    "dailyReport": { "enabled": false, "time": "09:00", "channelIds": [], "lastSent": null }
  }
}
```

### `POST /api/stations`

新增中转站。

**请求体**：
```json
{
  "type": "newapi",
  "name": "新站点",
  "baseUrl": "https://api.example.com",
  "accessToken": "sk-xxxxxx",
  "userId": "123",
  "lowBalanceUsd": 5,
  "cnyPerUsd": 7.2,
  "isOwn": true,
  "costAliases": "api.example.com, internal.api"
}
```

**必填**：`type`（必须在 `STATION_TYPES` 中）、`baseUrl`（`fixed` 类型除外）

**响应**：`200 { station: <脱敏后> }`

**行为**：创建后立即触发一次余额查询（`refreshStation`）。

### `PUT /api/stations/:id`

编辑中转站。

**请求体**：字段级更新，只传需要修改的字段（与 `POST` 同字段集）。

**响应**：`200 { station: <脱敏后> }`

**行为**：凭证变化时自动作废 `s2Tokens`；保存后立即触发余额查询。

### `DELETE /api/stations/:id`

删除中转站。

**响应**：`200 { ok: true }`

**行为**：同步清理内存缓存、历史记录、own-cache。

### `GET /api/stations/:id/keys/usage?range={range}`

查询 **Sub2API** 站点的按 API Key 用量统计（要求站点凭证对应 Sub2API 管理员账号）。

**查询参数**：
- `range`：`today`（默认）| `24h` | `7d` | `30d`

**响应**：
```json
{
  "station": { "id": "st_xxx", "name": "站点名" },
  "requestedRange": "today",
  "startMs": 1757836800000,
  "endMs": 1757923200000,
  "items": [
    {
      "id": 12, "name": "Key 名", "userId": 3, "username": "alice",
      "requests": 128, "inputTokens": 12000, "outputTokens": 8000,
      "cacheTokens": 40000, "totalTokens": 60000,
      "actualCost": 1.23, "totalCost": 1.5, "todayCost": 0.4
    }
  ],
  "summary": { "actualCost": 12.3, "todayCost": 4.5, "coveragePct": 100 },
  "effectiveRange": "30d-or-provider-default",
  "source": "sub2api-admin",
  "generatedAt": "2026-09-14T09:00:00.000Z"
}
```

**错误**：`400` 非 Sub2API 站点 / `403` 令牌无管理员权限 / `404` 站点不存在 / `502` 上游查询失败。

**行为**：
- 先枚举全部用户 → 逐个拉取其 API Key → 按 Key ID 批量查用量
- 只返回 Key ID / 名称 / 统计值，**不返回完整 API Key 或 JWT**
- `effectiveRange` 标明上游实际窗口（Sub2API 批量接口按供应商默认窗口返回，可能不等于请求窗口），调用方不得把非精确窗口标注为精确
- 口径与权限约定详见 `spec/SUB2API-KEY-USAGE.md`

---

## 2. 余额刷新

### `POST /api/refresh`

手动全量刷新所有站点余额。

**响应**：
```json
{
  "stations": [ /* 脱敏后的站点列表 */ ],
  "refreshedAt": "2026-09-14T06:55:00.000Z"
}
```

**行为**：与后台定时轮询共用同一套 `refreshAll` 逻辑，含去重、告警评估、历史记录。

---

## 3. 余额历史

### `GET /api/history/overview?hours={n}`

获取全部站点的余额历史（供总览图表用）。

**参数**：`hours` — 窗口小时数，默认 24，范围 1~720（30 天）

**响应**：
```json
{
  "hours": 24,
  "series": [
    {
      "id": "st_abc123",
      "name": "我的 NewAPI 站点",
      "points": [[1726287600000, 45.23], [1726291200000, 44.89], ...]
    }
  ]
}
```

---

## 4. 经营分析

### `GET /api/analytics?days={n}`

基于余额历史快照的消耗聚合（Node 侧计算）。

**参数**：`days` — 分析天数，默认 30，范围 1~30

**响应**：
```json
{
  "days": 30,
  "start": "2026-08-15",
  "end": "2026-09-14",
  "stations": [
    {
      "id": "st_abc123",
      "name": "我的 NewAPI 站点",
      "isOwn": true,
      "includeInProfit": true,
      "cnyPerUsd": 7.2,
      "totalUsd": 12.50,
      "totalCny": 90.00,
      "fixedCny": 30.00,
      "runway": { "etaDays": 3.5, "burnPerDay": 4.2, "basis": "近3小时" }
    }
  ],
  "daily": [
    { "date": "2026-09-14", "stationId": "st_abc123", "usd": 4.20, "cny": 30.24 }
  ],
  "fixedDaily": [
    { "date": "2026-09-14", "stationId": "st_abc123", "cny": 1.00 }
  ],
  "heatmap": [
    { "weekday": 0, "hour": 14, "cny": 120.50 }
  ],
  "generatedAt": "2026-09-14T06:55:00.000Z"
}
```

**口径说明**：
- 消耗 = 相邻快照余额下降之和（上升视为充值忽略）。
- 热力图 `weekday` 口径：0=周一 … 6=周日。
- 固定成本按 `amount ÷ days` 在生效区间内摊销。

---

## 5. 用量统计

### `GET /api/usage?range={range}&tz={timezone}`

分模型 / 分时间的用量明细（逐站查询上游 API）。

**参数**：
- `range`：`today` | `24h` | `7d` | `30d`（默认 `today`）
- `tz`：IANA 时区标识（如 `Asia/Shanghai`），默认浏览器本地时区

**响应**：
```json
{
  "range": "today",
  "granularity": "hour",
  "startMs": 1726252800000,
  "endMs": 1726339200000,
  "tz": "Asia/Shanghai",
  "stations": [
    {
      "id": "st_abc123",
      "name": "我的 NewAPI 站点",
      "type": "newapi",
      "cnyPerUsd": 7.2,
      "isOwn": true,
      "ok": true,
      "models": [
        { "model": "gpt-4o", "tokens": 1250000, "cost": 8.50, "requests": 3200 }
      ],
      "trend": [
        { "t": 1726252800000, "label": "", "tokens": 50000, "cost": 0.35, "requests": 120 }
      ],
      "modelsWindow": "exact",
      "summary": { "cost": 8.50, "tokens": 1250000, "requests": 3200 }
    }
  ],
  "generatedAt": "2026-09-14T06:55:00.000Z"
}
```

**缓存**：同 `(range, tz)` 组合缓存 60 秒。

---

## 6. 「我的站点」下游分析

### `GET /api/own/analytics?range={range}&tz={timezone}`

「我的站点」经营分析（需标记 `isOwn` 的 newapi 站点）。

**参数**：
- `range`：`today` | `24h` | `7d` | `30d`
- `tz`：IANA 时区标识

**响应**：
```json
{
  "range": "today",
  "tz": "Asia/Shanghai",
  "startMs": 1726252800000,
  "endMs": 1726339200000,
  "prevWindow": { "startMs": 1726166400000, "endMs": 1726252800000, "spanDays": 1 },
  "station": { "id": "st_abc123", "name": "我的 NewAPI 站点", "cnyPerUsd": 7.2 },
  "tokenScope": "billed",
  "byModel": [
    { "model": "gpt-4o", "tokens": 1250000, "cost": 8.50, "requests": 3200, "prevCost": 7.20 }
  ],
  "byUser": [
    { "user": "alice", "tokens": 500000, "cost": 3.50, "requests": 1200, "isAdmin": false }
  ],
  "prevUserAvailable": true,
  "flow": { /* 分组/渠道流向数据 */ },
  "userBalances": [
    { "user": "alice", "balanceUsd": 25.00, "usedUsd": 10.00, "status": 1 }
  ],
  "trend": [{ "t": 1726252800000, "tokens": 50000, "cost": 0.35, "requests": 120 }],
  "daily": [{ "t": 1726166400000, "cost": 12.50 }],
  "forecast": {
    "points": [{ "t": 1726425600000, "cost": 15.20, "lo": 9.12, "hi": 24.32 }],
    "nextTotal": 106.40,
    "nextLo": 63.84,
    "nextHi": 170.24,
    "method": "四模型组合",
    "sampleDays": 35,
    "backtestWapePct": 58
  },
  "hourly": {
    "past": [{ "t": 1726252800000, "cost": 0.35 }],
    "next": [{ "t": 1726342800000, "cost": 0.42, "lo": 0.21, "hi": 0.84 }],
    "next24Total": 10.50,
    "backtestWapePct": 60,
    "todaySoFar": 8.50,
    "todayEst": 12.30
  },
  "profit": {
    "incomeUsd": 45.00,
    "incomeCny": 324.00,
    "costUsd": 30.00,
    "costCny": 216.00,
    "resoldIncomeUsd": 5.00,
    "resoldIncomeCny": 36.00,
    "grossProfitCny": 144.00,
    "grossProfitMarginPct": 44.4,
    "fixedCostCny": 30.00,
    "netProfitCny": 114.00,
    "netProfitMarginPct": 35.2
  },
  "generatedAt": "2026-09-14T06:55:00.000Z"
}
```

**缓存**：同 `(range, tz)` 组合缓存 120 秒。

### `GET /api/own/audit`

「我的站点」日志精算（消费日志明细翻页）。

**参数**：通过 query string 传入 `startMs`, `endMs`, `model`, `username`, `group`, `maxRows`, `longContextTokens`

**响应**：见 `lib/providers.js::queryOwnLogAudit` 返回形状。

---

## 7. 认证

### `POST /api/auth/login`

**无需会话**

**请求体**：
```json
{ "username": "admin", "password": "admin123" }
```

**响应**：
```json
{ "ok": true, "username": "admin", "isDefaultPassword": true }
```

**头部**：`Set-Cookie: fa_session=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`

### `POST /api/auth/logout`

**响应**：`200 { ok: true }`，头部清除 Cookie（`Max-Age=0`）。

### `GET /api/auth/me`

**响应**：`200 { username: "admin", isDefaultPassword: false }`

### `PUT /api/auth/password`

修改面板密码。

**请求体**：
```json
{ "current": "admin123", "next": "newpassword456" }
```

**响应**：`200 { ok: true }`

---

## 8. 设置

### `PUT /api/settings`

更新全局设置。

**请求体**（字段级更新）：
```json
{
  "refreshIntervalSec": 60,
  "lowBalanceUsd": 5,
  "dailyReport": { "enabled": true, "time": "09:00", "channelIds": ["ch_xxx"] }
}
```

**响应**：`200 { settings: <完整设置对象> }`

**行为**：刷新间隔变化后自动重启轮询定时器，并立即执行一轮全量刷新。

---

## 9. 通知

### `GET /api/notifications`

获取通知配置（渠道 + 规则）。

**响应**：
```json
{
  "channels": [ /* Channel 数组 */ ],
  "rules": { /* Rules 对象 */ }
}
```

### `POST /api/notifications/channels`

新增通知渠道。

**请求体**：
```json
{ "type": "webhook", "name": "企业微信", "enabled": true, "config": { "url": "https://qyapi.weixin.qq.com/..." } }
```

**响应**：`200 { channel: <完整 Channel> }`

### `PUT /api/notifications/channels/:id`

编辑通知渠道。`config` 字段级合并，空字符串表示保留原值（前端编辑时不回显密钥的约定）。

### `DELETE /api/notifications/channels/:id`

删除通知渠道，同步清理所有 rules.channelsFor 中的绑定。

### `PUT /api/notifications/rules`

更新告警规则。

**请求体**（字段级更新）：
```json
{
  "onLow": true,
  "onExhaust": true,
  "onError": true,
  "onRecover": true,
  "onEta": true,
  "etaDays": 3,
  "renotifyHours": 24,
  "errorThreshold": 1,
  "errorRetrySec": 30,
  "channelsFor": { "low": ["ch_xxx"], "exhaust": [], "error": [], "recover": [], "eta": [] }
}
```

**响应**：`200 { rules: <完整 Rules> }`

### `POST /api/notifications/test`

发送测试通知到所有启用渠道。

**响应**：`200 { results: [{ name, ok, error }] }`

---

## 10. 日报

### `GET /api/report/preview`

预览今日日报内容（不发送）。

**响应**：`200 { html: "<html>...</html>", text: "纯文本版" }`

### `POST /api/report/send`

立即发送日报。

**响应**：`200 { ok: true, sentAt: "..." }`

---

## 11. 元信息

### `GET /api/meta`

获取应用元信息（需登录）。

**响应**：
```json
{
  "types": [
    { "value": "newapi", "label": "New API（访问令牌）", "needs": ["accessToken", "userId"] },
    ...
  ],
  "channelTypes": [ /* 通知渠道类型列表 */ ],
  "settings": { /* 当前全局设置 */ },
  "rules": { /* 当前告警规则 */ },
  "app": { "version": "2.3.0", "commit": "a1b2c3d" }
}
```
