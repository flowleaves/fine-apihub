// 经营分析聚合的口径一致性测试。
//
// 背景：原实现用 MySQL 的 LAG() 窗口函数 + DATE_FORMAT/WEEKDAY/HOUR 在 SQL 里做聚合。
// 换 SQLite 后搬到 Node 侧（app/api/analytics/route.js 的 collectDrops）。
// 本测试把「SQL 语义」用独立实现写出来做交叉验证，防止搬迁过程中口径悄悄漂移。
//
// 对照基准（来自改造前的 DROPS_SQL + GROUP BY）：
//   · 取每站全量快照的相邻差值，只统计**下降**（prev > remaining），上升（充值）忽略
//   · 下降归属到**后一个快照**的时间
//   · 日期按本地自然日、星期按 0=周一…6=周日、小时按本地小时
//   · 只用 t >= cutoff 过滤归属时间（不在算差值时截窗，这样窗口首个快照能接住边界前的下降）
import test from "node:test";
import assert from "node:assert/strict";

// ---- 被测逻辑：与 route.js 中的 collectDrops 保持一致 -------------------------
const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const weekdayOf = (d) => (d.getDay() + 6) % 7;

function collectDrops(historyData, cutoff) {
  const daily = new Map();
  const heat = new Map();
  for (const [stationId, points] of Object.entries(historyData)) {
    if (!Array.isArray(points) || points.length < 2) continue;
    for (let i = 1; i < points.length; i++) {
      const t = points[i][0];
      if (t < cutoff) continue;
      const drop = points[i - 1][1] - points[i][1];
      if (!(drop > 0)) continue;
      const d = new Date(t);
      const dk = `${dayKey(d)}|${stationId}`;
      daily.set(dk, (daily.get(dk) || 0) + drop);
      const hk = `${weekdayOf(d)}|${d.getHours()}|${stationId}`;
      heat.set(hk, (heat.get(hk) || 0) + drop);
    }
  }
  return { daily, heat };
}

// ---- 参照实现：直译改造前的 SQL 语义（独立写法，不共用被测代码）----------------------
function referenceAggregate(rows, cutoff) {
  // rows: [{station_id, t, remaining}]，模拟 history_points 全表
  const byStation = new Map();
  for (const r of rows) {
    (byStation.get(r.station_id) || byStation.set(r.station_id, []).get(r.station_id)).push(r);
  }
  const daily = new Map();
  const heat = new Map();
  for (const [sid, arr] of byStation) {
    // LAG(remaining) OVER (PARTITION BY station_id ORDER BY t)
    arr.sort((a, b) => a.t - b.t);
    for (let i = 0; i < arr.length; i++) {
      const prev = i === 0 ? null : arr[i - 1].remaining;
      const cur = arr[i];
      // WHERE t >= ? AND prev IS NOT NULL AND prev > remaining
      if (!(cur.t >= cutoff) || prev === null || !(prev > cur.remaining)) continue;
      const usd = prev - cur.remaining;
      const d = new Date(cur.t);
      const dk = `${dayKey(d)}|${sid}`;
      daily.set(dk, (daily.get(dk) || 0) + usd);
      const hk = `${weekdayOf(d)}|${d.getHours()}|${sid}`;
      heat.set(hk, (heat.get(hk) || 0) + usd);
    }
  }
  return { daily, heat };
}

// 构造一份含各种边界的测试数据
function buildFixture() {
  const now = Date.now();
  const H = 3600000;
  const points = [];
  // 站点 A：正常下降 + 一次充值（上升）+ 一次持平
  const a = [
    [now - 10 * H, 100],
    [now - 9 * H, 97],   // -3
    [now - 8 * H, 94],   // -3
    [now - 7 * H, 120],  // 充值，忽略，且成为下一段的 prev
    [now - 6 * H, 115],  // -5
    [now - 5 * H, 115],  // 持平，忽略
    [now - 4 * H, 110],  // -5
  ];
  // 站点 B：仅两个点，一次下降
  const b = [
    [now - 3 * H, 50],
    [now - 2 * H, 41.5], // -8.5
  ];
  // 站点 C：单点，不足 2 个应被跳过
  const c = [[now - 1 * H, 10]];
  // 站点 D：跨日边界（本地日界前的下降）
  const d = [
    [now - 26 * H, 30],
    [now - 25 * H, 28],  // -2
  ];
  for (const [station, arr] of [["stA", a], ["stB", b], ["stC", c], ["stD", d]]) {
    for (const [t, remaining] of arr) points.push({ station_id: station, t, remaining });
  }
  return points;
}

