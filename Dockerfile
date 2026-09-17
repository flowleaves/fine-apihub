# FINE-APIHUB v2（Next.js standalone + SQLite）
# ---- 构建阶段 ----------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 构建期不连库；数据库仅在运行时初始化
ENV DB_HOST=build-placeholder
RUN npx next build

# ---- 运行阶段 ----------------------------------------------------------------
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8787

# 支持 TZ 环境变量（「今日」统计边界按此时区计算）
RUN apk add --no-cache tzdata

# standalone 产物：自带裁剪后的 node_modules 与 server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 迁移脚本独立于 Next 构建图（防止真实凭证被文件追踪拷进产物），
# 启动时链式执行：库为空且配置了 V1_DATA_DIR 才导入，幂等
COPY --from=builder /app/db ./db

# ---- 安全兜底（不要删）-------------------------------------------------------
# 实测（Next.js 16.2.10）：next.config.mjs 的 outputFileTracingExcludes 拦不住 SQLite 库——
#   · Turbopack 构建（默认）无法静态解析 path.join(process.cwd(), ...)，会把**整个项目目录**
#     拷进 standalone，data/（站点凭证 / 面板密码哈希 / 会话密钥）+ spec/ + deploy/ 全在内；
#   · webpack 构建（next build --webpack）结构干净，但仍会带入 db/pool.js 里字面量拼出的
#     data/fine-apihub.db。
# 所以这里显式清除非必需目录，并断言镜像内不含任何数据库文件，否则构建直接失败。
# 运行时库由 DB_PATH（默认 /app/data/fine-apihub.db，compose 挂载到宿主机）在运行时创建。
RUN rm -rf ./data ./spec ./deploy ./.env ./.env.local
RUN set -eu; \
    found="$(find . -path ./node_modules -prune -o \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) -print)"; \
    if [ -n "$found" ]; then \
      echo "FATAL: 镜像产物含数据库文件（含站点凭证），拒绝构建：" >&2; echo "$found" >&2; exit 1; \
    fi; \
    echo "OK: 镜像内无数据库文件"

# 构建时注入 git commit，页面「关于」显示
ARG GIT_SHA=dev
ENV APP_COMMIT=$GIT_SHA

EXPOSE 8787
# 健康检查打首页（登录壳，未登录也 200）；/api/meta 需要登录会 401 导致误报 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q --spider http://127.0.0.1:8787/ || exit 1

CMD ["sh", "-c", "node db/migrate.js && exec node server.js"]
