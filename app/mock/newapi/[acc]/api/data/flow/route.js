// GET /mock/newapi/:acc/api/data/flow —— 演示管理员看板·按 (用户,分组,模型,渠道) 聚合
import { json } from "../../../../../../../lib/api.js";
import { mockNewApiDataFlow } from "../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiDataFlow(request);
  return json(r.body, r.status);
}
