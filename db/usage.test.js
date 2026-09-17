// usage_points（每日用量落库）测试：用真实 SQLite 内存库跑，顺带验证 upsert 的方言转写。
// 注意：这里用的 SQL 是 MySQL 的 `ON DUPLICATE KEY UPDATE ... VALUES(col)` 写法，
// 由 db/pool.js 转成 SQLite 的 `ON CONFLICT DO UPDATE SET ... excluded.col`——
// 本文件能过就说明这条转写在两个驱动间是等效的。
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, ensureSchema, _resetForTest } from "./pool.js";
import { upsertUsagePoint, queryDailyUsage, pruneUsage } from "./usage.js";

async function freshPool() {
  _resetForTest();
  process.env.DB_PATH = ":memory:";
  const pool = getPool();
  await ensureSchema(pool);
  return pool;
}

test("同一天重复采样是幂等 upsert，不会产生重复行（花费用最新值覆盖）", async () => {
  const pool = await freshPool();
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-17", costUsd: 10.5, tokens: 100, requests: 2, source: "v1" });
  // 当天累计值会增长：再采一次应覆盖，而不是插入第二行
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-17", costUsd: 12.75, tokens: 130, requests: 3, source: "v2" });

  const rows = await queryDailyUsage(pool, { stationIds: ["st_a"], from: "2026-09-01", to: "2026-09-30" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costUsd, 12.75);
  assert.equal(rows[0].tokens, 130);
  assert.equal(rows[0].requests, 3);
  assert.equal(rows[0].source, "v2");
});

test("按日期区间与站点筛选，并按日期升序返回", async () => {
  const pool = await freshPool();
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-16", costUsd: 1 });
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-17", costUsd: 2 });
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-18", costUsd: 3 });
  await upsertUsagePoint(pool, { stationId: "st_b", date: "2026-09-17", costUsd: 9 });

  const rows = await queryDailyUsage(pool, { stationIds: ["st_a", "st_b"], from: "2026-09-17", to: "2026-09-17" });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.stationId), ["st_a", "st_b"]); // 同日期按站点排序

  const onlyA = await queryDailyUsage(pool, { stationIds: ["st_a"], from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(onlyA.map((r) => r.date), ["2026-09-16", "2026-09-17", "2026-09-18"]);

  // 空站点列表直接返回空，不发查询
  assert.deepEqual(await queryDailyUsage(pool, { stationIds: [], from: "2026-01-01", to: "2026-12-31" }), []);
});

test("裁剪保留窗口外的行", async () => {
  const pool = await freshPool();
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2025-01-01", costUsd: 1 });
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-17", costUsd: 2 });
  const removed = await pruneUsage(pool, "2026-01-01");
  assert.equal(removed, 1);
  const rows = await queryDailyUsage(pool, { stationIds: ["st_a"], from: "2000-01-01", to: "2099-12-31" });
  assert.deepEqual(rows.map((r) => r.date), ["2026-09-17"]);
});

test("非法数值归 0，不会把 NaN 写进库", async () => {
  const pool = await freshPool();
  await upsertUsagePoint(pool, { stationId: "st_a", date: "2026-09-17", costUsd: NaN, tokens: undefined, requests: "abc", source: null });
  const [row] = await queryDailyUsage(pool, { stationIds: ["st_a"], from: "2026-09-17", to: "2026-09-17" });
  assert.equal(row.costUsd, 0);
  assert.equal(row.tokens, 0);
  assert.equal(row.requests, 0);
  assert.equal(row.source, "");
});
