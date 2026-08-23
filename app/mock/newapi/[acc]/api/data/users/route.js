// GET /mock/newapi/:acc/api/data/users —— 演示管理员看板·按用户聚合（平移自 v1 server.js）
import { json } from "../../../../../../../lib/api.js";
import { mockNewApiDataUsers } from "../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiDataUsers(request);
  return json(r.body, r.status);
}
