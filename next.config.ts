import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    prerenderEarlyExit: false,
  },
  transpilePackages: ["@base-ui/react"],
  typescript: {
    // Poller source has DOM types inside page.evaluate() callbacks that
    // confuse the Next build's type-checker even though tsx runs them fine.
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
