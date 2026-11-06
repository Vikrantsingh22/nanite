import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { ROUTES, VIEWPORTS, slug, gotoOrFixme, mockAnonSession, watchProblems } from "./helpers";

const OUT = "artifacts/screenshots";
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    test(`visual ${route} @${vp.width}`, async ({ page }) => {
      await page.setViewportSize(vp);
      const problems = watchProblems(page);
      await mockAnonSession(page);
      await gotoOrFixme(page, route);

      await page.screenshot({ path: `${OUT}/${slug(route)}-${vp.width}.png`, fullPage: true });

      // viewport-only shot: full-page shots render sticky headers mid-page
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${OUT}/${slug(route)}-${vp.width}-viewport.png` });

      const m =await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      }));
      expect.soft(m.sw, `horizontal overflow: scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw + 1);
      expect.soft(problems, `console/page/network problems:\n${problems.join("\n")}`).toEqual([]);
    });
  }
}
