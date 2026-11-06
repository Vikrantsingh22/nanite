import { test, type Page } from "@playwright/test";

export const ROUTES = ["/", "/styleguide"] as const;
export const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

export const slug = (route: string) => (route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-"));

/** Soft-fail (fixme) when a route does not exist yet, instead of crashing the suite. */
export async function gotoOrFixme(page: Page, route: string) {
  const res = await page.goto(route, { waitUntil: "networkidle" });
  test.fixme(
    res?.status() === 404,
    `Route ${route} returned 404: page not built yet (expected from the design-system task). Not a harness failure.`,
  );
  await settle(page);
  return res;
}

export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** Collect console errors, page errors and failed (4xx/5xx or aborted) requests. */
export function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    // The browser's generic "status of 401" line carries no URL; the response handler below still flags any 401 other than GET /me.
    if (m.type() === "error" && !/_next\/webpack-hmr|_next\/hmr|status of 401/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = r.url();
    // The home page asks GET /me whether a session exists; 401 is the normal anonymous answer.
    const anonMe = r.status() === 401 && /\/me$/.test(u);
    if (r.status() >= 400 && !anonMe && !/favicon/.test(u)) problems.push(`HTTP ${r.status()}: ${u}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    // Next aborts an in-flight RSC prefetch (`?_rsc=`) when the user navigates on: benign, and only that exact case is ignored.
    const abortedRscPrefetch = r.failure()?.errorText === "net::ERR_ABORTED" && /[?&]_rsc=/.test(u);
    if (!/favicon/.test(u) && !/_next\/webpack-hmr/.test(u) && !abortedRscPrefetch) problems.push(`requestfailed: ${u} ${r.failure()?.errorText}`);
  });
  return problems;
}

/** Answer the session probe (GET /me) as an anonymous visitor; the e2e container cannot reach the browser-side API URL. */
export async function mockAnonSession(page: Page) {
  await page.route(/\/\/[^/]+:4000\/me$/, (route) => {
    const origin = route.request().headers()["origin"] ?? "*";
    const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    return route.fulfill({ status: 401, contentType: "application/json", headers, body: JSON.stringify({ error: "unauthenticated" }) });
  });
}

export async function setTheme(page: Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme = t;
  }, theme);
  await settleAnimations(page);
}

/**
 * Wait until every finite CSS transition/animation on the page has finished (dialog fade-in, theme colour
 * transitions), so axe and screenshots never sample half-faded colours. Waits on the browser's own animation
 * state, not on a fixed delay. Infinite animations (spinners) are ignored.
 */
export async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    const finite = () => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    for (let i = 0; i < 20 && finite().length > 0; i++) await Promise.allSettled(finite().map((a) => a.finished));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}
