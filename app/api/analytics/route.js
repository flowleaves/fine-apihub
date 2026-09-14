// ---- 经营分析：基于余额历史快照的聚合（Node 侧计算）----------------------------------
// GET /api/analytics?days=30
// 消耗口径与 History.usedSince 一致：相邻快照余额下降计消耗，上升视为充值忽略。
//
// 【为什么不用 SQL 聚合】原实现走 MySQL 的 LAG() 窗口函数 + FROM_UNIXTIME / DATE_FORMAT /
// WEEKDAY / HOUR 分桶。换 SQLite 后这些函数要么没有、要么时区语义不同（MySQL 走会话时区，
// SQLite 的 'localtime' 走进程 TZ），两边口径极易漂移。而 history.data 已经把窗口内全量快照
// 加载在内存里（每站最多 5000 点），Node 侧遍历是微秒级——所以这里统一搬到 Node 侧，
// 顺带让本页与 History.usedSince / sparkline 共用同一套时间与口径，杜绝「同一数字两处不一致」。
//
// 分桶时区：与 History / 前端一致，按**服务器本地时区**切自然日与小时
//（与改造前 MySQL 会话时区同为「面板所在机器本地时区」，行为等价）。
import { withAuth, json } from "../../../lib/api.js";
import { fixedPurchases } from "../../../lib/providers.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const pad2 = (n) => String(n).padStart(2, "0");
// 本地时区的 YYYY-MM-DD
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// WEEKDAY() 口径：0=周一 … 6=周日（JS getDay() 是 0=周日，需平移）
const weekdayOf = (d) => (d.getDay() + 6) % 7;

/**
 * 汇总窗口内的余额下降事件。
 * 逐站遍历内存快照，把「相邻两点的下降」按**后一点**的时间归属到 (日期, 站点) 与 (星期, 小时, 站点)。
 * 注意与改造前的 SQL 语义保持一致：取全量快照算下降（不在子查询内截窗），
 * 只用 `t >= cutoff` 过滤下降事件的归属日——这样窗口首个快照能接住边界前的最后一笔下降。
 */
function collectDrops(historyData, cutoff) {
  const daily = new Map(); // "date|stationId" -> usd
  const heat = new Map();   // "weekday|hour|stationId" -> usd
  for (const [stationId, points] of Object.entries(historyData)) {
    if (!Array.isArray(points) || points.length < 2) continue;
    for (let i = 1; i < points.length; i++) {
      const t = points[i][0];
      if (t < cutoff) continue;
      const drop = points[i - 1][1] - points[i][1];
      // 上升视为充值，忽略；零变化不计
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

export const GET = withAuth(async (request, rt) => {
  const { store, history } = rt;
  const sp = new URL(request.url).searchParams;
  let days = Math.floor(Number(sp.get("days")));
  if (!Number.isFinite(days) || days < 1 || days > 30) days = 30;

  // 窗口 = 今天（本地自然日）往前共 days 天，起点取本地零点
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const cutoff = startDate.getTime();

  const { daily: dailyMap, heat: heatMapRaw } = collectDrops(history.data, cutoff);

  // 站点文档：汇率折算 + 固定成本 + 跑道预测（已删除站点的残留行直接跳过）
  const stations = store.list();
  const byId = new Map(stations.map((s) => [s.id, s]));
  const rateOf = (s) => (s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

  const daily = [];
  const totalUsd = new Map(); // stationId -> 窗口内合计消耗（$）
  // 按日期、站点稳定排序（等价原 SQL 的 ORDER BY date, stationId）
  const dailyKeys = [...dailyMap.keys()].sort((a, b) => {
    const [da, sa] = a.split("|");
    const [db, sb] = b.split("|");
    return da === db ? (sa < sb ? -1 : sa > sb ? 1 : 0) : (da < db ? -1 : 1);
  });
  for (const key of dailyKeys) {
    const idx = key.indexOf("|");
    const date = key.slice(0, idx);
    const stationId = key.slice(idx + 1);
    const s = byId.get(stationId);
    if (!s) continue;
    const usd = dailyMap.get(key);
    daily.push({ date, stationId, usd: r4(usd), cny: r2(usd * rateOf(s)) });
    totalUsd.set(stationId, (totalUsd.get(stationId) || 0) + usd);
  }

  // 热力图跨站合计（¥）
  const heatMap = new Map(); // "weekday|hour" -> cny
  for (const [key, usd] of heatMapRaw) {
    const parts = key.split("|");
    const stationId = parts[2];
    const s = byId.get(stationId);
    if (!s || s.isOwn || s.includeInProfit === false) continue;
    const k = `${parts[0]}|${parts[1]}`;
    heatMap.set(k, (heatMap.get(k) || 0) + usd * rateOf(s));
  }
  const heatmap = [...heatMap.entries()].map(([k, cny]) => {
    const [weekday, hour] = k.split("|").map(Number);
    return { weekday, hour, cny: r2(cny) };
  });

  // 固定成本日摊销：每笔付费 金额÷天数，摊到 [购买日, 购买日+天数) 与窗口的重叠日；
  // 没填日期的按常驻成本全窗口摊销（口径与 own-helpers.computeProfit 一致）
  const fixedDaily = [];
  const fixedTotal = new Map(); // stationId -> 窗口内固定摊销合计（¥）
  const dayList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    dayList.push({ date: dayKey(d), ms: d.getTime() });
  }
  for (const s of stations) {
    const purchases = fixedPurchases(s);
    if (!purchases.length) continue;
    for (const { date, ms } of dayList) {
      let cny = 0;
      for (const p of purchases) {
        if (!(p.amount > 0) || !(p.days > 0)) continue;
        if (p.startDate) {
          const [y, m, d] = p.startDate.split("-").map(Number);
          const st = new Date(y, m - 1, d).getTime();
          if (ms < st || ms >= st + p.days * 86400000) continue;
        }
        cny += p.amount / p.days;
      }
      if (cny > 0) {
        fixedDaily.push({ date, stationId: s.id, cny: r2(cny) });
        fixedTotal.set(s.id, (fixedTotal.get(s.id) || 0) + cny);
      }
    }
  }

  // 每站汇总：合计消耗 + 固定摊销 + 余额跑道（etaDays/burnPerDay，数据不足为 null）
  const outStations = stations.map((s) => {
    const usd = totalUsd.get(s.id) || 0;
    const p = history.predict(s.id);
    return {
      id: s.id,
      name: s.name,
      isOwn: !!s.isOwn,
      includeInProfit: s.includeInProfit !== false,
      cnyPerUsd: s.cnyPerUsd ?? null,
      totalUsd: r4(usd),
      totalCny: r2(usd * rateOf(s)),
      fixedCny: r2(fixedTotal.get(s.id) || 0),
      runway: p ? { etaDays: p.etaDays, burnPerDay: p.burnPerDay, basis: p.basis } : null,
    };
  });

  return json({
    days,
    start: dayList[0].date,
    end: dayList[dayList.length - 1].date,
    stations: outStations,
    daily,
    fixedDaily,
    heatmap,
    generatedAt: new Date().toISOString(),
  });
});
