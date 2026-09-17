# Sub2API Key 用量统计

## 范围

fine 仅对 Sub2API 站点提供按 API Key 的用量统计；NewAPI 普通用户令牌不纳入本功能。

## 接口

`GET /api/stations/:id/keys/usage?range=today|24h|7d|30d`

该接口要求 fine 登录，并要求站点凭证对应 Sub2API 管理员账号。响应只返回 Key ID、名称和统计值，不返回完整 API Key 或 JWT。

## 数据口径

- `actualCost`：Sub2API `usage_logs.actual_cost`，作为用户实际消费金额。
- `totalCost`：Sub2API `usage_logs.total_cost`，作为内部成本参考。
- `totalTokens`：输入、输出、缓存 Token 合计。
- `coveragePct`：当前实现基于已枚举 Key 的统计覆盖率；没有 Key 归属的历史日志不应被默认为零。

Sub2API 的批量管理员接口当前以供应商默认时间窗返回统计（当前版本为最近 30 天总计与今日），因此接口同时返回 `requestedRange` 和 `effectiveRange`，调用方不得将非精确窗口误标为精确数据。

## 权限与安全

- 普通 Sub2API 用户凭证只能访问自己的 Key，不用于站点级统计。
- 管理员权限不足时返回 403。
- Key 统计请求绑定站点 ID，禁止跨站点查询。
- 不记录或返回完整访问令牌、Key 原文。
