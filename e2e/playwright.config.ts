import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://web:3000";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  fullyParallel: false,
  workers: 2,
  retries: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  projects: [
    // default project: structural checks + always-saved screenshots
    { name: "chromium", testIgnore: /baseline\.spec\.ts/ },
    // opt-in: pixel comparison. `--project=baseline` (first run: --update-snapshots)
    // Worker processes do not see the CLI args, so the decision is passed on through the environment.
    ...((process.env.E2E_BASELINE ??= process.argv.some((a) => a.includes("baseline")) ? "1" : "") === "1"
      ? [{ name: "baseline", testMatch: /baseline\.spec\.ts/ }]
      : []),
  ],
});
