// Opens a maximised headed Chromium on the virtual display (DISPLAY=:99) and stays open until the container stops.
// Watch/click via noVNC: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
import { chromium } from "@playwright/test";
import { injectMockWallet } from "./mock-wallet";

const START = process.env.BROWSE_URL ?? "http://nanite.test:3000";

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--start-maximized",
      "--window-position=0,0",
      "--window-size=1440,900",
      // nanite.test -> web container (SIWE needs a dotted domain); localhost:4000 (the baked-in API URL) -> api container.
      "--host-resolver-rules=MAP nanite.test web, MAP localhost api",
    ],
  });
  const context = await browser.newContext({ viewport: null });
  await injectMockWallet(context);
  const page = await context.newPage();
  await page.goto(START);
  console.log(`browse: ${START} open, mock wallet injected. Stop with: docker compose --profile headed stop browser`);
  await new Promise<void>(() => {});
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
