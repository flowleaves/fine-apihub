// GET /api/calendar?month=YYYY-MM&tz=Asia/Shanghai
// 月历数据：该月每天每站的消耗（上游权威口径）+ 今天的逐小时实时消耗。
//
// 口径与保留期（2026-09-17 实测）：
//   · new-api   /api/data/self 给小时行 → 按 tz 分桶成日；上游硬限「跨度 ≤1 个月」，保留约 20 天
//   · Sub2API   snapshot-v2?granularity=day 直接给日行（actual_cost）；保留约 23~30 天，未来日期不返回
//   因此超出上游保留期的日期会**留空**，响应用 coverageFrom / notes 如实说明，不用 0 冒充「没花钱」。
import { withAuth, json } from "../../../lib/api.js";
import { queryDailyCost } from "../../../lib/providers.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const pad2 = (n) => String(n).padStart(2, "0");

// 在指定时区把 "YYYY-MM" 解析成该月首日零点 / 次月首日零点（毫秒）
function monthWindow(month, tz) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  // 用「该月 1 日 00:00 在 tz 的 UTC 时刻」：先取 UTC 零点，再用 tz 偏移校正
  const guess = Date.UTC(year, mon - 1, 1, 0, 0, 0);
  const offset = tzOffset(tz, guess);
  const start = guess - offset;
  const nextGuess = Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1, 0, 0, 0);
  const end = nextGuess - tzOffset(tz, nextGuess);
  return { start, end, days: Math.round((end - start) / 86400000), year, mon };
}

function tzOffset(tz, at) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (k) => Number(p.find((x) => x.type === k).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

function monthDays(year, mon) {
  const out = [];
  const n = new Date(Date.UTC(year, mon, 0)).getUTCDate(); // 该月天数
  for (let d = 1; d <= n; d++) out.push(`${year}-${pad2(mon)}-${pad2(d)}`);
  return out;
}

export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const sp = new URL(request.url).searchParams;

  let tz = String(sp.get("tz") || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const now = new Date();
  const defMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const win = monthWindow(sp.get("month") || defMonth, tz);
  if (!win) return json({ error: "month 参数格式应为 YYYY-MM" }, 400);

  const cacheKey = `${sp.get("month") || defMonth}|${tz}`;
  const cache = (rt._calCache ||= new Map());
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60000) return json(hit.payload);

  const todayLabel = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const endMs = Math.min(win.end, Date.now()); // 未来日期无意义，窗口止于现在
  const startMs = win.start;

  const stations = await Promise.all(
    store.list().filter((s) => s.type !== "fixed").map(async (s) => {
      const meta = {
        id: s.id, name: s.name, type: s.type,
        cnyPerUsd: s.cnyPerUsd ?? null, isOwn: !!s.isOwn,
      };
      try {
        const d = await queryDailyCost(s, { startMs, endMs, tz });
        const totalUsd = d.days.reduce((a, x) => a + x.usd, 0);
        return {
          ...meta, ok: true, available: d.available, reason: d.reason ?? null,
          source: d.source, coverageFrom: d.coverageFrom ?? null,
          totalUsd: r4(totalUsd),
          totalCny: r2(totalUsd * (s.cnyPerUsd && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1)),
          days: d.days.map((x) => ({ ...x, usd: r4(x.usd) })),
          hours: d.hours.map((x) => ({ t: x.t, usd: r4(x.usd) })),
          todayUsd: r4(d.todayUsd ?? 0),
        };
      } catch (err) {
        return { ...meta, ok: false, available: false, error: err?.message || String(err), days: [], hours: [], totalUsd: 0, todayUsd: 0 };
      }
    })
  );
  await store.save(); // Sub2API 密码模式可能在查询中轮换了令牌

  // 全站按日合计（只统计 ok 的站点）
  const byDate = new Map();
  for (const st of stations) {
    if (!st.ok) continue;
    for (const d of st.days) {
      const cur = byDate.get(d.date) || { date: d.date, usd: 0, cny: 0, tokens: 0, requests: 0 };
      cur.usd += d.usd;
      cur.cny += d.usd * (st.cnyPerUsd && st.cnyPerUsd > 0 ? st.cnyPerUsd : 1);
      cur.tokens += d.tokens;
      cur.requests += d.requests;
      byDate.set(d.date, cur);
    }
  }
  const daily = [...byDate.values()]
    .map((d) => ({ date: d.date, usd: r4(d.usd), cny: r2(d.cny), tokens: d.tokens, requests: d.requests }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // 今天逐小时合计（各站 hours 取并集后求和）
  const hourMap = new Map();
  for (const st of stations) {
    if (!st.ok) continue;
    for (const h of st.hours) hourMap.set(h.t, (hourMap.get(h.t) || 0) + h.usd);
  }
  const hours = [...hourMap.entries()].map(([t, usd]) => ({ t, usd: r4(usd) })).sort((a, b) => a.t - b.t);

  const today = daily.find((d) => d.date === todayLabel) || null;
  const coverageFrom = stations
    .map((s) => s.coverageFrom)
    .filter(Boolean)
    .sort()[0] || null;

  const payload = {
    month: `${win.year}-${pad2(win.mon)}`,
    tz,
    startMs,
    endMs,
    calendarDays: monthDays(win.year, win.mon), // 该月全部日期（不含未来）供月历铺格
    todayLabel,
    daily,
    hours,
    today: today ? { date: today.date, usd: today.usd, cny: today.cny, tokens: today.tokens, requests: today.requests } : null,
    stations,
    coverageFrom,
    notes: [
      "日粒度数据来自上游用量接口（new-api /api/data/self 按小时行分桶、Sub2API snapshot-v2 日行）",
      "上游保留期有限（实测约 20~30 天），更早日期留空而非记 0",
      coverageFrom ? `本响应中最早可查日期：${coverageFrom}` : "本次窗口内上游无数据",
    ],
    generatedAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { at: Date.now(), payload });
  return json(payload);
});
