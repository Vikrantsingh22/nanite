// Persistent headed Chromium for the Claude Code demos (demo/reddit): shown on the noVNC display, CDP on 127.0.0.1:9223 so
// Playwright MCP (started by headed-start.sh) drives the same window a human watches and can click in (e.g. a CAPTCHA).
import { chromium } from "@playwright/test";

const context = await chromium.launchPersistentContext("/tmp/demo-profile", {
  headless: false,
  viewport: null,
  args: [
    "--remote-debugging-port=9223",
    "--window-position=0,0",
    "--window-size=1440,900",
    "--host-resolver-rules=MAP nanite.test web",
  ],
});
console.log("headed-cdp: up");
await new Promise((resolve) => context.on("close", resolve));
process.exit(1);
