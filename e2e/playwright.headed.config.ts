import { defineConfig, devices } from "@playwright/test";

// Watchable run: headed Chromium on the virtual display (started by bin/headed-server.mjs), slowed down.
// View via noVNC (see README). slowMo is set on connectOptions because several specs replace launchOptions.
// Projects chain through `dependencies` so the demo order is fixed.
const common = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, video: "off" as const, trace: "off" as const };
const step = (name: string, file: RegExp, dep?: string) => ({ name, testMatch: file, use: common, ...(dep ? { dependencies: [dep] } : {}) });

// Runtime spreads connectOptions into browserType.connect(), which honours slowMo, but the ConnectOptions type omits it.
// A non-literal (declared-type) value avoids the excess-property check without loosening the config.
const connectOptions: { wsEndpoint: string; slowMo: number } = { wsEndpoint: "ws://127.0.0.1:9222/pw", slowMo: Number(process.env.SLOWMO ?? 200) };

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results-headed",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://web:3000",
    connectOptions,
  },
  projects: [
    step("1-onboarding", /onboarding\.spec\.ts/),
    step("2-domain", /domain\.spec\.ts/, "1-onboarding"),
    step("3-agents", /agents\.spec\.ts/, "2-domain"),
    step("4-inbox", /inbox\.spec\.ts/, "3-agents"),
  ],
});
