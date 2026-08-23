// GET /mock/newapi/:acc/api/data/ —— 演示管理员看板·按模型聚合（平移自 v1 server.js）
import { json } from "../../../../../../lib/api.js";
import { mockNewApiData } from "../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiData(request);
  return json(r.body, r.status);
}
