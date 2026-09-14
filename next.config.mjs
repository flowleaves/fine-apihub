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
  // 运行时数据（站点凭证/会话密钥/SQLite 库文件）绝不进构建产物：
  // 文件追踪会因代码引用 ./data 路径把整个目录拷进 standalone，必须显式排除
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
