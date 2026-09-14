/** @type {import('next').NextConfig} */
const nextConfig = {
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
