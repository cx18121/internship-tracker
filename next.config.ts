import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@base-ui/react"],
  // Default is true, but Next.js 16 has been inconsistent about applying it
  // to dynamic API routes. Setting explicitly so prod always gzips the big
  // /api/internships payload (~2.1MB raw → ~410KB gzip) without needing a
  // reverse-proxy or per-route plumbing.
  compress: true,
};

export default nextConfig;
