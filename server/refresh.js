// 后台余额刷新循环：查询→写余额→记历史→告警评估→失败快速重试 + 定时轮询节拍。
// 平移自 v1 server.js（refreshOne/doRefreshOne/scheduleErrorRetry/refreshAll/restartPolling），
// 全局 store/history → rt.store/rt.history，模块级状态改挂 rt 字段（多实例/HMR 安全）。
import { queryStation, queryStationUsage, dateStrInTz, parseDateLabel } from "../lib/providers.js";
import { evaluateStation } from "../lib/alerts.js";
import { upsertUsagePoint, pruneUsage, USAGE_MAX_AGE_DAYS } from "../db/usage.js";
import { REPORT_TIME_ZONE } from "./report.js";

// 每日用量落库的采样间隔：每站每小时最多采一次（每次 = 1 个上游请求）
const USAGE_SAMPLE_INTERVAL_SEC = 3600;

/**
 * 把「当天的用量/花费」落库（幂等 upsert 到 usage_points）。
 * 自带小时级节流：余额每 10 分钟刷一次，但用量采样每小时才发 1 次请求。
 * 失败只记录、绝不影响余额刷新与告警。
 */
export async function sampleUsageIfDue(rt, station, { now = Date.now(), force = false } = {}) {
  if (station.type === "fixed") return { sampled: false, reason: "固定成本站点不产生用量" };
  const map = (rt._usageSampledAt ||= new Map());
  const last = map.get(station.id) || 0;
  if (!force && now - last < USAGE_SAMPLE_INTERVAL_SEC * 1000) {
    return { sampled: false, reason: "未到采样间隔", nextInSec: Math.ceil((USAGE_SAMPLE_INTERVAL_SEC * 1000 - (now - last)) / 1000) };
  }
  const tz = REPORT_TIME_ZONE;
  const today = dateStrInTz(now, tz);
  const startMs = parseDateLabel(today, tz);
  try {
    const u = await queryStationUsage(station, {
      startMs, endMs: startMs + 86400000, granularity: "day", tz, wantToday: true,
    });
    const sum = (f) => (u.summary ? u.summary[f] : u.models.reduce((a, m) => a + m[f], 0));
    const costUsd = Math.round(sum("cost") * 10000) / 10000;
    await upsertUsagePoint(rt.pool, {
      stationId: station.id, date: today,
      costUsd, tokens: sum("tokens"), requests: sum("requests"),
      source: u.modelsWindow || "usage-api",
    });
    map.set(station.id, now);
    // 顺手裁剪（每天最多跑一次）
    if (!rt._usagePrunedAt || now - rt._usagePrunedAt > 86400000) {
      rt._usagePrunedAt = now;
      await pruneUsage(rt.pool, dateStrInTz(now - USAGE_MAX_AGE_DAYS * 86400000, tz)).catch(() => {});
    }
    return { sampled: true, date: today, costUsd };
  } catch (err) {
    // 采样失败下一轮再试；不写 0，避免把「失败」记成「没花钱」
    return { sampled: false, reason: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// 余额刷新 + 历史 + 告警
// ---------------------------------------------------------------------------
// 同一站点同时只允许一个刷新在途：定时器、手动刷新、保存后刷新可能重叠，
// 并发会重复发告警、并让 Sub2API 轮换的 refresh_token 相互作废
export function refreshStation(rt, station) {
  if (station.type === "fixed") return Promise.resolve(null); // 固定成本渠道不访问任何接口
  const inflight = rt._inflightRefresh || (rt._inflightRefresh = new Map());
  const running = inflight.get(station.id);
  if (running) return running;
  const p = doRefreshOne(rt, station).finally(() => inflight.delete(station.id));
  inflight.set(station.id, p);
  return p;
}

// 查询失败后的快速重试：不等下一次轮询（可能是几分钟），隔 errorRetrySec 秒再探一次，
// 好尽快累积「连续失败」次数、达到通知阈值。只在仍失败且未达阈值时续排，天然自限。
function scheduleErrorRetry(rt, station) {
  const timers = rt._errorRetryTimers || (rt._errorRetryTimers = new Map());
  const old = timers.get(station.id);
  if (old) { clearTimeout(old); timers.delete(station.id); }

  const r = rt.store.rules || {};
  const delaySec = Number(r.errorRetrySec);
  if (!Number.isFinite(delaySec) || delaySec <= 0) return; // 0/未配置 = 关闭快速重试

  const failing = station.balance && !station.balance.ok;
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const count = station.alertState?.errorCount || 0;
  if (!failing || count >= threshold) return; // 已恢复或已达阈值（已通知）就交回常规轮询

  const t = setTimeout(() => {
    timers.delete(station.id);
    const cur = rt.store.get(station.id); // 期间可能已被删除
    if (cur) refreshStation(rt, cur).catch(() => {});
  }, delaySec * 1000);
  if (t.unref) t.unref();
  timers.set(station.id, t);
}

async function doRefreshOne(rt, station) {
  const { result } = await queryStation(station);
  // 查询在途期间站点可能已被删除：丢弃结果，避免复活历史记录或发幽灵告警
  if (!rt.store.get(station.id)) return result;
  station.balance = result;
  if (result.ok) rt.history.append(station.id, result.remaining, result.used);

  // 告警评估（异步失败不影响主流程）
  try {
    const prediction = rt.history.predict(station.id);
    const next = await evaluateStation(
      station, prediction, rt.store.rules, rt.store.channels, rt.store.settings.lowBalanceUsd
    );
    if (next) station.alertState = next;
  } catch (err) {
    console.error("告警评估失败:", err?.message);
  }

  await rt.store.save(); // balance / s2Tokens / alertState 一并落盘
  // 顺带把「今天的用量/花费」落库（自带小时级节流，内部已吞异常，不影响主流程）
  await sampleUsageIfDue(rt, station);
  scheduleErrorRetry(rt, station); // 失败未达阈值则安排一次快速重试
  return result;
}

export async function refreshAll(rt, { scope = "all" } = {}) {
  return Promise.all(stationsForScope(rt.store.list(), scope).map((s) => refreshStation(rt, s)));
}

/**
 * 按「归属」筛选要刷新的站点：
 *   others = 其它站点（非 isOwn）：走常规定时轮询，固定间隔
 *   own    = 我的站点（isOwn）：生产站，只在相关页面在使用时按 ownRefreshIntervalSec 节流刷新
 *   all    = 全部（手动刷新 / 启动首刷，不受节流限制）
 */
export function stationsForScope(stations, scope = "all") {
  if (scope === "own") return stations.filter((s) => !!s.isOwn);
  if (scope === "others") return stations.filter((s) => !s.isOwn);
  return stations;
}

/**
 * 「我的站点」数据的节流刷新（由 /api/own/* 触发 = 相关页面正在使用）。
 * 自有站刷新一次会产生 5+ 个上游请求，因此默认 1 小时只允许一次；
 * 页面 30s 轮询时绝大多数调用会在这里被挡掉，不会打到生产站。
 * 设置 ownRefreshIntervalSec = 0 可关闭节流（等同每次页面请求都刷）。
 */
export async function ensureOwnFresh(rt, { force = false, now = Date.now() } = {}) {
  const raw = Number(rt.store.settings.ownRefreshIntervalSec);
  const sec = Number.isFinite(raw) ? raw : 3600;
  const last = rt._ownRefreshedAt || 0;
  if (!force && sec > 0 && now - last < sec * 1000) {
    return { refreshed: false, nextInSec: Math.ceil((sec * 1000 - (now - last)) / 1000), lastAt: last || null };
  }
  // 先占位再刷：并发请求不会重复触发（refreshStation 自身还有同站去重兜底）
  rt._ownRefreshedAt = now;
  const started = Date.now();
  await refreshAll(rt, { scope: "own" });
  return { refreshed: true, at: now, tookMs: Date.now() - started, lastAt: last || null };
}

// ---------------------------------------------------------------------------
// 后台定时刷新
// ---------------------------------------------------------------------------
export function restartPolling(rt) {
  const sec = rt.store.settings.refreshIntervalSec || 60;
  if (rt._pollTimer && sec === rt._pollSec) return; // 间隔没变（比如只改了阈值）就不重置节拍
  rt._pollSec = sec;
  if (rt._pollTimer) clearInterval(rt._pollTimer);
  rt._pollTimer = setInterval(() => {
    if (rt._pollRunning) return; // 上一轮还没结束（慢站点超时可达几十秒）就跳过本轮
    rt._pollRunning = true;
    // 定时轮询只刷「其它站点」：自有站是生产站，改由 ensureOwnFresh（相关页面在使用时）节流刷新，
    // 避免无人在看时也持续打它。手动刷新（POST /api/refresh）仍是全量。
    refreshAll(rt, { scope: "others" }).catch(() => {}).finally(() => { rt._pollRunning = false; });
  }, sec * 1000);
}
