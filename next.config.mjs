/** @type {import('next').NextConfig} */
const nextConfig = {
  // 显式声明项目根：家目录里也有 package-lock.json，Next 向上查找会误判 workspace root，
  // 进而影响 outputFileTracingExcludes 的相对路径基准。锁死为项目目录。
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // 开发期允许的跨源来源：Next 16 默认阻止非 localhost 的 dev 资源请求，
  // 经局域网 IP 访问时 /_next/webpack-hmr 的 WebSocket 会被拒（控制台刷满 ws 报错）。
  // 仅影响 dev，不影响生产构建。换网络后把新的局域网 IP 追加进来即可。
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.31.168"],
  // Docker 部署用 standalone 产物（node server.js 单进程，含后台刷新循环）
  output: "standalone",
  // 原生/CJS 服务端依赖不打包进 serverless bundle；Cap 的 WASM 文件需保留原始目录结构。
  // 注：SQLite 走 Node 内置的 node:sqlite，无需在此登记。
  serverExternalPackages: ["@cap.js/wasm"],
  // 运行时数据（站点凭证 / 会话密钥 / SQLite 库文件）绝不进构建产物。
  // ⚠️ 实测（Next 16.2.10）：下面的 excludes **并未生效**，两种构建路径都漏——
  //   · Turbopack（默认）：无法静态解析 path.join(process.cwd(), ...)，会把整个项目目录拷进
  //     standalone（data/、spec/、deploy/、*.md 全在内）；
  //   · webpack（next build --webpack）：结构干净，但仍会带入 db/pool.js 里字面量拼出的
  //     data/fine-apihub.db。
  // 保留本配置以防上游版本修好该行为，但**真正的兜底**是另外两处：
  //   1) `npm run build` 末尾的 tools/check-standalone.mjs（发现即删 + 告警；--strict 时失败）
  //   2) Dockerfile 运行阶段的 rm + 「镜像内不得有 *.db」断言
  // 改动其中任何一处后，请重跑 `npm run build` 并确认 .next/standalone 内无 *.db。
  outputFileTracingExcludes: { "*": ["./data/**", "data/**", "*.db", "*.db-wal", "*.db-shm"] },
  // antd/pro-components ESM 转译
  transpilePackages: [
    "antd",
    "@ant-design/pro-components",
    "@ant-design/pro-layout",
    "@ant-design/pro-table",
    "@ant-design/pro-form",
    "@ant-design/pro-card",
    "@ant-design/icons",
    "@ant-design/plots",
    "rc-util",
    "rc-pagination",
    "rc-picker",
  ],

  // 安全响应头：全局 + API 专用
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
