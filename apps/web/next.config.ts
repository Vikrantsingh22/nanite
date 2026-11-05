import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets other containers (Playwright) load dev resources and HMR via http://web:3000.
  // "nanite.test" is mapped to the web container by the onboarding e2e (SIWE needs a dotted domain).
  allowedDevOrigins: ["web", "nanite.test"],
  devIndicators: false,
  // @nanite/crypto ships TypeScript source.
  transpilePackages: ["@nanite/crypto"],
};

export default nextConfig;
