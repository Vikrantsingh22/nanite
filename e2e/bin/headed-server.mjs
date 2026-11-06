// Headed Chromium server on the virtual display. The headed config connects to it with slowMo, which
// (unlike launchOptions) is not overridden by the specs' own test.use({ launchOptions }).
import { chromium } from "@playwright/test";

const server = await chromium.launchServer({
  headless: false,
  host: "127.0.0.1",
  port: 9222,
  wsPath: "pw",
  args: ["--window-position=0,0", "--window-size=1440,900", "--host-resolver-rules=MAP nanite.test web"],
});
console.log("headed-server:", server.wsEndpoint());
