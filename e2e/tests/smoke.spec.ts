import { test, expect } from "@playwright/test";
import { gotoOrFixme } from "./helpers";

const API_URL = process.env.API_URL ?? "http://api:4000";

test("API GET /health is ok and db up", async ({ request }) => {
  const res = await request.get(`${API_URL}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.db).toBe("up");
});

test("/styleguide has an h1 and section landmarks", async ({ page }) => {
  await gotoOrFixme(page, "/styleguide");
  await expect(page.locator("h1").first()).toBeVisible();
  const sections = await page.locator("section, [role=region], main").count();
  expect(sections, "expected <section>/<main> landmarks").toBeGreaterThan(1);
});

test("/styleguide loads at scrollY 0 (no auto-scroll on mount)", async ({ page }) => {
  await gotoOrFixme(page, "/styleguide");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY), "page auto-scrolled on mount").toBe(0);
});

test("/styleguide#patterns puts the #patterns heading in view below the sticky header", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOrFixme(page, "/styleguide#patterns");
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const el = document.getElementById("patterns");
    if (!el) return null;
    const heading = (el.matches("h1,h2,h3") ? el : el.querySelector("h1,h2,h3") ?? el) as HTMLElement;
    const top = heading.getBoundingClientRect().top;
    const bottom = heading.getBoundingClientRect().bottom;
    let headerBottom = 0;
    for (const h of Array.from(document.querySelectorAll("header, [data-sticky], nav"))) {
      const s = getComputedStyle(h);
      if (s.position === "sticky" || s.position === "fixed") headerBottom = Math.max(headerBottom, h.getBoundingClientRect().bottom);
    }
    return { top, bottom, headerBottom, vh: window.innerHeight };
  });
  expect(r, "no element with id=patterns").not.toBeNull();
  expect(r!.top, `heading top ${r!.top} is hidden under sticky header (bottom ${r!.headerBottom})`).toBeGreaterThanOrEqual(r!.headerBottom - 1);
  expect(r!.bottom, "heading below the fold").toBeLessThanOrEqual(r!.vh);
});

for (const route of ["/", "/styleguide"]) {
  test(`keyboard Tab shows a visible focus ring on ${route}`, async ({ page }) => {
    await gotoOrFixme(page, route);
    const focusable = await page.locator("a[href], button, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])").count();
    test.fixme(focusable === 0, `No focusable elements on ${route} yet (placeholder page): cannot check focus ring.`);
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName,
        outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
        shadow: s.boxShadow !== "none",
        focusVisible: el.matches(":focus-visible"),
      };
    });
    expect(info, "Tab did not move focus to any element").not.toBeNull();
    expect(info!.focusVisible, "focused element not :focus-visible").toBe(true);
    expect(info!.outline || info!.shadow, `no outline/box-shadow focus ring on <${info!.tag}>`).toBe(true);
  });
}
