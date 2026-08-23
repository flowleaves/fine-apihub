// GET /mock/newapi/:acc/api/log/ —— 演示消费日志明细（供日志精算翻页）
import { json } from "../../../../../../lib/api.js";
import { mockNewApiLogs } from "../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiLogs(request);
  return json(r.body, r.status);
}
