// 每日用量落库（usage_points）：把上游的「按日花费」持久化到本地。
//
// 为什么要落库：上游用量接口的保留期很短（实测 new-api 约 20 天、Sub2API 约 23~30 天），
// 且 Sub2API 只返回「有数据」的日期。落库后历史不再受上游窗口限制，上游故障时也能回看。
//
// 采样口径（见 server/refresh.js::sampleUsageIfDue）：每站每天 1 行，只写「当天」，
// 幂等 upsert（同一天反复采到的是当天累计值，直接覆盖）；每小时最多采一次，因此
// 每个站点每小时的额外上游开销 = 1 次请求。
//
// upsert 用 MySQL 的 `ON DUPLICATE KEY UPDATE ... VALUES(col)` 写法：db/pool.js 会把它
// 转写成 SQLite 的 `ON CONFLICT DO UPDATE SET ... excluded.col`，两个驱动共用一条 SQL。
const MAX_AGE_DAYS = 400; // 保留约 13 个月，够看年度同比

export async function upsertUsagePoint(pool, { stationId, date, costUsd, tokens, requests, source }) {
  await pool.query(
    `INSERT INTO usage_points (station_id, date, cost_usd, tokens, requests, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cost_usd = VALUES(cost_usd), tokens = VALUES(tokens),
       requests = VALUES(requests), source = VALUES(source), updated_at = VALUES(updated_at)`,
    [
      String(stationId),
      String(date),
      Number(costUsd) || 0,
      Number(tokens) || 0,
      Number(requests) || 0,
      String(source || "").slice(0, 64),
      new Date().toISOString(),
    ]
  );
}

/** 按日期区间读每日用量（date 为 YYYY-MM-DD，闭区间）。stationIds 为空数组时返回空。 */
export async function queryDailyUsage(pool, { stationIds = [], from, to }) {
  if (!stationIds.length) return [];
  const [rows] = await pool.query(
    `SELECT station_id, date, cost_usd, tokens, requests, source
     FROM usage_points
     WHERE date >= ? AND date <= ? AND station_id IN (?)
     ORDER BY date, station_id`,
    [from, to, stationIds]
  );
  return rows.map((r) => ({
    stationId: r.station_id,
    date: r.date,
    costUsd: Number(r.cost_usd) || 0,
    tokens: Number(r.tokens) || 0,
    requests: Number(r.requests) || 0,
    source: r.source || "",
  }));
}

/** 裁剪保留窗口外的行（返回被删行数）。 */
export async function pruneUsage(pool, beforeDate) {
  const [res] = await pool.query("DELETE FROM usage_points WHERE date < ?", [beforeDate]);
  return Number(res?.changes ?? 0);
}

export { MAX_AGE_DAYS as USAGE_MAX_AGE_DAYS };
