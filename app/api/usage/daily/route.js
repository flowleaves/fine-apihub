// GET /api/usage/daily?days=90[&stationId=st_xxx]
// 读取**本地落库**的每日用量（usage_points）——不受上游保留期限制。
// 与 /api/usage 的区别：/api/usage 每次实时问上游（精确但只覆盖上游窗口）；
// 本接口读本地历史（由刷新流程每小时采样一次累积而来）。
import { withAuth, json } from "../../../../lib/api.js";
import { queryDailyUsage } from "../../../../db/usage.js";
import { dateStrInTz } from "../../../../lib/providers.js";
import { REPORT_TIME_ZONE } from "../../../../server/report.js";

const MAX_DAYS = 400;
const r4 = (v) => Math.round(v * 10000) / 10000;
const r2 = (v) => Math.round(v * 100) / 100;

export const GET = withAuth(async (request, rt) => {
  const sp = new URL(request.url).searchParams;
  let days = Math.floor(Number(sp.get("days")));
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) days = 90;

  const tz = REPORT_TIME_ZONE;
  const now = Date.now();
  const to = dateStrInTz(now, tz);
  const from = dateStrInTz(now - (days - 1) * 86400000, tz);

  const stations = rt.store.list();
  const byId = new Map(stations.map((s) => [s.id, s]));
  const only = String(sp.get("stationId") || "").trim();
  // 只查仍然存在的站点（已删除站点的残留行不返回）
  const ids = (only ? stations.filter((s) => s.id === only) : stations).map((s) => s.id);

  const rows = (await queryDailyUsage(rt.pool, { stationIds: ids, from, to }))
    .filter((r) => byId.has(r.stationId));

  // 分站聚合 + 全站按日合计
  const perStation = new Map();
  const perDay = new Map();
  for (const r of rows) {
    const s = byId.get(r.stationId);
    const rate = s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1;
    const st = perStation.get(r.stationId) || {
      id: s.id, name: s.name, type: s.type, isOwn: !!s.isOwn, cnyPerUsd: s.cnyPerUsd ?? null,
      costUsd: 0, tokens: 0, requests: 0, days: 0,
    };
    st.costUsd += r.costUsd; st.tokens += r.tokens; st.requests += r.requests; st.days += 1;
    perStation.set(r.stationId, st);

    const d = perDay.get(r.date) || { date: r.date, costUsd: 0, costCny: 0 };
    d.costUsd += r.costUsd;
    d.costCny += r.costUsd * rate;
    perDay.set(r.date, d);
  }

  return json({
    days,
    from,
    to,
    tz,
    maxDays: MAX_DAYS,
    // 采样说明：本表由刷新流程每小时采样「当天」累积，不回溯；超出上游保留期的历史只有落库后才有
    note: "本地采样数据（每站每小时一次，只写当天）。启用前或超出上游窗口的日期不会有记录，缺失=未采样，不代表花费为 0。",
    rows,
    stations: [...perStation.values()]
      .map((s) => ({ ...s, costUsd: r4(s.costUsd), costCny: r2(s.costUsd * (s.cnyPerUsd ?? 1)) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    daily: [...perDay.values()]
      .map((d) => ({ date: d.date, costUsd: r4(d.costUsd), costCny: r2(d.costCny) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    generatedAt: new Date().toISOString(),
  });
});
