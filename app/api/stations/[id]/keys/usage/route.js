import { withAuth, json } from "../../../../../../lib/api.js";
import { querySub2ApiKeyUsage } from "../../../../../../lib/providers.js";

export const GET = withAuth(async (request, rt, params) => {
  const station = rt.store.get(params.id);
  if (!station) return json({ error: "未找到该中转站" }, 404);
  if (!["sub2api", "sub2api-password"].includes(station.type)) return json({ error: "仅支持 Sub2API 站点" }, 400);
  const sp = new URL(request.url).searchParams;
  const range = ["today", "24h", "7d", "30d"].includes(sp.get("range")) ? sp.get("range") : "today";
  const now = Date.now();
  const startMs = range === "24h" ? now - 86400000 : now - ({ today: 1, "7d": 7, "30d": 30 }[range] || 1) * 86400000;
  try {
    const payload = await querySub2ApiKeyUsage(station, { startMs, endMs: now });
    return json({ station: { id: station.id, name: station.name }, requestedRange: range, startMs, endMs: now, ...payload, generatedAt: new Date().toISOString() });
  } catch (err) {
    return json({ error: err?.message || String(err) }, /管理员权限/.test(err?.message || "") ? 403 : 502);
  }
});
