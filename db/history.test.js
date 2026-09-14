// History 的持久化与算法测试。
//
// 改造前这个模块完全没有测试（原 4 个测试文件里没有它），
// 而它负责的是「余额历史 → 消耗推算 → 耗尽预测」，是告警与日报的数据基础。
// 换 SQLite 后顺手补上：既覆盖攒批写透的往返，也锁住预测算法的关键性质。
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, ensureSchema, _resetForTest } from "./pool.js";
import { History } from "./history.js";

async function freshHistory() {
  _resetForTest();
  process.env.DB_PATH = ":memory:";
  const pool = getPool();
  await ensureSchema(pool);
  const history = await new History(pool).load();
  return { pool, history };
}

// 直接把点压入内存与待写队列，绕开 append 的 30 秒最小间隔（便于构造时间序列）
function seed(history, stationId, points) {
  history.data[stationId] = points.map(([t, r, u]) => [t, r, u ?? 0]);
  for (const [t, r, u] of points) history._pending.push([stationId, t, r, u ?? 0]);
}

test("append 尊重最小间隔，避免同一秒堆点", async () => {
  const { history } = await freshHistory();
  history.append("stA", 100, 0);
  history.append("stA", 99, 1); // 距上一个点不足 30 秒，应被丢弃
  assert.equal(history.data.stA.length, 1, "30 秒内的第二个点不应入库");
});

test("攒批写透后重新 load 数据一致（round-trip）", async () => {
  const { pool, history } = await freshHistory();
  const now = Date.now();
  const pts = [
    [now - 3 * 3600000, 100, 0],
    [now - 2 * 3600000, 95, 5],
    [now - 1 * 3600000, 90, 10],
  ];
  seed(history, "stA", pts);
  history.scheduleSave();
  await new Promise((r) => setTimeout(r, 2000));

  const reloaded = await new History(pool).load();
  assert.deepEqual(reloaded.data.stA, pts, "内存 → 库 → 内存应逐点一致");
});

test("remove 会同时清掉内存与库里的历史", async () => {
  const { pool, history } = await freshHistory();
  seed(history, "stA", [[Date.now() - 3600000, 50, 0], [Date.now(), 45, 5]]);
  history.scheduleSave();
  await new Promise((r) => setTimeout(r, 2000));

  history.remove("stA");
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(history.data.stA, undefined);
  const [rows] = await pool.query("SELECT station_id FROM history_points WHERE station_id = ?", ["stA"]);
  assert.equal(rows.length, 0, "库里的行也应被删除");
});

test("usedSince 累加余额下降并忽略充值", async () => {
  const { history } = await freshHistory();
  const now = Date.now();
  const H = 3600000;
  seed(history, "stA", [
    [now - 5 * H, 100, 0],
    [now - 4 * H, 90, 10],   // -10
    [now - 3 * H, 150, 10],  // 充值 +60，忽略
    [now - 2 * H, 145, 15],  // -5
    [now - 1 * H, 140, 20],  // -5
  ]);
  // 从最早点起算：只统计两次下降（10 + 5 + 5 = 20）
  assert.equal(history.usedSince("stA", now - 6 * H), 20);
  // 从充值点之后起算：只统计充值后的 5 + 5
  assert.equal(history.usedSince("stA", now - 2.5 * H), 10);
});

test("burnRate 在点不足时返回 null", async () => {
  const { history } = await freshHistory();
  assert.equal(history.burnRate("nonexistent", 3), null, "无数据站点应返回 null");
  const now = Date.now();
  seed(history, "stA", [[now - 60000, 100, 0], [now, 99, 1]]);
  assert.equal(history.burnRate("stA", 3, 1, 5), null, "点数少于 minPoints 应返回 null");
});

test("predict 按余额与速率给出耗尽天数", async () => {
  const { history } = await freshHistory();
  const now = Date.now();
  const H = 3600000;
  const pts = [];
  // 每小时下降 2 美元，当前余额 100 → 约 50 天
  for (let i = 0; i <= 6; i++) pts.push([now - (6 - i) * H, 100 + (6 - i) * 2, (6 - i) * 2]);
  seed(history, "stA", pts);
  const p = history.predict("stA");
  assert.ok(p, "应能给出预测");
  assert.ok(Math.abs(p.burnPerDay - 48) < 1, `日均消耗应约 48，实际 ${p.burnPerDay}`);
  assert.ok(Math.abs(p.etaDays - 100 / 48) < 1, `耗尽天数应约 2.1，实际 ${p.etaDays}`);
});

test("predict 在余额为零或消耗为零时不给出误报的耗尽时间", async () => {
  const { history } = await freshHistory();
  const now = Date.now();
  const H = 3600000;
  // 余额恒定不下降 → burnPerDay 为 0，不应给出 etaDays
  const pts = [];
  for (let i = 0; i <= 6; i++) pts.push([now - (6 - i) * H, 100, 0]);
  seed(history, "stA", pts);
  const p = history.predict("stA");
  if (p) assert.equal(p.etaDays, null, "无消耗时不应报告耗尽天数");
});

test("sparkline 抽样不改变时间顺序且保留最后一个点", async () => {
  const { history } = await freshHistory();
  const now = Date.now();
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push([now - (100 - i) * 60000, 100 - i, i]);
  seed(history, "stA", pts);
  const line = history.sparkline("stA", 48, 10);
  assert.ok(line.length <= 11, "抽样点数应受 maxPoints 约束");
  const times = line.map((p) => p[0]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "时间必须升序");
  assert.equal(line[line.length - 1][0], pts[pts.length - 1][0], "应保留最后一个点");
});

test("load 只读保留窗口内的点（30 天）", async () => {
  const { pool } = await freshHistory();
  const now = Date.now();
  const old = now - 40 * 24 * 3600000; // 40 天前，超出保留窗口
  await pool.query("INSERT INTO history_points (station_id, t, remaining, used) VALUES (?, ?, ?, ?)", ["stA", old, 100, 0]);
  await pool.query("INSERT INTO history_points (station_id, t, remaining, used) VALUES (?, ?, ?, ?)", ["stA", now, 90, 10]);

  const history = await new History(pool).load();
  assert.equal(history.data.stA.length, 1, "超窗的点不应载入内存");
  assert.equal(history.data.stA[0][1], 90);
});
