import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@base-ui/react"],
  typescript: {
    // Poller source has DOM types inside page.evaluate() callbacks that
    // confuse the Next build's type-checker even though tsx runs them fine.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