test("Node 侧聚合与改造前 SQL 语义完全一致", () => {
  const rows = buildFixture();
  const cutoff = Date.now() - 30 * 3600000; // 30 小时窗口

  // 被测逻辑的输入形状：{ stationId: [[t, remaining, used], ...] }
  const historyData = {};
  for (const r of rows) {
    (historyData[r.station_id] ||= []).push([r.t, r.remaining, 0]);
  }
  for (const arr of Object.values(historyData)) arr.sort((x, y) => x[0] - y[0]);

  const got = collectDrops(historyData, cutoff);
  const want = referenceAggregate(rows, cutoff);

  // 两边的键集合与数值都必须一致
  assert.deepEqual([...got.daily.keys()].sort(), [...want.daily.keys()].sort(),
    "每日聚合的键集合应与 SQL 语义一致");
  for (const k of want.daily.keys()) {
    assert.equal(Math.round(got.daily.get(k) * 1e6) / 1e6,
      Math.round(want.daily.get(k) * 1e6) / 1e6, `每日聚合 ${k} 数值应一致`);
  }
  assert.deepEqual([...got.heat.keys()].sort(), [...want.heat.keys()].sort(),
    "热力图聚合的键集合应与 SQL 语义一致");
  for (const k of want.heat.keys()) {
    assert.equal(Math.round(got.heat.get(k) * 1e6) / 1e6,
      Math.round(want.heat.get(k) * 1e6) / 1e6, `热力图 ${k} 数值应一致`);
  }
});

test("充值（余额上升）不计入消耗", () => {
  const now = Date.now();
  const H = 3600000;
  const historyData = {
    stA: [
      [now - 3 * H, 100],
      [now - 2 * H, 90],   // -10 计入
      [now - 1 * H, 200],  // 充值，忽略
    ],
  };
  const { daily } = collectDrops(historyData, now - 4 * H);
  const total = [...daily.values()].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 100) / 100, 10, "只应统计充值前的 10");
});

test("窗口边界前的下降被接住（不在算差值时截窗）", () => {
  const now = Date.now();
  const H = 3600000;
  // 快照 1 在窗口外，快照 2 在窗口内：这 -7 的下降归属到窗口内的快照 2，应被统计
  const historyData = {
    stA: [
      [now - 10 * H, 100],  // 窗口外
      [now - 1 * H, 93],    // 窗口内，承接下降 -7
    ],
  };
  const { daily } = collectDrops(historyData, now - 2 * H);
  const total = [...daily.values()].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 100) / 100, 7,
    "窗口首个快照应能接住边界前的最后一笔下降（与改造前 SQL 的 LAG 全表语义一致）");
});

test("单点站点与非法输入不产生数据", () => {
  const now = Date.now();
  const { daily, heat } = collectDrops({
    stOnly: [[now - 1000, 5]],
    stEmpty: [],
    stBad: "not-an-array",
  }, now - 3600000);
  assert.equal(daily.size, 0);
  assert.equal(heat.size, 0);
});

test("星期分桶遵循 0=周一 口径", () => {
  // 2026-09-14 是周一
  const monday = new Date(2026, 8, 14, 10, 0, 0).getTime();
  const sunday = new Date(2026, 8, 20, 10, 0, 0).getTime();
  const historyData = {
    stA: [
      [monday - 3600000, 10],
      [monday, 9],          // 周一 10 点 → weekday 0
      [sunday - 3600000, 9],
      [sunday, 8],          // 周日 10 点 → weekday 6
    ],
  };
  const { heat } = collectDrops(historyData, monday - 7200000);
  assert.ok(heat.has("0|10|stA"), "周一应记为 weekday=0");
  assert.ok(heat.has("6|10|stA"), "周日应记为 weekday=6");
});
