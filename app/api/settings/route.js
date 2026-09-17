// PUT /api/settings —— 更新全局设置；刷新间隔可能变化，随后重启轮询定时器
import { withAuth, json } from "../../../lib/api.js";
import { restartPolling, refreshAll } from "../../../server/refresh.js";

export const PUT = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (body?.refreshIntervalSec != null)
    patch.refreshIntervalSec = Math.max(10, Number(body.refreshIntervalSec) || 60);
  // 自有站分析刷新节流：0 = 不节流；最小 60s（再小就没意义，分析本身要 5+ 个上游请求）
  if (body?.ownRefreshIntervalSec != null) {
    const n = Number(body.ownRefreshIntervalSec);
    patch.ownRefreshIntervalSec = n === 0 ? 0 : Math.max(60, Number.isFinite(n) ? n : 3600);
  }
  if (body?.lowBalanceUsd != null)
    patch.lowBalanceUsd = Math.max(0, Number(body.lowBalanceUsd) || 0);
  if (body?.dailyReport && typeof body.dailyReport === "object")
    patch.dailyReport = body.dailyReport; // store 内部做字段校验合并
  const settings = await rt.store.updateSettings(patch);
  restartPolling(rt);
  // 立即刷新一轮：重置定时器后第一次触发要等满整个周期，不主动刷会显得设置没生效
  await refreshAll(rt, { scope: "all" });
  rt._ownRefreshedAt = Date.now(); // 刚全量刷过，重置自有站节流计时
  return json({ settings });
});
