import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets other containers (Playwright) load dev resources and HMR via http://web:3000.
  // "nanite.test" is mapped to the web container by the onboarding e2e (SIWE needs a dotted domain).
  // Dev only: Next ignores it in production builds, and it is not even set there.
  ...(process.env.NODE_ENV !== "production" ? { allowedDevOrigins: ["web", "nanite.test"] } : {}),
  devIndicators: false,
  // @nanite/crypto ships TypeScript source.
  transpilePackages: ["@nanite/crypto"],
};

export default nextConfig;
