// apps/web/next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_NODE_ENV: process.env.NODE_ENV,
  },
  typedRoutes: true,
  output: 'standalone',
  transpilePackages: ["@vault/types"],

  async rewrites() {
    const apiBase = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
      {
        source: "/health/:path*",
        destination: `${apiBase}/health/:path*`,
      },
    ];
  },
};

export default nextConfig;
