// POST /api/refresh —— 手动全量刷新所有站点（不受自有站节流限制），返回脱敏后的站点列表
import { withAuth, json } from "../../../lib/api.js";
import { refreshAll } from "../../../server/refresh.js";
import { redact } from "../../../server/stations.js";

export const POST = withAuth(async (request, rt) => {
  // scope=all：手动刷新是用户显式动作，跳过 ownRefreshIntervalSec 节流；
  // 同时把节流计时重置，避免刚手动刷完又被页面触发一次
  await refreshAll(rt, { scope: "all" });
  rt._ownRefreshedAt = Date.now();
  return json({
    stations: rt.store.list().map((s) => redact(rt, s)),
    refreshedAt: new Date().toISOString(),
  });
});
