// ---- 「我的站点」日志精算（补上看板漏计的缓存 token 与长上下文）----------------
// 看板（/api/data/）的 token_used 只写 prompt+completion，缓存读写与倍率都不在里面，
// 于是 Claude 这类缓存占九成的模型会显示成「token 近零、消费很大」。本接口翻消费日志
// 明细把真实 token 与长上下文请求算出来，开销大，按需触发并缓存 5 分钟。
import { withAuth, json } from "../../../../lib/api.js";
import { queryOwnLogAudit } from "../../../../lib/providers.js";
import { resolveOwnWindow } from "../../../../server/own-helpers.js";

const MAX_ROWS_CAP = 20000;

export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) {
    return json({
      error: "还没有标记「我的中转站」：添加/编辑你的 New API 站点，勾选「这是我自己的中转站」（需管理员令牌）",
    }, 400);
  }
  const sp = new URL(request.url).searchParams;
  const { range, tz, now, startMs } = resolveOwnWindow(sp);
  const model = String(sp.get("model") || "").slice(0, 100);
  const username = String(sp.get("user") || "").slice(0, 100);
  const group = String(sp.get("group") || "").slice(0, 100);
  const maxRows = Math.min(MAX_ROWS_CAP, Math.max(100, Number(sp.get("maxRows")) || 4000));
  const longContextTokens = Math.max(1000, Number(sp.get("longCtx")) || 200000);

  const cache = (rt._ownAuditCache ||= new Map());
  const cacheKey = [range, tz, model, username, group, maxRows, longContextTokens].join("|");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 300000) return json(hit.payload);

  try {
    const audit = await queryOwnLogAudit(own, {
      startMs, endMs: now, model, username, group, maxRows, longContextTokens,
    });
    const payload = {
      range, tz, startMs, endMs: now,
      station: { id: own.id, name: own.name, cnyPerUsd: own.cnyPerUsd ?? null },
      filters: { model, user: username, group },
      maxRows, maxRowsCap: MAX_ROWS_CAP,
      ...audit,
      generatedAt: new Date().toISOString(),
    };
    // 缓存只留最近几组过滤条件，避免长期占内存
    if (cache.size > 12) cache.clear();
    cache.set(cacheKey, { at: Date.now(), payload });
    return json(payload);
  } catch (err) {
    return json({ error: err?.message || String(err) }, 502);
  }
});
